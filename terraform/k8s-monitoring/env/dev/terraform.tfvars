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

be_refactor_sns_topic_name = "interop-platform-alarms-refactor-dev"

cloudwatch_log_group_name = "/aws/eks/interop-eks-cluster-dev/application"
