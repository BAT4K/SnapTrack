#!/bin/bash
set -e

LAMBDA_NAME=$(aws lambda list-functions --query "Functions[?contains(FunctionName, 'SnapTrackProcessReceipt')].FunctionName" --output text | awk '{print $1}')

if [ -z "$LAMBDA_NAME" ] || [ "$LAMBDA_NAME" == "None" ]; then
    echo "Error: Could not find the SnapTrackProcessReceipt Lambda function."
    exit 1
fi

echo "Updating Lambda configuration for: $LAMBDA_NAME"

aws lambda update-function-configuration \
    --function-name "$LAMBDA_NAME" \
    --environment "Variables={GEMINI_API_KEY=INTENTIONAL_CHAOS_TEST_KEY,GROQ_API_KEY=$GROQ_API_KEY}" > /dev/null

echo -e "\n\033[1;31m⚠️ CHAOS MODE ENGAGED: Gemini API Key Sabotaged. Run restore_health.sh to fix.\033[0m\n"
