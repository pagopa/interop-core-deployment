## k8s-monitoring-argocd-application
This Terraform configuration is used by ArgoCD Jobs with PostSync hooks in order to manage CloudWatch alarms and dashboards.<br>
Specifically, each Job clones this repo, exports the required Terraform variabiles (<code>TF_VAR_argocd_workload_kind</code> and <code>TF_VAR_argocd_workload_name</code>), initializes the Terraform state and performs a terraform apply.


## How to perform a Terraform plan/apply locally for testing purposes?
Suppose you want to simulate the PostSync Job for the <code>interop-be-m2m-gateway-v3</code> ArgoCD application in the <code>dev</code> environment.<br>
Run the following commands:<br>

```
export ENV="dev"
export TF_VAR_argocd_workload_name="interop-be-m2m-gateway-v3"
export TF_VAR_argocd_workload_kind="Deployment"

terraform init \
-backend-config="./env/${ENV}/backend.tfvars" \
-backend-config="key=${ENV}-es1/interop-core-deployment/argocd-applications/monitoring/${TF_VAR_argocd_workload_name}.tfstate"

terraform plan -var-file="./env/${ENV}/terraform.tfvars"
```