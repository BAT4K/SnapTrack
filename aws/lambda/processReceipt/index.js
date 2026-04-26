const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { DynamoDBClient, PutItemCommand, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { AzureKeyCredential, DocumentAnalysisClient } = require("@azure/ai-form-recognizer");

const s3 = new S3Client();
const ssm = new SSMClient();
const dynamodb = new DynamoDBClient();

let geminiApiKey = null;
let azureEndpoint = null;
let azureApiKey = null;

async function fallbackToGroq(extractedText) {
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) throw new Error("GROQ_API_KEY not set in environment");

    const systemPrompt = `You are a JSON-only data extraction API. Analyze the receipt text and return a JSON object with exactly three keys:

"calories" (an integer representing the total calories. If the exact calories are not explicitly stated in the text, you must estimate the total based on the food items listed).

"macros" (an object with three integer keys: "protein", "carbs", and "fats", each representing estimated grams. If the exact macros are not explicitly stated, you must intelligently estimate them based on the food items listed).

"items" (an array of short strings representing the names of the food items ordered).
Return ONLY valid JSON. Do not include markdown formatting.`;
    const userPrompt = `Extracted Text:\n${extractedText}`;

    console.log("Calling Groq Fallback...");
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${groqApiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ]
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[GROQ API ERROR] Status ${response.status}:`, errorText);
        throw new Error(`Groq API failed: ${errorText}`);
    }

    const data = await response.json();
    const groqText = data.choices[0].message.content;
    console.log("Groq raw response:", groqText);

    let cleanJson = groqText.replace(/```json/gi, "").replace(/```/g, "").trim();
    return JSON.parse(cleanJson);
}

async function sendTelegramAlert(message) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) {
        console.warn("[TELEGRAM] Bot token or chat ID not configured, skipping alert.");
        return;
    }

    try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: "HTML"
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[TELEGRAM ERROR] Status ${response.status}:`, errorText);
        } else {
            console.log("[TELEGRAM] Alert sent successfully.");
        }
    } catch (err) {
        console.error("[TELEGRAM ERROR] Failed to send alert (non-blocking):", err.message);
    }
}

async function getParameters() {
    if (!geminiApiKey) {
        if (process.env.GEMINI_API_KEY) {
            geminiApiKey = process.env.GEMINI_API_KEY;
        } else {
            const res = await ssm.send(new GetParameterCommand({ Name: "/snaptrack/gemini_api_key", WithDecryption: true }));
            geminiApiKey = res.Parameter.Value;
        }
    }
    if (!azureEndpoint) {
        const res = await ssm.send(new GetParameterCommand({ Name: "/snaptrack/azure_endpoint", WithDecryption: true }));
        azureEndpoint = res.Parameter.Value;
    }
    if (!azureApiKey) {
        const res = await ssm.send(new GetParameterCommand({ Name: "/snaptrack/azure_api_key", WithDecryption: true }));
        azureApiKey = res.Parameter.Value;
    }
    return { geminiApiKey, azureEndpoint, azureApiKey };
}

