#!/bin/bash
set -e

REGION="us-east-1"
export AWS_DEFAULT_REGION=$REGION

echo "Starting deployment of Phase 6: Auth & Multi-Tenancy..."

# a) Create Cognito User Pool
POOL_NAME="SnapTrackUsers"
echo "Creating Cognito User Pool: $POOL_NAME..."
POOL_ID=$(aws cognito-idp create-user-pool \
    --pool-name "$POOL_NAME" \
    --auto-verified-attributes email \
    --username-attributes email \
    --policies 'PasswordPolicy={MinimumLength=8,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=false}' \
    --query 'UserPool.Id' \
    --output text 2>/dev/null || true)

if [ -z "$POOL_ID" ]; then
    # If it fails, it might already exist. Let's find it.
    POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='$POOL_NAME'].Id" --output text | head -n 1)
fi
echo "User Pool ID: $POOL_ID"

# b) Create User Pool Client
CLIENT_NAME="SnapTrackReactApp"
echo "Creating User Pool Client: $CLIENT_NAME..."
CLIENT_ID=$(aws cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-name "$CLIENT_NAME" \
    --no-generate-secret \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH ALLOW_USER_SRP_AUTH \
    --query 'UserPoolClient.ClientId' \
    --output text 2>/dev/null || true)

if [ -z "$CLIENT_ID" ]; then
    CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --max-results 60 --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId" --output text | head -n 1)
fi
echo "Client ID: $CLIENT_ID"

ISSUER_URL="https://cognito-idp.$REGION.amazonaws.com/$POOL_ID"

# c) Discover existing API Gateway
echo "Discovering existing API Gateway..."
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='SnapTrackIngestAPI'].ApiId" --output text | head -n 1)

if [ -z "$API_ID" ] || [ "$API_ID" == "None" ]; then
    echo "Error: SnapTrackIngestAPI not found."
    exit 1
fi
echo "Found API ID: $API_ID"

# d) Create HTTP API JWT Authorizer
AUTHORIZER_NAME="SnapTrackCognitoAuthorizer"
echo "Creating JWT Authorizer..."
AUTHORIZER_ID=$(aws apigatewayv2 get-authorizers --api-id "$API_ID" --query "Items[?Name=='$AUTHORIZER_NAME'].AuthorizerId" --output text)

if [ -z "$AUTHORIZER_ID" ]; then
    AUTHORIZER_ID=$(aws apigatewayv2 create-authorizer \
        --api-id "$API_ID" \
        --authorizer-type JWT \
        --identity-source '$request.header.Authorization' \
        --name "$AUTHORIZER_NAME" \
        --jwt-configuration "Audience=['$CLIENT_ID'],Issuer='$ISSUER_URL'" \
        --query 'AuthorizerId' \
        --output text)
fi
echo "Authorizer ID: $AUTHORIZER_ID"

# e) Update routes to require JWT Authorizer
echo "Updating routes to require Authorizer..."

INGEST_ROUTE_ID=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='POST /ingest'].RouteId" --output text)
MEALS_ROUTE_ID=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='GET /meals'].RouteId" --output text)

if [ -n "$INGEST_ROUTE_ID" ] && [ "$INGEST_ROUTE_ID" != "None" ]; then
    echo "Updating POST /ingest route..."
    aws apigatewayv2 update-route \
        --api-id "$API_ID" \
        --route-id "$INGEST_ROUTE_ID" \
        --authorization-type JWT \
        --authorizer-id "$AUTHORIZER_ID" > /dev/null
fi

if [ -n "$MEALS_ROUTE_ID" ] && [ "$MEALS_ROUTE_ID" != "None" ]; then
    echo "Updating GET /meals route..."
    aws apigatewayv2 update-route \
        --api-id "$API_ID" \
        --route-id "$MEALS_ROUTE_ID" \
        --authorization-type JWT \
        --authorizer-id "$AUTHORIZER_ID" > /dev/null
fi

# Deploying updated Lambdas
echo "Updating Ingestion Lambda..."
cd aws/lambda/ingestImage
zip -rq ../../../ingest-update.zip .
cd ../../../
aws lambda update-function-code --function-name $(aws lambda list-functions --query "Functions[?contains(FunctionName, 'SnapTrackIngestImage')].FunctionName" --output text | head -n 1) --zip-file fileb://ingest-update.zip > /dev/null
rm ingest-update.zip

echo "Updating ProcessReceipt Lambda..."
cd aws/lambda/processReceipt
zip -rq ../../../process-update.zip .
cd ../../../
aws lambda update-function-code --function-name $(aws lambda list-functions --query "Functions[?contains(FunctionName, 'SnapTrackProcessReceipt')].FunctionName" --output text | head -n 1) --zip-file fileb://process-update.zip > /dev/null
rm process-update.zip

echo "Updating GetMeals Lambda..."
cd aws/lambda/getMeals
zip -rq ../../../getmeals-update.zip .
cd ../../../
aws lambda update-function-code --function-name $(aws lambda list-functions --query "Functions[?contains(FunctionName, 'SnapTrackGetMeals')].FunctionName" --output text | head -n 1) --zip-file fileb://getmeals-update.zip > /dev/null
rm getmeals-update.zip


echo ""
echo "=========================================================="
echo "DEPLOYMENT COMPLETE: Phase 6 (Auth & Multi-Tenancy)"
echo "=========================================================="
echo "User Pool ID:     $POOL_ID"
echo "Client ID:        $CLIENT_ID"
echo "Issuer URL:       $ISSUER_URL"
echo ""
echo "Please update your React app with these Cognito credentials!"
echo "Your API endpoints now require a Bearer Token in the Authorization header."
echo "=========================================================="
