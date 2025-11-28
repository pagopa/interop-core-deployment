#!/usr/bin/env bash
set -euo pipefail

# Read the input
INPUT=$(cat)

# Extract the list of secrets ARNs from the input
SECRETS_ARNS=$(echo "$INPUT" | jq -r '.secretsARNs' | jq -r '.[]')

# Initialize the output list
SECRETS_NAMES="[]"

# Loop through all the secrets ARNs
while read -r SECRET_ARN; do
  [ -z "$SECRET_ARN" ] && continue

  # List the versions of the current secret
  VERSIONS_JSON=$(aws secretsmanager list-secret-version-ids --secret-id "$SECRET_ARN")
  VERSIONS_COUNT=$(echo "$VERSIONS_JSON" | jq '.Versions | length')

  if [ "$VERSIONS_COUNT" -gt 0 ]; then
    # Get the name of the secret from the describe-secret command
    SECRET_NAME=$(aws secretsmanager describe-secret --secret-id "$SECRET_ARN" | jq -r '.Name')

    # Append the name of the secret to the output list
    SECRETS_NAMES=$(echo "$SECRETS_NAMES" | jq --arg name "$SECRET_NAME" '. += [$name]')
  fi

done <<< "$SECRETS_ARNS"

# Convert the output list as JSON string
jq -n --arg list "$(echo "$SECRETS_NAMES" | jq -c '.')" '{secretsNames: $list}'
