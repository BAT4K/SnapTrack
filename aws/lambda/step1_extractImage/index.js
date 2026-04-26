const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const AWSXRay = require("aws-xray-sdk-core");

const s3 = AWSXRay.captureAWSv3Client(new S3Client({}));

exports.handler = async (event) => {
    console.log("Step 1: Extract Image triggered", JSON.stringify(event));

    // Handle S3 Event structure
    let bucket, key;
    if (event.Records && event.Records.length > 0) {
        bucket = event.Records[0].s3.bucket.name;
        key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
    } else if (event.detail && event.detail.bucket) {
        // EventBridge S3 event
        bucket = event.detail.bucket.name;
        key = decodeURIComponent(event.detail.object.key.replace(/\+/g, " "));
    } else {
        bucket = event.bucket;
        key = event.key;
    }

    if (!key || !bucket) {
        throw new Error("Missing bucket or key in event");
    }

    if (!key.toLowerCase().endsWith('.jpg')) {
        throw new Error(`Skipping non-jpg file: ${key}`);
    }

    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const url = await getSignedUrl(s3, command, { expiresIn: 900 });

    return {
        bucket,
        key,
        imageUrl: url
    };
};
