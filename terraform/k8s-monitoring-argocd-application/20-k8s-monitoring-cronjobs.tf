module "k8s_cronjob_monitoring" {
  count = var.argocd_workload_kind == "Cronjob" ? 1 : 0

  source = "git::https://github.com/pagopa/interop-infra-commons//terraform/modules/k8s-workload-monitoring?ref=v1.46.2"

  eks_cluster_name  = var.eks_cluster_name
  k8s_namespace     = var.env
  kind              = var.argocd_workload_kind
  k8s_workload_name = var.argocd_workload_name
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
