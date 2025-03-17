data "aws_sns_topic" "platform_alarms" {
  name = var.sns_topic_name
}