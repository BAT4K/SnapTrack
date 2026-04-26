const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client();

exports.handler = async (event) => {
    try {
        const bucketName = process.env.BUCKET_NAME;
        if (!bucketName) {
            throw new Error("BUCKET_NAME environment variable is not set");
        }

        if (!event.body) {
            return {
                statusCode: 400,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: "No body in request" })
            };
        }

        let imageBase64 = event.body;
        
        if (event.isBase64Encoded) {
            // Body is raw base64 string or base64 JSON string
            try {
                // In case it's base64 encoded JSON
                const decodedBody = Buffer.from(event.body, 'base64').toString('utf8');
                const parsed = JSON.parse(decodedBody);
                if (parsed.image) imageBase64 = parsed.image;
            } catch (e) {
                // Ignore parse error, treat as raw base64
            }
        } else {
            // Expected JSON payload
            try {
                const parsed = JSON.parse(event.body);
                if (parsed.image) {
                    imageBase64 = parsed.image;
                } else {
                    return {
                        statusCode: 400,
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ message: "Invalid payload format. Expected JSON with 'image' field." })
                    };
                }
            } catch (e) {
                // Ignore parse error, maybe the body itself is raw base64 (though not marked as isBase64Encoded)
            }
        }

        // Remove data URI scheme prefix if present (e.g. data:image/jpeg;base64,)
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
        
        const buffer = Buffer.from(base64Data, 'base64');
        
        let userId = "anonymous";
        if (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.jwt) {
            userId = event.requestContext.authorizer.jwt.claims.sub;
        }

        const timestamp = Math.floor(Date.now() / 1000);
        // Using timestamp and a random string for uniqueness
        const uniqueSuffix = Math.random().toString(36).substring(2, 8);
        const fileName = `uploads/${userId}/receipt-${timestamp}-${uniqueSuffix}.jpg`;

        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: fileName,
            Body: buffer,
            ContentType: 'image/jpeg'
        });

        await s3.send(command);

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                message: "Image uploaded successfully",
                fileName: fileName
            })
        };
    } catch (error) {
        console.error("Error uploading image:", error);
        return {
            statusCode: 500,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Internal server error", error: error.message })
        };
    }
};
