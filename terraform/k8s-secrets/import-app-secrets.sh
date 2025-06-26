NAMESPACE="prod"

for secret in $(kubectl get secrets -n "$NAMESPACE" -o jsonpath='{.items[*].metadata.name}'); do
  if [[ $secret =~ sh.helm* ]] || [[ $secret =~ platform-data-* ]]; then continue; fi;
  echo "./terraform.sh import $NAMESPACE 'kubernetes_secret_v1.replicated[\"$NAMESPACE/$secret\"]' $NAMESPACE/$secret" >> $NAMESPACE-secrets-import.txt
done;
