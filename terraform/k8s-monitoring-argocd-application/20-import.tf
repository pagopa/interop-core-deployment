import {
  for_each = var.argocd_workload_kind == "Deployment" ? [1] : []

  to = module.k8s_deployment_monitoring[0].aws_cloudwatch_dashboard.k8s_deployment[0]
  id = "k8s-${var.argocd_workload_name}-${var.env}"
}

import {
  for_each = var.argocd_workload_kind == "Deployment" ? [1] : []

  to = module.k8s_deployment_monitoring[0].aws_cloudwatch_metric_alarm.app_errors[0]
  id = "k8s-${var.argocd_workload_name}-errors-${var.env}"
}

import {
  for_each = var.argocd_workload_kind == "Cronjob" ? [1] : []

  to = module.k8s_cronjob_monitoring[0].aws_cloudwatch_metric_alarm.app_errors[0]
  id = "k8s-${var.argocd_workload_name}-${var.env}"
}

import {
  for_each = var.argocd_workload_kind == "Deployment" ? [1] : []

  to = module.k8s_deployment_monitoring[0].aws_cloudwatch_metric_alarm.avg_cpu[0]
  id = "k8s-${var.argocd_workload_name}-avg-cpu-${var.env}"
}

import {
  for_each = var.argocd_workload_kind == "Deployment" ? [1] : []

  to = module.k8s_deployment_monitoring[0].aws_cloudwatch_metric_alarm.avg_memory[0]
  id = "k8s-${var.argocd_workload_name}-avg-memory-${var.env}"
}

import {
  for_each = var.argocd_workload_kind == "Deployment" ? [1] : []

  to = module.k8s_deployment_monitoring[0].aws_cloudwatch_metric_alarm.readiness_pods[0]
  id = "k8s-${var.argocd_workload_name}-readiness-pods-${var.env}"
}