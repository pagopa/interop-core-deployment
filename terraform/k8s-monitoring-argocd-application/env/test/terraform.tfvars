aws_region = "eu-south-1"
env        = "test"

tags = {
  CreatedBy   = "Terraform"
  Environment = "test"
  Owner       = "PagoPA"
  Source      = "https://github.com/pagopa/interop-core-deployment"
}

eks_cluster_name = "interop-eks-cluster-test"

sns_topic_name = "interop-platform-alarms-test"

cloudwatch_log_group_name = "/aws/eks/interop-eks-cluster-test/application"