exports.handler = async (event) => {
    console.log("Received S3 Event:", JSON.stringify(event, null, 2));

    let params;
    try {
        params = await getParameters();
    } catch (err) {
        console.error("[AWS SSM ERROR] Failed to retrieve parameters:", err);
        throw err;
    }

    const { geminiApiKey, azureEndpoint, azureApiKey } = params;

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const azureClient = new DocumentAnalysisClient(azureEndpoint, new AzureKeyCredential(azureApiKey));

    for (const record of event.Records) {
        const bucket = record.s3.bucket.name;
        const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
        
        console.log(`Processing file: ${key} from bucket: ${bucket}`);

        if (!key.toLowerCase().endsWith('.jpg')) {
            console.log(`Skipping non-jpg file: ${key}`);
            continue;
        }

        let imageBuffer;
        try {
            const s3Response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            const streamToBuffer = (stream) => new Promise((resolve, reject) => {
                const chunks = [];
                stream.on("data", (chunk) => chunks.push(chunk));
                stream.on("error", reject);
                stream.on("end", () => resolve(Buffer.concat(chunks)));
            });
            imageBuffer = await streamToBuffer(s3Response.Body);
        } catch (err) {
            console.error("[AWS S3 ERROR] Failed to download image:", err);
            throw err;
        }

        let azureText = "";
        try {
            console.log("Calling Azure DocumentAnalysisClient...");
            const poller = await azureClient.beginAnalyzeDocument("prebuilt-receipt", imageBuffer);
            const { content } = await poller.pollUntilDone();
            azureText = content;
            console.log("Azure extracted text length:", azureText.length);
        } catch (err) {
            console.error("[AZURE AI ERROR] Failed to process document:", err);
            throw err;
        }

        let parsedData;
        const prompt = `Here is the raw OCR text of a food receipt extracted by Azure: ${azureText}. Identify the food items, estimate the total calories, and estimate the macronutrient breakdown (protein, carbs, fats in grams). If exact values are not stated, intelligently estimate them based on the food items. Return ONLY a valid JSON object in this exact format: { "items": ["Item 1", "Item 2"], "totalCalories": 500, "macros": { "protein": 30, "carbs": 60, "fats": 20 } }.`;
        
        try {
            console.log("Calling Google Gemini API...");
            const result = await model.generateContent(prompt);
            const responseText = result.response.text();
            console.log("Gemini raw response:", responseText);

            let cleanJson = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();
            parsedData = JSON.parse(cleanJson);
        } catch (err) {
            console.warn("[GOOGLE GEMINI ERROR] Gemini failed, attempting Groq fallback:", err.message);
            try {
                const groqResult = await fallbackToGroq(azureText);
                parsedData = {
                    items: groqResult.items || ["Unknown items"],
                    totalCalories: groqResult.calories || 0,
                    macros: groqResult.macros || { protein: 0, carbs: 0, fats: 0 }
                };
            } catch (fallbackErr) {
                console.error("[MULTI-MODEL ERROR] Both Gemini and Groq failed.");
                console.error("Groq Error:", fallbackErr.message);
                throw new Error("Fatal: All AI models failed to process the receipt.");
            }
        }

        // Safety check: ensure macros exist with safe defaults
        const safeMacros = {
            protein: (parsedData.macros && parsedData.macros.protein) || 0,
            carbs: (parsedData.macros && parsedData.macros.carbs) || 0,
            fats: (parsedData.macros && parsedData.macros.fats) || 0
        };

        try {
            const timestamp = new Date().toISOString();
            const receiptId = key;
            let userId = "anonymous";
            if (key.startsWith('uploads/')) {
                userId = key.split('/')[1];
            }

            console.log(`Saving results to AWS DynamoDB for receiptId: ${receiptId}, userId: ${userId}`);
            await dynamodb.send(new PutItemCommand({
                TableName: "SnapTrackMeals",
                Item: {
                    receiptId: { S: receiptId },
                    userId: { S: userId },
                    items: { L: parsedData.items.map(item => ({ S: item })) },
                    totalCalories: { N: (parsedData.totalCalories || 0).toString() },
                    macros: { M: {
                        protein: { N: safeMacros.protein.toString() },
                        carbs: { N: safeMacros.carbs.toString() },
                        fats: { N: safeMacros.fats.toString() }
                    }},
                    processedAt: { S: timestamp }
                }
            }));
            console.log(`Successfully processed and saved ${key}`);

            // Daily calorie check & Telegram push notification
            try {
                const todayPrefix = new Date().toISOString().split('T')[0];
                const scanResult = await dynamodb.send(new ScanCommand({
                    TableName: "SnapTrackMeals",
                    FilterExpression: "userId = :uid AND begins_with(processedAt, :today)",
                    ExpressionAttributeValues: {
                        ":uid": { S: userId },
                        ":today": { S: todayPrefix }
                    },
                    ProjectionExpression: "totalCalories"
                }));

                const dailyTotal = (scanResult.Items || []).reduce((sum, item) => {
                    return sum + (parseInt(item.totalCalories?.N || "0", 10));
                }, 0);

                const DAILY_TARGET = 2200;
                if (dailyTotal > DAILY_TARGET) {
                    const overage = dailyTotal - DAILY_TARGET;
                    await sendTelegramAlert(
                        `🚨 <b>SNAPTRACK ALERT</b>\n\nYou just hit <b>${dailyTotal}</b> kcal today.\nYou are <b>${overage} kcal over</b> your ${DAILY_TARGET} kcal target.`
                    );
                }
            } catch (alertErr) {
                console.error("[TELEGRAM CHECK ERROR] Non-blocking failure:", alertErr.message);
            }
        } catch (err) {
            console.error("[AWS DYNAMODB ERROR] Failed to save item:", err);
            throw err;
        }
    }
};
