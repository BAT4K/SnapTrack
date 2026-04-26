const { DynamoDBClient, PutItemCommand, ScanCommand } = require("@aws-sdk/client-dynamodb");
const AWSXRay = require("aws-xray-sdk-core");

const dynamodb = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));

async function sendTelegramAlert(message) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;

    try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" })
        });
    } catch (err) {
        console.error("Telegram error:", err.message);
    }
}

exports.handler = async (event) => {
    console.log("Step 3: Save to Database triggered", JSON.stringify(event));

    const { bucket, key, parsedData } = event;
    if (!key || !parsedData) throw new Error("Missing key or parsedData from Step 2");

    const safeMacros = {
        protein: (parsedData.macros && parsedData.macros.protein) || 0,
        carbs: (parsedData.macros && parsedData.macros.carbs) || 0,
        fats: (parsedData.macros && parsedData.macros.fats) || 0
    };

    const timestamp = new Date().toISOString();
    const receiptId = key;
    let userId = "anonymous";
    if (key.startsWith('uploads/')) {
        userId = key.split('/')[1];
    }

    console.log(`Saving to DynamoDB: ${receiptId}`);
    await dynamodb.send(new PutItemCommand({
        TableName: "SnapTrackMeals",
        Item: {
            receiptId: { S: receiptId },
            userId: { S: userId },
            items: { L: (parsedData.items || []).map(item => ({ S: item })) },
            totalCalories: { N: (parsedData.totalCalories || 0).toString() },
            macros: { M: {
                protein: { N: safeMacros.protein.toString() },
                carbs: { N: safeMacros.carbs.toString() },
                fats: { N: safeMacros.fats.toString() }
            }},
            processedAt: { S: timestamp }
        }
    }));

    // Daily total check
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

        const currentMealCalories = parseInt(parsedData.totalCalories || 0, 10);
        const previousDailyTotal = dailyTotal - currentMealCalories;
        const DAILY_TARGET = 2200;

        // Edge Trigger: Only fire exactly when crossing the threshold
        if (previousDailyTotal <= DAILY_TARGET && dailyTotal > DAILY_TARGET) {
            const overage = dailyTotal - DAILY_TARGET;
            await sendTelegramAlert(
                `🚨 <b>SNAPTRACK ALERT</b>\n\nYou just hit <b>${dailyTotal}</b> kcal today.\nYou are <b>${overage} kcal over</b> your ${DAILY_TARGET} kcal target.`
            );
        }
    } catch (err) {
        console.error("Failed daily check:", err.message);
    }

    return {
        receiptId,
        userId,
        items: parsedData.items || [],
        totalCalories: parsedData.totalCalories || 0,
        macros: safeMacros,
        processedAt: timestamp
    };
};
