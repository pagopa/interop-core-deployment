#!/bin/bash

set -e

action=$1
env=$2
shift 2
other=$@

if [ -z "$action" ]; then
  echo "Missed action: init, apply, plan"
  exit 0
fi

if [ -z "$env" ]; then
  echo "env should be: dev, uat or prod."
  exit 0
fi

function tf_summarize() {
  local plan_file="tfplan-$(date +'%Y%m%d-%H%M%S')"

  echo "Running terraform plan and tf-summarize..."
  terraform plan -out="${plan_file}" -var-file="./env/$env/terraform.tfvars" > /dev/null

  set +e # don't stop on failure so that we can cleanup plan_file
  if [ -n "$(command -v tf-summarize)" ]; then
    tf-summarize ${other:+"$other"} "${plan_file}"
  else
    echo "tf-summarize binary not found"
    exit 1
  fi

  rm "$plan_file"
  set -e
}

function target_action() {
  local target_files="$@"
  local tf_targets=()


  if [[ -z $target_files ]]; then
    echo "Missing target files argument"
    exit 1
  fi

  for file in $target_files; do
    if [ ! -f "$file" ]; then
      echo "File $file not found."
      exit 1
    fi
  done

  local temp_file=$(mktemp)
  for file in $target_files; do
    set +e
    grep -E '^resource|^module|^data' $file >> $temp_file
    set -e
  done

  local resource_type
  local module_name
  local resource_class
  local resource_name

  while read -r line ; do
    resource_type=$(echo $line | cut -d '"' -f 1 | tr -d ' ')
    if [ "$resource_type" == "module" ]; then
        module_name=$(echo $line | cut -d '"' -f 2)
        tf_targets+=("-target=module.$module_name ")
    elif [ "$resource_type" == "data" ]; then
        resource_class=$(echo $line | cut -d '"' -f 2)
        resource_name=$(echo $line | cut -d '"' -f 4)
        tf_targets+=("-target=data.$resource_class.$resource_name ")
    else
        resource_class=$(echo $line | cut -d '"' -f 2)
        resource_name=$(echo $line | cut -d '"' -f 4)
        tf_targets+=("-target=$resource_class.$resource_name ")
    fi
  done < $temp_file

  rm $temp_file

  printf '%s\n' "${tf_targets[@]}"
  terraform $action -var-file="./env/$env/terraform.tfvars" "${tf_targets[@]}"
}

if echo "init plan apply refresh import output state taint destroy summ" | grep -w $action > /dev/null; then
  if [ $action = "init" ]; then
    terraform $action -backend-config="./env/$env/backend.tfvars" $other
  elif [ $action = "output" ] || [ $action = "state" ] || [ $action = "taint" ]; then
    # init terraform backend
    terraform init -reconfigure -backend-config="./env/$env/backend.tfvars"
    terraform $action $other
  elif [ $action = "summ" ]; then
    terraform init -reconfigure -backend-config="./env/$env/backend.tfvars"
    tf_summarize
  elif [[ $action =~ plan|apply|destroy ]] && [[ $other =~ ^-target-files[[:space:]] ]]; then
    terraform init -reconfigure -backend-config="./env/$env/backend.tfvars"
    shift 1
    target_action "$@"
  else
    # init terraform backend
    terraform init -reconfigure -backend-config="./env/$env/backend.tfvars"
    terraform $action -var-file="./env/$env/terraform.tfvars" $other
  fi
else
    echo "Action not allowed."
    exit 1
fi
