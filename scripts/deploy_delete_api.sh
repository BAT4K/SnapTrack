#!/bin/bash
set -e

REGION="us-east-1"
export AWS_DEFAULT_REGION=$REGION

echo "Starting deployment of Phase 8: Delete Meal API..."

ACCOUNT_ID=$(aws sts get-caller-identity --query 'Account' --output text)

# Find Raw Receipts Bucket
RAW_BUCKET=$(aws s3api list-buckets --query "Buckets[?starts_with(Name, 'snaptrack-raw-receipts-')].Name" --output text | awk '{print $1}')
if [ -z "$RAW_BUCKET" ] || [ "$RAW_BUCKET" == "None" ]; then
    echo "Error: Raw receipts bucket not found."
    exit 1
fi
echo "Found Bucket: $RAW_BUCKET"

# Create IAM Role
ROLE_NAME="SnapTrackDeleteRole-$RANDOM"
echo "Creating IAM Role: $ROLE_NAME..."

TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
)

aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST_POLICY" > /dev/null
aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" > /dev/null

DELETE_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "dynamodb:DeleteItem",
      "Resource": "arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/SnapTrackMeals"
    },
    {
      "Effect": "Allow",
      "Action": "s3:DeleteObject",
      "Resource": "arn:aws:s3:::$RAW_BUCKET/*"
    }
  ]
}
EOF
)
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "SnapTrackDeletePolicy" --policy-document "$DELETE_POLICY" > /dev/null

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
echo "Role ARN: $ROLE_ARN"

echo "Waiting 15 seconds for IAM Role propagation..."
sleep 15

# Zip Lambda and deploy
echo "Building Lambda function zip..."
cd aws/lambda/deleteMeal
npm install > /dev/null 2>&1
zip -rq ../../../delete-function.zip .
cd ../../../

LAMBDA_NAME="SnapTrackDeleteMeal-$RANDOM"
echo "Deploying Lambda function: $LAMBDA_NAME..."

aws lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --runtime "nodejs20.x" \
    --handler "index.handler" \
    --role "$ROLE_ARN" \
    --zip-file "fileb://delete-function.zip" \
    --timeout 10 \
    --memory-size 128 \
    --environment "Variables={BUCKET_NAME=$RAW_BUCKET}" > /dev/null

rm delete-function.zip

LAMBDA_ARN=$(aws lambda get-function --function-name "$LAMBDA_NAME" --query 'Configuration.FunctionArn' --output text)

# API Gateway Integration
echo "Discovering existing API Gateway..."
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='SnapTrackIngestAPI'].ApiId" --output text | head -n 1)

if [ -z "$API_ID" ] || [ "$API_ID" == "None" ]; then
    echo "Error: API Gateway not found."
    exit 1
fi

echo "Creating API Integration..."
INTEGRATION_ID=$(aws apigatewayv2 create-integration \
    --api-id "$API_ID" \
    --integration-type "AWS_PROXY" \
    --integration-uri "$LAMBDA_ARN" \
    --payload-format-version "2.0" \
    --query 'IntegrationId' \
    --output text)

echo "Creating DELETE /meals route..."
ROUTE_ID=$(aws apigatewayv2 create-route \
    --api-id "$API_ID" \
    --route-key "DELETE /meals" \
    --target "integrations/$INTEGRATION_ID" \
    --query 'RouteId' \
    --output text)

AUTHORIZER_ID=$(aws apigatewayv2 get-authorizers --api-id "$API_ID" --query "Items[?Name=='SnapTrackCognitoAuthorizer'].AuthorizerId" --output text)

echo "Attaching Authorizer $AUTHORIZER_ID to route..."
aws apigatewayv2 update-route \
    --api-id "$API_ID" \
    --route-id "$ROUTE_ID" \
    --authorization-type JWT \
    --authorizer-id "$AUTHORIZER_ID" > /dev/null

echo "Granting API Gateway permission to invoke Lambda..."
aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --statement-id "apigateway-invoke-delete" \
    --action "lambda:InvokeFunction" \
    --principal "apigateway.amazonaws.com" \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*/*/meals" > /dev/null

# Update CORS to include DELETE method
aws apigatewayv2 update-api --api-id "$API_ID" --cors-configuration "AllowOrigins=['*'],AllowMethods=['GET','POST','DELETE','OPTIONS'],AllowHeaders=['Content-Type','Authorization']" > /dev/null

echo ""
echo "=========================================================="
echo "DEPLOYMENT COMPLETE: Phase 8 (Delete Meal API)"
echo "=========================================================="
echo "Route: DELETE /meals"
echo "Lambda: $LAMBDA_NAME"
echo "=========================================================="
