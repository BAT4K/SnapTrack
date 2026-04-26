#!/bin/bash
set -e

# Load environment variables
if [ -f .env ]; then
  source .env
fi

if [ -z "$TO_EMAIL" ] || [ -z "$FROM_EMAIL" ]; then
  echo "Error: TO_EMAIL and FROM_EMAIL must be set in .env or exported"
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=${AWS_REGION:-us-east-1}

ROLE_NAME="SnapTrackWeeklyReportRole"
FUNCTION_NAME="snaptrack-weekly-report"

# Create IAM Role
echo "Creating IAM Role: $ROLE_NAME"
aws iam create-role \
  --role-name $ROLE_NAME \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Action": "sts:AssumeRole",
      "Principal": {"Service": "lambda.amazonaws.com"},
      "Effect": "Allow"
    }]
  }' 2>/dev/null || echo "Role already exists"

# Attach Policies
aws iam attach-role-policy \
  --role-name $ROLE_NAME \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

echo "Putting inline policy for DynamoDB and SES"
aws iam put-role-policy \
  --role-name $ROLE_NAME \
  --policy-name WeeklyReportPolicy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "dynamodb:Scan"
        ],
        "Resource": "arn:aws:dynamodb:'$REGION':'$ACCOUNT_ID':table/SnapTrackMeals"
      },
      {
        "Effect": "Allow",
        "Action": [
          "ses:SendEmail",
          "ses:SendRawEmail"
        ],
        "Resource": "*"
      }
    ]
  }'

echo "Waiting for role to propagate..."
sleep 10

# Package Lambda
echo "Packaging Lambda..."
cd aws/lambda/weeklyReport
npm install
zip -r ../../../weeklyReport.zip .
cd ../../../

# Create or Update Lambda Function
echo "Deploying Lambda function..."
if aws lambda get-function --function-name $FUNCTION_NAME >/dev/null 2>&1; then
    aws lambda update-function-code \
        --function-name $FUNCTION_NAME \
        --zip-file fileb://weeklyReport.zip

    aws lambda wait function-updated --function-name $FUNCTION_NAME

    aws lambda update-function-configuration \
        --function-name $FUNCTION_NAME \
        --environment "Variables={TO_EMAIL=$TO_EMAIL,FROM_EMAIL=$FROM_EMAIL}"
else
    aws lambda create-function \
        --function-name $FUNCTION_NAME \
        --runtime nodejs20.x \
        --role arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME \
        --handler index.handler \
        --timeout 30 \
        --zip-file fileb://weeklyReport.zip \
        --environment "Variables={TO_EMAIL=$TO_EMAIL,FROM_EMAIL=$FROM_EMAIL}"
fi

echo "Cleaning up..."
rm weeklyReport.zip

echo "Deployment complete! ✅"
