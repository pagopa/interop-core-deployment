echo "Starting secret references repository inventory..."
npm run secret-references-repo-inventory -- \
  --env "$MIG_ENV" \
  --output-dir "$MIG_OUTPUT_DIR" \
  --format both

sleep 2

echo "Starting secret references cluster inventory..."
npm run secret-references-cluster-inventory -- \
  --cluster "$MIG_CLUSTER" \
  --namespace "$MIG_NAMESPACE" \
  --output-dir "$MIG_OUTPUT_DIR" \
  --format both

sleep 2

echo "Starting secret references comparison..."
test "$MIG_ENV" = "$MIG_NAMESPACE" &&
npm run secret-references-compare -- \
  --env "$MIG_ENV" \
  --cluster "$MIG_CLUSTER" \
  --output-dir "$MIG_OUTPUT_DIR"

sleep 2

echo "(dry-run) Starting secret references external secrets generation..."
npm run secret-references-external-secrets-generator -- \
  --env "$MIG_ENV" \
  --cluster "$MIG_CLUSTER" \
  --namespace "$MIG_NAMESPACE" \
  --secret-store "$MIG_SECRET_STORE" \
  --scope both \
  --keep-old-refs false \
  --output-dir "$MIG_OUTPUT_DIR" \
  --dry-run

sleep 2

echo "Starting secret references external secrets generation..."
npm run secret-references-external-secrets-generator -- \
  --env "$MIG_ENV" \
  --cluster "$MIG_CLUSTER" \
  --namespace "$MIG_NAMESPACE" \
  --secret-store "$MIG_SECRET_STORE" \
  --scope both \
  --keep-old-refs false \
  --output-dir "$MIG_OUTPUT_DIR"

sleep 2

echo "Starting secret references external secrets validation..."
npm run secret-references-external-secrets-validator -- \
  --env "$MIG_ENV" \
  --scope both \
  --migration-report "$MIG_OUTPUT_DIR/external-secrets-migration-$MIG_ENV.json" \
  --repo-inventory "$MIG_OUTPUT_DIR/secret-references-repo-$MIG_ENV.json" \
  --cluster-inventory "$MIG_OUTPUT_DIR/secret-inventory-cluster-secrets-$MIG_NAMESPACE.json" \
  --output-dir "$MIG_OUTPUT_DIR"