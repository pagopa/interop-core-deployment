aws_region = "eu-south-1"
env        = "vapt"

tags = {
  CreatedBy   = "Terraform"
  Environment = "Vapt"
  Owner       = "PagoPA"
  Source      = "https://github.com/pagopa/interop-core-deployment"
}

eks_cluster_name = "interop-eks-cluster-vapt"

sns_topic_name = "interop-platform-alarms-vapt"

cloudwatch_log_group_name = "/aws/eks/interop-eks-cluster-vapt/application"
