const { DynamoDBClient, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const dynamodb = new DynamoDBClient();
const s3 = new S3Client();

exports.handler = async (event) => {
    console.log("Received DELETE request:", JSON.stringify(event, null, 2));

    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (event.requestContext && event.requestContext.http && event.requestContext.http.method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders, body: "" };
    }

    try {
        // Extract userId from Cognito JWT
        let userId = "anonymous";
        if (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.jwt) {
            userId = event.requestContext.authorizer.jwt.claims.sub;
        } else {
            return {
                statusCode: 401,
                headers: corsHeaders,
                body: JSON.stringify({ message: "Unauthorized" })
            };
        }

        // Parse receiptId from request body
        const body = JSON.parse(event.body || "{}");
        const { receiptId } = body;

        if (!receiptId) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ message: "Missing receiptId in request body" })
            };
        }

        // Security: verify the receiptId belongs to this user
        if (!receiptId.includes(userId)) {
            return {
                statusCode: 403,
                headers: corsHeaders,
                body: JSON.stringify({ message: "Forbidden: receiptId does not belong to this user" })
            };
        }

        const bucketName = process.env.BUCKET_NAME;

        // Step 1: Delete from DynamoDB
        console.log(`Deleting DynamoDB record: ${receiptId}`);
        try {
            await dynamodb.send(new DeleteItemCommand({
                TableName: "SnapTrackMeals",
                Key: {
                    receiptId: { S: receiptId }
                }
            }));
            console.log("DynamoDB record deleted.");
        } catch (err) {
            console.error("[AWS DYNAMODB ERROR] Failed to delete item:", err);
            throw err;
        }

        // Step 2: Delete from S3
        console.log(`Deleting S3 object: ${receiptId} from bucket: ${bucketName}`);
        try {
            await s3.send(new DeleteObjectCommand({
                Bucket: bucketName,
                Key: receiptId
            }));
            console.log("S3 object deleted.");
        } catch (err) {
            console.error("[AWS S3 ERROR] Failed to delete object:", err);
            throw err;
        }

        return {
            statusCode: 200,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ message: "Record permanently destroyed", receiptId })
        };

    } catch (error) {
        console.error("Error in deleteMeal handler:", error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ message: "Internal server error", error: error.message })
        };
    }
};
