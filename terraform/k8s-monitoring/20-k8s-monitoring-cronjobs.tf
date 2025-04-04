data "local_file" "cronjobs_list" {
  filename = "${path.module}/assets/cronjobs-list.json"
}

locals {
  cronjobs_names = jsondecode(data.local_file.cronjobs_list.content)
}

module "k8s_cronjob_monitoring" {
  for_each = toset(local.cronjobs_names)

  source = "git::https://github.com/pagopa/interop-infra-commons//terraform/modules/k8s-workload-monitoring?ref=v1.9.0"

  eks_cluster_name  = var.eks_cluster_name
  k8s_namespace     = var.env
  kind              = "Cronjob"
  k8s_workload_name = each.key
  sns_topics_arns   = [data.aws_sns_topic.platform_alarms.arn]

  create_pod_availability_alarm = false
  create_pod_readiness_alarm    = false
  create_performance_alarm      = false
  create_app_logs_errors_alarm  = true

  create_dashboard = false

  cloudwatch_app_logs_errors_metric_name      = try(data.external.cloudwatch_log_metric_filters.result.metricName, null)
  cloudwatch_app_logs_errors_metric_namespace = try(data.external.cloudwatch_log_metric_filters.result.metricNamespace, null)

  tags = var.tags
}
