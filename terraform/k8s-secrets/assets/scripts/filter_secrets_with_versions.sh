#!/usr/bin/env bash
set -euo pipefail

# Extract the list of secrets ARNs from the input
SECRETS_ARNS=$(jq -r '.secretsARNs | fromjson | .[]')

# Initialize the output list
SECRETS_NAMES="[]"

# Loop through all the secrets ARNs
while read -r SECRET_ARN; do
  [ -z "$SECRET_ARN" ] && continue

  # Retrieve the details of the current secret  
  SECRET_JSON=$(aws secretsmanager describe-secret --secret-id "$SECRET_ARN" --output json)
  
  # Get the name of the secret
  SECRET_NAME=$(jq -r '.Name' <<< "$SECRET_JSON")
  # Check if the secret has versions
  HAS_VERSIONS=$(jq '(.VersionIdsToStages // {}) | length > 0 ' <<< "$SECRET_JSON")

  if [[ "$HAS_VERSIONS" == "true" ]]; then
    # Append the name of the secret to the output list
    SECRETS_NAMES=$(echo "$SECRETS_NAMES" | jq --arg name "$SECRET_NAME" '. += [$name]')
  fi
done <<< "$SECRETS_ARNS"

# Convert the output list as JSON string
jq -n --arg list "$(echo "$SECRETS_NAMES" | jq -c '.')" '{secretsNames: $list}'
