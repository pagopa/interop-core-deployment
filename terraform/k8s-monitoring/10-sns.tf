data "aws_sns_topic" "platform_alarms" {
  name = var.sns_topic_name
}

data "aws_sns_topic" "be_refactor_platform_alarms" {
  name = var.be_refactor_sns_topic_name
}