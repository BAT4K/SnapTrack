#!/bin/bash
set -e

echo "Starting Step Functions Lambda Deployment..."

# Fetch the ARN of the monolithic lambda function's role
echo "Fetching IAM Role from existing monolithic lambda..."
LAMBDA_NAME=$(aws lambda list-functions --query "Functions[?starts_with(FunctionName, 'SnapTrackProcessReceipt')].FunctionName" --output text | awk '{print $1}')

if [ -z "$LAMBDA_NAME" ] || [ "$LAMBDA_NAME" == "None" ]; then
    echo "Error: Could not find monolithic Lambda. Ensure it is deployed."
    exit 1
fi

ROLE_ARN=$(aws lambda get-function --function-name "$LAMBDA_NAME" --query "Configuration.Role" --output text)
echo "Using IAM Role: $ROLE_ARN"

# Load overrides from .env if available
if [ -f .env ]; then
  echo "Loading .env overrides..."
  source .env
fi

# Collect .env overrides into an associative array
declare -A ENV_OVERRIDES
[ -n "$GEMINI_API_KEY" ] && ENV_OVERRIDES[GEMINI_API_KEY]="$GEMINI_API_KEY"
[ -n "$GROQ_API_KEY" ] && ENV_OVERRIDES[GROQ_API_KEY]="$GROQ_API_KEY"
[ -n "$TELEGRAM_BOT_TOKEN" ] && ENV_OVERRIDES[TELEGRAM_BOT_TOKEN]="$TELEGRAM_BOT_TOKEN"
[ -n "$TELEGRAM_CHAT_ID" ] && ENV_OVERRIDES[TELEGRAM_CHAT_ID]="$TELEGRAM_CHAT_ID"

FUNCTIONS=("step1_extractImage" "step2_analyzeCalories" "step3_saveToDatabase")

for FUNC in "${FUNCTIONS[@]}"; do
    echo "========================================="
    echo "Processing $FUNC..."
    echo "========================================="
    
    cd "aws/lambda/$FUNC"
    
    echo "Running npm install..."
    npm install > /dev/null 2>&1
    
    echo "Zipping contents..."
    ZIP_NAME="${FUNC}.zip"
    zip -rq "../../$ZIP_NAME" .
    
    cd ../../../
    
    # ---- Preserve existing environment variables ----
    # Fetch current env vars from AWS as JSON, then merge with overrides
    EXISTING_ENV=$(aws lambda get-function-configuration --function-name "$FUNC" --query 'Environment.Variables' --output json 2>/dev/null || echo "null")
    
    # Build merged env vars JSON using Python (available on all Lambda-capable systems)
    MERGED_ENV=$(python3 -c "
import json, sys
existing = json.loads('$EXISTING_ENV') if '$EXISTING_ENV' != 'null' else {}
overrides = json.loads(sys.stdin.read())
existing.update(overrides)
print(json.dumps(existing))
" <<< "$(python3 -c "
import json
d = {}
$(for key in "${!ENV_OVERRIDES[@]}"; do echo "d['$key'] = '${ENV_OVERRIDES[$key]}'"; done)
print(json.dumps(d))
")")
    
    echo "Environment for $FUNC: $(echo $MERGED_ENV | python3 -c 'import json,sys; d=json.load(sys.stdin); print(", ".join(d.keys()))')"
    
    # Check if function exists
    if aws lambda get-function --function-name "$FUNC" > /dev/null 2>&1; then
        echo "Updating existing function: $FUNC"
        aws lambda update-function-code \
            --function-name "$FUNC" \
            --zip-file "fileb://aws/$ZIP_NAME" > /dev/null
        
        echo "Waiting for function update to complete..."
        aws lambda wait function-updated --function-name "$FUNC"
        
        aws lambda update-function-configuration \
            --function-name "$FUNC" \
            --role "$ROLE_ARN" \
            --environment "Variables=$MERGED_ENV" \
            --tracing-config Mode=Active > /dev/null
    else
        echo "Creating new function: $FUNC"
        aws lambda create-function \
            --function-name "$FUNC" \
            --runtime "nodejs20.x" \
            --handler "index.handler" \
            --role "$ROLE_ARN" \
            --zip-file "fileb://aws/$ZIP_NAME" \
            --timeout 30 \
            --memory-size 256 \
            --tracing-config Mode=Active \
            --environment "Variables=$MERGED_ENV" > /dev/null
    fi
    
    echo "Cleaning up $ZIP_NAME..."
    rm "aws/$ZIP_NAME"
done

echo "========================================="
echo "Step Functions Lambdas deployment complete! ✅"
echo "========================================="
