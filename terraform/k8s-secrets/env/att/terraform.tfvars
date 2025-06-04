aws_region = "eu-south-1"
env        = "att"

tags = {
  CreatedBy   = "Terraform"
  Environment = "att"
  Owner       = "PagoPA"
  Source      = "https://github.com/pagopa/interop-core-deployment"
}

eks_cluster_name = "interop-eks-cluster-att"
