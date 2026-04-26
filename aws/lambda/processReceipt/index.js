const { SFNClient, StartSyncExecutionCommand } = require("@aws-sdk/client-sfn");
const AWSXRay = require("aws-xray-sdk-core");

const sfn = AWSXRay.captureAWSv3Client(new SFNClient({}));

exports.handler = async (event) => {
    console.log("Received API Gateway Event:", JSON.stringify(event, null, 2));

    try {
        const stateMachineArn = process.env.STATE_MACHINE_ARN;
        if (!stateMachineArn) {
            throw new Error("STATE_MACHINE_ARN environment variable is not set.");
        }

        // Parse API Gateway body
        let body = {};
        if (event.body) {
            body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        }

        const bucket = body.bucket;
        let key = body.key;

        if (!bucket || !key) {
            return {
                statusCode: 400,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                },
                body: JSON.stringify({ message: "Missing bucket or key in request body." })
            };
        }

        // Sanitize the key
        key = key.trim();

        // Extract userId if available (e.g. from Cognito claims) or derive from key
        let userId = "anonymous";
        if (event.requestContext?.authorizer?.claims?.sub) {
            userId = event.requestContext.authorizer.claims.sub;
        } else if (key.startsWith('uploads/')) {
            userId = key.split('/')[1];
        }

        const inputPayload = {
            bucket,
            key,
            userId
        };

        console.log("Starting Sync Execution with payload:", inputPayload);

        const command = new StartSyncExecutionCommand({
            stateMachineArn,
            input: JSON.stringify(inputPayload)
        });

        const response = await sfn.send(command);

        console.log("Step Function Execution Response:", response);

        if (response.status !== "SUCCEEDED") {
            console.error("Step Function failed:", response.error, response.cause);
            return {
                statusCode: 500,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"
                },
                body: JSON.stringify({ 
                    message: "Receipt processing failed.",
                    error: response.error,
                    cause: response.cause
                })
            };
        }

        // Parse the output from the Step Function
        const output = JSON.parse(response.output);

        // Return exactly as React app expects (HTTP 200 JSON format)
        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify(output)
        };

    } catch (err) {
        console.error("Error proxying to Step Function:", err);
        return {
            statusCode: 500,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({ message: err.message })
        };
    }
};
