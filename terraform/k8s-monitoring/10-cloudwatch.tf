data "external" "cloudwatch_log_metric_filters" {
  program = ["aws", "logs", "describe-metric-filters", "--log-group-name", "${var.cloudwatch_log_group_name}", "--output", "json", "--query", "metricFilters[0].metricTransformations[0].{metricName: metricName, metricNamespace: metricNamespace}"]
}