const { DynamoDBClient, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

const dynamodb = new DynamoDBClient();

exports.handler = async (event) => {
    console.log("Received GET request:", JSON.stringify(event, null, 2));

    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS, GET",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    // If it's a preflight OPTIONS request, return early
    if (event.requestContext && event.requestContext.http && event.requestContext.http.method === "OPTIONS") {
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: ""
        };
    }

    try {
        let userId = "anonymous";
        if (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.jwt) {
            userId = event.requestContext.authorizer.jwt.claims.sub;
        }

        const data = await dynamodb.send(new ScanCommand({
            TableName: "SnapTrackMeals",
            FilterExpression: "userId = :uid",
            ExpressionAttributeValues: {
                ":uid": { S: userId }
            }
        }));

        let meals = [];
        if (data.Items) {
            meals = data.Items.map(item => unmarshall(item));
        }

        // Sort by processedAt descending (newest first)
        meals.sort((a, b) => {
            const timeA = new Date(a.processedAt || 0).getTime();
            const timeB = new Date(b.processedAt || 0).getTime();
            return timeB - timeA;
        });

        return {
            statusCode: 200,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(meals)
        };
    } catch (error) {
        console.error("Error retrieving meals:", error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ message: "Internal server error retrieving meals", error: error.message })
        };
    }
};
