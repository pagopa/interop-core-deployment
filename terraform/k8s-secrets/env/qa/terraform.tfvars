aws_region = "eu-south-1"
env        = "qa"

tags = {
  CreatedBy   = "Terraform"
  Environment = "Qa"
  Owner       = "PagoPA"
  Source      = "https://github.com/pagopa/interop-core-deployment"
}

eks_cluster_name = "interop-eks-cluster-qa"
