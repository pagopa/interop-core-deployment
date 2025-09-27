# interop-core-deployment

## APIGW - Automated opening PR on interop-infra
In case of a pull request modifies a microservice version in
`commons/<environment>/images.yaml` for one or more the exposed services
(`api-gateway`, `authorization-server-node`, `backend-for-frontend`, `m2m-gateway`),
the apigw-automation workflow detects the updated values and opens/updates a dedicated PR
(one per affected environment) on [`interop-infra`](https://github.com/pagopa/interop-infra) repository,
updating the `terraform.tfvars` file with the new OpenAPI raw URLs.


### Mapping between exposed services and `terraform.tfvars` variables

| Service                     | Terraform variable                       |
|------------------------------|------------------------------------------|
| api-gateway                 | api_gateway_raw_url                      |
| authorization-server-node   | authorization_server_node_raw_url        |
| backend-for-frontend        | backend_for_frontend_raw_url             |
| m2m-gateway                 | m2m_gateway_raw_url                      |
