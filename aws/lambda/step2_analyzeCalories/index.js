const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { AzureKeyCredential, DocumentAnalysisClient } = require("@azure/ai-form-recognizer");
const AWSXRay = require("aws-xray-sdk-core");

const ssm = new SSMClient();

let geminiApiKey = null;
let azureEndpoint = null;
let azureApiKey = null;

exports.handler = async (event) => {
    console.log("Step 2: Analyze Calories triggered", JSON.stringify(event));
    
    const { bucket, key, imageUrl } = event;
    if (!imageUrl) throw new Error("Missing imageUrl from Step 1");

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

    console.log("Downloading image buffer from signed URL...");
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) throw new Error("Failed to download image from S3 signed URL");
    const arrayBuffer = await imageResponse.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    console.log("Calling Azure DocumentAnalysisClient...");
    const azureClient = new DocumentAnalysisClient(azureEndpoint, new AzureKeyCredential(azureApiKey));
    const poller = await azureClient.beginAnalyzeDocument("prebuilt-receipt", imageBuffer);
    const { content } = await poller.pollUntilDone();
    const azureText = content;

    let parsedData;
    const prompt = `Here is the raw OCR text of a food receipt extracted by Azure: ${azureText}. Identify the food items, estimate the total calories, and estimate the macronutrient breakdown (protein, carbs, fats in grams). If exact values are not stated, intelligently estimate them based on the food items. Return ONLY a valid JSON object in this exact format: { "items": ["Item 1", "Item 2"], "totalCalories": 500, "macros": { "protein": 30, "carbs": 60, "fats": 20 } }.`;
    
    try {
        console.log("Calling Google Gemini API...");
        const genAI = new GoogleGenerativeAI(geminiApiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        let cleanJson = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();
        parsedData = JSON.parse(cleanJson);
    } catch (err) {
        console.warn("[GOOGLE GEMINI ERROR] Gemini failed:", err.message);
        throw new Error("GeminiAPIError: " + err.message);
    }

    return { bucket, key, parsedData };
};
