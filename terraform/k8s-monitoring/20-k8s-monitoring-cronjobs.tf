data "local_file" "cronjobs_list" {
  filename = "${path.module}/assets/cronjobs-list.json"
}

locals {
  cronjobs_names = jsondecode(data.local_file.cronjobs_list.content)
}

resource "aws_cloudwatch_metric_alarm" "cronjob_errors" {
  for_each = toset(local.cronjobs_names)

  alarm_name        = format("k8s-cronjob-%s-errors-%s", each.key, var.env)
  alarm_description = format("Cronjob errors alarm for %s", each.key)

  alarm_actions = [data.aws_sns_topic.platform_alarms.arn]

  metric_name = try(data.external.cloudwatch_log_metric_filters.result.metricName, null)
  namespace   = try(data.external.cloudwatch_log_metric_filters.result.metricNamespace, null)

  dimensions = {
    PodApp       = each.key
    PodNamespace = var.env
  }

  comparison_operator = "GreaterThanOrEqualToThreshold"
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  threshold           = 1
  period              = 60 # 1 minute
  evaluation_periods  = 5
  datapoints_to_alarm = 1

  tags = var.tags
}

module "k8s_cronjob_monitoring" {
  for_each = toset(local.cronjobs_names)

  source = "git::https://github.com/pagopa/interop-infra-commons//terraform/modules/k8s-workload-monitoring?ref=v1.9.0"

  env                 = var.env
  eks_cluster_name    = var.eks_cluster_name
  k8s_namespace       = var.env
  kind                = "Cronjob"
  k8s_workload_name = each.key
  sns_topics_arns     = [data.aws_sns_topic.platform_alarms.arn]

  create_performance_alarm      = false
  create_app_logs_errors_alarm  = true

  cloudwatch_app_logs_errors_metric_name      = try(data.external.cloudwatch_log_metric_filters.result.metricName, null)
  cloudwatch_app_logs_errors_metric_namespace = try(data.external.cloudwatch_log_metric_filters.result.metricNamespace, null)

  tags = var.tags
}
