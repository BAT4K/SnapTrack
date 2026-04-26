#!/bin/bash
set -e

REGION="us-east-1"
export AWS_DEFAULT_REGION=$REGION

echo "Starting deployment of Phase 3: Data Retrieval Pipeline..."

TABLE_NAME="SnapTrackMeals"
ACCOUNT_ID=$(aws sts get-caller-identity --query 'Account' --output text)

# a) Create IAM Role for Lambda
ROLE_NAME="SnapTrackRetrievalRole-$RANDOM"
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

echo "Creating inline policy for dynamodb:Scan..."
POLICY_NAME="SnapTrackRetrievalPolicy"
RETRIEVAL_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "dynamodb:Scan",
      "Resource": "arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/$TABLE_NAME"
    }
  ]
}
EOF
)

aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "$POLICY_NAME" \
    --policy-document "$RETRIEVAL_POLICY" > /dev/null

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
echo "Role ARN: $ROLE_ARN"

echo "Waiting 15 seconds for IAM Role propagation..."
sleep 15

# b) Zip Lambda and deploy
echo "Building Lambda function zip..."
cd aws/lambda/getMeals
npm install > /dev/null 2>&1
zip -rq ../../../get-meals-function.zip .
cd ../../../

# c) Create the Lambda function
LAMBDA_NAME="SnapTrackGetMeals-$RANDOM"
echo "Deploying Lambda function: $LAMBDA_NAME..."

aws lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --runtime "nodejs20.x" \
    --handler "index.handler" \
    --role "$ROLE_ARN" \
    --zip-file "fileb://get-meals-function.zip" \
    --timeout 10 \
    --memory-size 128 > /dev/null

rm get-meals-function.zip

LAMBDA_ARN=$(aws lambda get-function --function-name "$LAMBDA_NAME" --query 'Configuration.FunctionArn' --output text)

# d) Check if we can reuse the Phase 1 API Gateway
echo "Checking for existing API Gateway..."
# We look for an API with routes to integrations. The safest way is to search for the API created previously.
# First, look for an API named 'SnapTrackIngestAPI'
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='SnapTrackIngestAPI'].ApiId" --output text | head -n 1)

if [ -z "$API_ID" ] || [ "$API_ID" == "None" ]; then
    echo "Existing API Gateway not found. Creating a new one..."
    API_NAME="SnapTrackRetrievalAPI"
    API_ID=$(aws apigatewayv2 create-api \
        --name "$API_NAME" \
        --protocol-type HTTP \
        --cors-configuration "AllowOrigins=['*'],AllowMethods=['GET','OPTIONS']" \
        --query 'ApiId' \
        --output text)
    
    echo "Created HTTP API with ID: $API_ID"
    
    # Create stage for new API
    aws apigatewayv2 create-stage \
        --api-id "$API_ID" \
        --stage-name \$default \
        --auto-deploy > /dev/null
else
    echo "Found existing Phase 1 API Gateway: $API_ID"
    # Ensure CORS is configured on the existing API (this will overwrite previous empty CORS if any, but add needed origins)
    aws apigatewayv2 update-api \
        --api-id "$API_ID" \
        --cors-configuration "AllowOrigins=['*'],AllowMethods=['GET','POST','OPTIONS'],AllowHeaders=['Content-Type']" > /dev/null
fi

# e) Link the route to Lambda
echo "Creating API Integration..."
INTEGRATION_ID=$(aws apigatewayv2 create-integration \
    --api-id "$API_ID" \
    --integration-type "AWS_PROXY" \
    --integration-uri "$LAMBDA_ARN" \
    --payload-format-version "2.0" \
    --query 'IntegrationId' \
    --output text)

echo "Created Integration: $INTEGRATION_ID"

echo "Creating GET /meals route..."
aws apigatewayv2 create-route \
    --api-id "$API_ID" \
    --route-key "GET /meals" \
    --target "integrations/$INTEGRATION_ID" > /dev/null

echo "Granting API Gateway permission to invoke Lambda..."
aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --statement-id "apigateway-invoke-get-meals" \
    --action "lambda:InvokeFunction" \
    --principal "apigateway.amazonaws.com" \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*/*/meals" > /dev/null

# f) Print the final API URL
INVOKE_URL="https://$API_ID.execute-api.$REGION.amazonaws.com/meals"

echo ""
echo "=========================================================="
echo "DEPLOYMENT COMPLETE: Phase 3 (Data Retrieval)"
echo "=========================================================="
echo "DynamoDB Table:    $TABLE_NAME"
echo "IAM Role Name:     $ROLE_NAME"
echo "Lambda Function:   $LAMBDA_NAME"
echo "API Gateway ID:    $API_ID"
echo ""
echo "👉 PUBLIC GET ENDPOINT FOR REACT FRONTEND:"
echo "$INVOKE_URL"
echo ""
echo "You can test this endpoint in your browser or with curl:"
echo "curl -X GET \"$INVOKE_URL\""
echo "=========================================================="
