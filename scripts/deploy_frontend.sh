#!/bin/bash
set -e

APP_ID="d2yzro7vt1tbwp"
BRANCH_NAME="main"

echo "Building frontend..."
cd frontend
npm install
npm run build

echo "Zipping build..."
cd dist
zip -r ../deploy.zip .
cd ..

echo "Creating deployment in AWS Amplify..."
aws amplify create-deployment --app-id $APP_ID --branch-name $BRANCH_NAME > deployment.json

JOB_ID=$(python3 -c "import json; print(json.load(open('deployment.json'))['jobId'])")
UPLOAD_URL=$(python3 -c "import json; print(json.load(open('deployment.json'))['zipUploadUrl'])")

echo "Uploading ZIP to S3 presigned URL..."
curl -s --upload-file deploy.zip "$UPLOAD_URL"

echo "Starting deployment (Job ID: $JOB_ID)..."
aws amplify start-deployment --app-id $APP_ID --branch-name $BRANCH_NAME --job-id $JOB_ID

echo "Cleaning up..."
rm deployment.json deploy.zip

echo "Frontend deployment triggered successfully! ✅"
echo "You can monitor the build status in the AWS Amplify Console."
