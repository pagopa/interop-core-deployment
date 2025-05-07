aws_region = "eu-south-1"
env        = "qa"

tags = {
  CreatedBy   = "Terraform"
  Environment = "Qa"
  Owner       = "PagoPA"
  Source      = "https://github.com/pagopa/interop-core-deployment"
}

eks_cluster_name = "interop-eks-cluster-qa"

sns_topic_name = "interop-platform-alarms-qa"

cloudwatch_log_group_name = "/aws/eks/interop-eks-cluster-qa/application"
