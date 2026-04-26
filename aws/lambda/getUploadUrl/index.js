const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client();

exports.handler = async (event) => {
    console.log("Received getUploadUrl request:", JSON.stringify(event, null, 2));

    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS, GET",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (event.requestContext && event.requestContext.http && event.requestContext.http.method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders, body: "" };
    }

    try {
        const bucketName = process.env.BUCKET_NAME;
        if (!bucketName) throw new Error("BUCKET_NAME not set");

        let userId = "anonymous";
        if (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.jwt) {
            userId = event.requestContext.authorizer.jwt.claims.sub;
        } else {
            return {
                statusCode: 401,
                headers: corsHeaders,
                body: JSON.stringify({ message: "Unauthorized: Missing valid JWT token" })
            };
        }

        const key = `uploads/${userId}/web-${Date.now()}.jpg`;

        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            ContentType: "image/jpeg"
        });

        const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

        return {
            statusCode: 200,
            headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                uploadUrl: uploadUrl,
                key: key
            })
        };

    } catch (error) {
        console.error("Error generating presigned URL:", error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ message: "Internal server error", error: error.message })
        };
    }
};
