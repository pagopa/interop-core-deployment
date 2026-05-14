#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)

# Extract AWS region
AWS_REGION=$(jq -r '.awsRegion' <<< "$INPUT")

# Extract the list of secrets ARNs
SECRETS_ARNS=$(jq -r '.secretsARNs | fromjson | .[]' <<< "$INPUT")

# Initialize the output list
SECRETS_NAMES="[]"

# Loop through all the secrets ARNs
while read -r SECRET_ARN; do
  [ -z "$SECRET_ARN" ] && continue

  # Retrieve the details of the current secret  
  SECRET_JSON=$(aws secretsmanager describe-secret --secret-id "$SECRET_ARN" --region "$AWS_REGION" --output json)
  
  # Get the name of the secret
  SECRET_NAME=$(jq -r '.Name' <<< "$SECRET_JSON")
  # Check if the secret has a current version
  HAS_CURRENT_VERSION=$(jq '(.VersionIdsToStages // {}) | to_entries | any(.[]; (.value | index("AWSCURRENT")))' <<< "$SECRET_JSON")
  
  if [[ "$HAS_CURRENT_VERSION" == "true" ]]; then
    # Append the name of the secret to the output list
    SECRETS_NAMES=$(echo "$SECRETS_NAMES" | jq --arg name "$SECRET_NAME" '. += [$name]')
  fi
done <<< "$SECRETS_ARNS"

# Convert the output list as JSON string
jq -n --arg list "$(echo "$SECRETS_NAMES" | jq -c '.')" '{secretsNames: $list}'
