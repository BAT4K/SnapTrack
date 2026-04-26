#!/bin/bash
set -e

REGION="us-east-1"
export AWS_DEFAULT_REGION=$REGION

echo "Starting deployment of Phase 2: AWS Processing Pipeline..."

# Dynamically find the raw receipts bucket from Phase 1
RAW_BUCKET=$(aws s3api list-buckets --query "Buckets[?starts_with(Name, 'snaptrack-raw-receipts-')].Name" --output text | awk '{print $1}')

if [ -z "$RAW_BUCKET" ] || [ "$RAW_BUCKET" == "None" ]; then
    echo "Error: Could not find the raw receipts bucket from Phase 1."
    echo "Please ensure Phase 1 was deployed successfully."
    exit 1
fi

echo "Found Phase 1 Raw Receipts Bucket: $RAW_BUCKET"

# a) Create DynamoDB Table
TABLE_NAME="SnapTrackMeals"
echo "Checking if DynamoDB table $TABLE_NAME exists..."

if ! aws dynamodb describe-table --table-name "$TABLE_NAME" > /dev/null 2>&1; then
    echo "Creating DynamoDB table: $TABLE_NAME..."
    aws dynamodb create-table \
        --table-name "$TABLE_NAME" \
        --attribute-definitions AttributeName=receiptId,AttributeType=S \
        --key-schema AttributeName=receiptId,KeyType=HASH \
        --billing-mode PAY_PER_REQUEST > /dev/null
    
    echo "Waiting for DynamoDB table to become active..."
    aws dynamodb wait table-exists --table-name "$TABLE_NAME"
else
    echo "DynamoDB table $TABLE_NAME already exists."
fi

# b) Create IAM Role for Lambda
ROLE_NAME="SnapTrackProcessingRole-$RANDOM"
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

ACCOUNT_ID=$(aws sts get-caller-identity --query 'Account' --output text)

echo "Creating inline policy for S3 GetObject, SSM GetParameter, and DynamoDB PutItem..."
POLICY_NAME="SnapTrackProcessingPolicy"
PROCESSING_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::$RAW_BUCKET/*"
    },
    {
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": [
        "arn:aws:ssm:$REGION:$ACCOUNT_ID:parameter/snaptrack/gemini_api_key",
        "arn:aws:ssm:$REGION:$ACCOUNT_ID:parameter/snaptrack/azure_endpoint",
        "arn:aws:ssm:$REGION:$ACCOUNT_ID:parameter/snaptrack/azure_api_key"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "dynamodb:PutItem",
      "Resource": "arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/$TABLE_NAME"
    }
  ]
}
EOF
)

aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "$POLICY_NAME" \
    --policy-document "$PROCESSING_POLICY" > /dev/null

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
echo "Role ARN: $ROLE_ARN"

echo "Waiting 15 seconds for IAM Role propagation..."
sleep 15

# c) Zip Lambda and deploy
echo "Building Lambda function zip..."
cd aws/lambda/processReceipt
npm install > /dev/null 2>&1
zip -rq ../../../process-function.zip .
cd ../../../

LAMBDA_NAME="SnapTrackProcessReceipt-$RANDOM"
echo "Deploying Lambda function: $LAMBDA_NAME..."

aws lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --runtime "nodejs20.x" \
    --handler "index.handler" \
    --role "$ROLE_ARN" \
    --zip-file "fileb://process-function.zip" \
    --timeout 30 \
    --memory-size 256 \
    --environment "Variables={GEMINI_API_KEY=$GEMINI_API_KEY,GROQ_API_KEY=$GROQ_API_KEY,TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID}" > /dev/null

rm process-function.zip

LAMBDA_ARN=$(aws lambda get-function --function-name "$LAMBDA_NAME" --query 'Configuration.FunctionArn' --output text)

# d) Configure S3 Event Notification
echo "Adding Lambda invoke permission for S3 bucket $RAW_BUCKET..."
aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --statement-id "s3-invoke-permission" \
    --action "lambda:InvokeFunction" \
    --principal "s3.amazonaws.com" \
    --source-arn "arn:aws:s3:::$RAW_BUCKET" > /dev/null

echo "Configuring S3 event notification for .jpg files..."
NOTIFICATION_CONFIG=$(cat <<EOF
{
  "LambdaFunctionConfigurations": [
    {
      "LambdaFunctionArn": "$LAMBDA_ARN",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": {
        "Key": {
          "FilterRules": [
            {
              "Name": "suffix",
              "Value": ".jpg"
            }
          ]
        }
      }
    }
  ]
}
EOF
)

aws s3api put-bucket-notification-configuration \
    --bucket "$RAW_BUCKET" \
    --notification-configuration "$NOTIFICATION_CONFIG"

echo ""
echo "=========================================================="
echo "DEPLOYMENT COMPLETE: Phase 2 (AWS Processing Pipeline)"
echo "=========================================================="
echo "S3 Raw Bucket:     $RAW_BUCKET"
echo "DynamoDB Table:    $TABLE_NAME"
echo "IAM Role Name:     $ROLE_NAME"
echo "Lambda Function:   $LAMBDA_NAME"
echo "=========================================================="
