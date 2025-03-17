variable "aws_region" {
  type        = string
  description = "AWS region"
}

variable "env" {
  type        = string
  description = "Environment name"
}

variable "tags" {
  type = map(any)
  default = {
    CreatedBy = "Terraform"
  }
}

variable "eks_cluster_name" {
  type        = string
  description = "Name of the interop EKS cluster"
}

variable "sns_topic_name" {
  description = "Name of the SNS topic for alarms notifications"
  type        = string
}

variable "cloudwatch_log_group_name" {
  description = "Name of the Cloudwatch log group to get metric filters"
  type        = string
}