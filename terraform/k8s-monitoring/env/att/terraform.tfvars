aws_region = "eu-south-1"
env        = "att"

tags = {
  CreatedBy   = "Terraform"
  Environment = "att"
  Owner       = "PagoPA"
  Source      = "https://github.com/pagopa/interop-core-deployment"
}

eks_cluster_name = "interop-eks-cluster-att"

sns_topic_name = "interop-platform-alarms-att"

cloudwatch_log_group_name = "/aws/eks/interop-eks-cluster-att/application"
