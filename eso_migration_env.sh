export MIG_ENV=dev
export MIG_NAMESPACE=dev
export MIG_CLUSTER='arn:aws:eks:eu-south-1:505630707203:cluster/interop-eks-cluster-dev'
export MIG_SECRET_STORE='app-secret-store'
export MIG_OUTPUT_DIR="secret-inventory/${MIG_ENV}"
export MIG_ANALYSIS_DIR="external-secrets-analysis/${MIG_ENV}"