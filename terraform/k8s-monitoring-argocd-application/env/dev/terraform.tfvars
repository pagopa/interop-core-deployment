aws_region = "eu-south-1"
env        = "dev"

tags = {
  CreatedBy   = "Terraform"
  Environment = "dev"
  Owner       = "PagoPA"
  Source      = "https://github.com/pagopa/interop-core-deployment"
}

eks_cluster_name = "interop-eks-cluster-dev"

sns_topic_name = "interop-platform-alarms-dev"

cloudwatch_log_group_name = "/aws/eks/interop-eks-cluster-dev/application"
  
# For testing purposes  
argocd_workload_name = "interop-be-audit-signer"
argocd_workload_kind = "Deployment"
k8s_namespace        = "dev-argocd-deploy"