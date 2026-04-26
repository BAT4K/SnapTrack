#!/bin/bash
set -e

# Default region
REGION="us-east-1"
export AWS_DEFAULT_REGION=$REGION

echo "Starting deployment of Phase 1: AWS Ingestion Pipeline..."

# a) Generate a unique S3 bucket name
RAND_SUFFIX=$(LC_ALL=C tr -dc a-z0-9 </dev/urandom | head -c 8)
BUCKET_NAME="snaptrack-raw-receipts-$RANDOM-$RAND_SUFFIX"

echo "Creating S3 bucket: $BUCKET_NAME in $REGION..."
aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --region "$REGION" > /dev/null

# Wait briefly for bucket to propagate
sleep 5

# b) Block all public access to the bucket
echo "Applying Public Access Block to $BUCKET_NAME..."
aws s3api put-public-access-block \
    --bucket "$BUCKET_NAME" \
    --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" > /dev/null

# c) Create IAM Role
ROLE_NAME="SnapTrackIngestionRole-$RANDOM"
echo "Creating IAM Role: $ROLE_NAME..."

TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
)

aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" > /dev/null

echo "Attaching basic Lambda execution policy..."
aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" > /dev/null

echo "Creating inline S3 PutObject policy for bucket $BUCKET_NAME..."
POLICY_NAME="SnapTrackS3PutPolicy"
S3_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::$BUCKET_NAME/*"
    }
  ]
}
EOF
)

aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "$POLICY_NAME" \
    --policy-document "$S3_POLICY" > /dev/null

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
echo "Role ARN: $ROLE_ARN"

echo "Waiting 15 seconds for IAM Role propagation..."
sleep 15

# d) Run npm install inside lambda folder and zip contents
echo "Building Lambda function zip..."
cd aws/lambda/ingestImage
npm install > /dev/null 2>&1
zip -rq ../../../function.zip .
cd ../../../

# e) Create Lambda function
LAMBDA_NAME="SnapTrackIngestImage-$RANDOM"
echo "Deploying Lambda function: $LAMBDA_NAME..."

aws lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --runtime "nodejs20.x" \
    --handler "index.handler" \
    --role "$ROLE_ARN" \
    --zip-file "fileb://function.zip" \
    --timeout 15 \
    --environment "Variables={BUCKET_NAME=$BUCKET_NAME}" > /dev/null

# Clean up zip
rm function.zip

# f) Create HTTP API via Amazon API Gateway
echo "Creating HTTP API Gateway..."
API_NAME="SnapTrackIngestAPI"

API_ID=$(aws apigatewayv2 create-api \
    --name "$API_NAME" \
    --protocol-type HTTP \
    --query 'ApiId' \
    --output text)

echo "Created HTTP API with ID: $API_ID"

LAMBDA_ARN=$(aws lambda get-function \
    --function-name "$LAMBDA_NAME" \
    --query 'Configuration.FunctionArn' \
    --output text)

INTEGRATION_ID=$(aws apigatewayv2 create-integration \
    --api-id "$API_ID" \
    --integration-type "AWS_PROXY" \
    --integration-uri "$LAMBDA_ARN" \
    --payload-format-version "2.0" \
    --query 'IntegrationId' \
    --output text)

echo "Created Integration: $INTEGRATION_ID"

aws apigatewayv2 create-route \
    --api-id "$API_ID" \
    --route-key "POST /ingest" \
    --target "integrations/$INTEGRATION_ID" > /dev/null

aws apigatewayv2 create-stage \
    --api-id "$API_ID" \
    --stage-name \$default \
    --auto-deploy > /dev/null

ACCOUNT_ID=$(aws sts get-caller-identity --query 'Account' --output text)

echo "Granting API Gateway permission to invoke Lambda..."
aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --statement-id "apigateway-invoke-permissions" \
    --action "lambda:InvokeFunction" \
    --principal "apigateway.amazonaws.com" \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*/*/ingest" > /dev/null

# g) Print final URL
INVOKE_URL="https://$API_ID.execute-api.$REGION.amazonaws.com/ingest"

echo ""
echo "=========================================================="
echo "DEPLOYMENT COMPLETE: Phase 1 (AWS Ingestion Pipeline)"
echo "=========================================================="
echo "S3 Bucket Name:    $BUCKET_NAME"
echo "IAM Role Name:     $ROLE_NAME"
echo "Lambda Function:   $LAMBDA_NAME"
echo "API Gateway ID:    $API_ID"
echo ""
echo "👉 PUBLIC INVOKE URL FOR iOS SHORTCUT:"
echo "$INVOKE_URL"
echo ""
echo "You can test this endpoint with a POST request containing a JSON payload:"
echo '{"image": "base64_encoded_string_here"}'
echo "=========================================================="
