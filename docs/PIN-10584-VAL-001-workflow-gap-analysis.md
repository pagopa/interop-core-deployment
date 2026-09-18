# VAL-001 - Assessment workflow esistenti e gap analysis

## 1) Workflow analizzati

Repository locale `interop-core-deployment`:

- `.github/workflows/pr-validation-main.yaml`
- `.github/workflows/pr-validation-generic-env.yaml`
- `.github/workflows/pr-validation-sub-core-validation.yaml`
- `.github/workflows/pr-validation-sub-core-diff.yaml`

Workflow comune `interop-infra-commons`:

- `.github/workflows/common-deployment-values-validation.yaml` (branch `main`)

## 2) Copertura attuale

### 2.1 Matrice workflow locali

| Workflow | Job | Trigger | Ambiente | Comando/azione principale | Cosa valida | Cosa non valida | Dipendenze esterne |
|---|---|---|---|---|---|---|---|
| `pr-validation-main.yaml` | `start_dev_workflow` | `pull_request` (`opened`, `edited`, `reopened`, `synchronize`) | `dev` fisso | Richiama `pr-validation-generic-env.yaml` con `environment: dev` | Avvio catena di validazione su `dev` | Nessuna validazione diretta; no multi-env | Workflow riusabile locale |
| `pr-validation-main.yaml` | `diff_summary` | dopo `start_dev_workflow`, solo se `ENABLE_KUBE_DIFF=true` | `dev` | Richiama `pr-validation-sub-print-summary.yaml` | Riassunto artifact di diff | Nessun controllo di consistenza repo/manifest | Artifact GitHub |
| `pr-validation-generic-env.yaml` | `lint` | `workflow_call` | input `environment` | Richiama `pr-validation-sub-core-validation.yaml` | Delega lint/template chart | Nessun controllo ArgoCD/repo structure | Workflow riusabile locale |
| `pr-validation-generic-env.yaml` | `create_runner` | dopo `lint`, se `ENABLE_KUBE_DIFF=true` | input `environment` | Crea runner self-hosted su ECS | Infra per diff verso cluster | Nessuna validazione contenuti manifest | `pagopa/interop-github-runner-aws-create-action@main` |
| `pr-validation-generic-env.yaml` | `diff` | dopo `create_runner` | input `environment` | Richiama `pr-validation-sub-core-diff.yaml` | Delega kube-linter + kubectl diff | Nessuna validazione ArgoCD/repo structure | Workflow riusabile locale |
| `pr-validation-generic-env.yaml` | `delete_runner` | dopo `diff`, se `ENABLE_KUBE_DIFF=true` | input `environment` | Elimina runner self-hosted | Cleanup infrastruttura CI | Nessuna validazione contenuti manifest | `pagopa/interop-github-runner-aws-cleanup-action@main` |
| `pr-validation-sub-core-validation.yaml` | `chart_validation` | `workflow_call` | input `environment` | `helmLint-main.sh` su `--microservices` e `--jobs` | Helm lint chart microservice/cronjob | Nessuna validazione ArgoCD/ApplicationSet; nessuna validazione path generator | `interop-infra-commons/scripts/helm`, `INFRA_COMMONS_TAG` |
| `pr-validation-sub-core-validation.yaml` | `templating_setup` | `workflow_call` | input `environment` | `find ... */<env>/values.yaml` per liste workload | Discovery workload con `values.yaml` | Nessuna verifica naming/struttura oltre al pattern base | shell tools (`find`, `awk`, `jq`) |
| `pr-validation-sub-core-validation.yaml` | `template_microservices` | dopo `templating_setup` | input `environment` | `helmTemplate-svc-single.sh` per ogni microservice | Helm template microservices | Nessun kube-linter qui; nessuna validazione YAML generica o ArgoCD | `interop-infra-commons/scripts/helm` |
| `pr-validation-sub-core-validation.yaml` | `template_cronjobs` | dopo `templating_setup` | input `environment` | `helmTemplate-cron-single.sh` per ogni cronjob | Helm template cronjobs | Nessun kube-linter qui; nessuna validazione YAML generica o ArgoCD | `interop-infra-commons/scripts/helm` |
| `pr-validation-sub-core-diff.yaml` | `workflow_setup` | `workflow_call` | input `environment` | install kube-linter + discovery workload | Setup lint/diff per ambiente | Nessuna validazione ArgoCD/repo structure | kube-linter download + `interop-infra-commons/scripts/helm` |
| `pr-validation-sub-core-diff.yaml` | `diff_microservices` | dopo `workflow_setup` | input `environment` | `helmTemplate-svc-single.sh`, pipe a `kube-linter lint -`, poi `kubectlDiff-svc-single-standalone.sh` | kube-linter su manifest renderizzati ms; kubectl diff verso cluster | Nessuna validazione ApplicationSet/root app/valueFiles/path generator | `aws eks update-kubeconfig`, script helm commons |
| `pr-validation-sub-core-diff.yaml` | `diff_cronjobs` | dopo `workflow_setup` | input `environment` | `helmTemplate-cron-single.sh`, pipe a `kube-linter lint -`, poi `kubectlDiff-cron-single-standalone.sh` | kube-linter su manifest renderizzati cron; kubectl diff verso cluster | Nessuna validazione ApplicationSet/root app/valueFiles/path generator | `aws eks update-kubeconfig`, script helm commons |

### 2.2 Matrice workflow comune (`interop-infra-commons`)

| Workflow | Job | Trigger | Ambiente | Comando/azione principale | Cosa valida | Cosa non valida | Dipendenze esterne |
|---|---|---|---|---|---|---|---|
| `common-deployment-values-validation.yaml` | `microservices_validation` | `workflow_call` | input `environment` | discovery microservices + `helmTemplate-svc-single.sh` + `kube-linter lint` su file renderizzato | Helm template + kube-linter microservices (con opzionale strict fail) | Nessun kubectl diff; nessuna validazione ArgoCD/ApplicationSet/path/valueFiles; nessuna struttura repo avanzata | `interop-infra-commons/scripts/helm`, kube-linter |
| `common-deployment-values-validation.yaml` | `cronjobs_validation` | `workflow_call` | input `environment` | discovery cronjobs + `helmTemplate-cron-single.sh` + `kube-linter lint` su file renderizzato | Helm template + kube-linter cronjobs (con opzionale strict fail) | Nessun kubectl diff; nessuna validazione ArgoCD/ApplicationSet/path/valueFiles; nessuna struttura repo avanzata | `interop-infra-commons/scripts/helm`, kube-linter |

## 3) Gap identificati (classificazione richiesta)

Legenda:

- `covered-local`: già coperto in `interop-core-deployment`
- `covered-common`: coperto dal workflow comune di `interop-infra-commons`
- `missing`: assente
- `partial`: presente ma incompleto
- `not-applicable`: non applicabile

| Controllo richiesto | Stato | Evidenza sintetica |
|---|---|---|
| Helm lint chart microservice/cronjob | `covered-local` | `pr-validation-sub-core-validation.yaml` job `chart_validation` usa `helmLint-main.sh` su entrambe le tipologie |
| Helm template microservices | `covered-local` | `template_microservices` nel workflow locale; anche nel workflow comune |
| Helm template cronjobs | `covered-local` | `template_cronjobs` nel workflow locale; anche nel workflow comune |
| kube-linter sui manifest renderizzati | `covered-local` | presente nel job `diff_*` del workflow diff (non nel job template locale) |
| kubectl diff verso cluster | `covered-local` | presente in `pr-validation-sub-core-diff.yaml`, condizionato da `ENABLE_KUBE_DIFF` |
| Validazione sintassi YAML generica (repo/argo file) | `missing` | nessun `yamllint`/schema YAML sui manifest raw in workflow PR target |
| Validazione struttura repo (commons, `<workload>/<env>/values.yaml`, naming atteso) | `partial` | esiste discovery su pattern `*/<env>/values.yaml`, ma non una policy esplicita e fail-fast di struttura complessiva |
| Validazione manifest ArgoCD/ApplicationSet | `missing` | nessun lint/syntax/schema check sui file in `argocd/` |
| Validazione path usati dai generator ArgoCD | `missing` | nessun controllo che `directories[].path` o `files[].path` matchino path reali |
| Validazione presenza `valueFiles` referenziati dagli ApplicationSet | `missing` | nessun check dedicato sulla risoluzione di `$values/...` |
| Copertura su ambiente attualmente validato da entrypoint PR | `partial` | `pr-validation-main.yaml` invoca solo `environment: dev` (single env) |
| Template+lint centralizzati dal workflow comune | `covered-common` | il workflow comune copre template+kube-linter per ms/cj, ma non Argo structure/path/valueFiles |

## 4) Soluzione proposta

Obiettivo: integrare in `interop-core-deployment` il workflow comune `common-deployment-values-validation.yaml`, mantenendo i controlli locali necessari e aggiungendo i controlli mancanti più utili per errori ArgoCD "generici".

### Step A - Riuso workflow comune

1. Aggiungere nel flusso PR un job riusabile che chiami `common-deployment-values-validation.yaml` per `environment: dev` (e, se richiesto, estendibile ad altri env).
2. Mantenere in parallelo il percorso locale `kubectl diff` come controllo separato e opzionale (dipendente da `ENABLE_KUBE_DIFF`).

### Step B - Nuovi controlli strutturali ArgoCD/repo (principali)

1. `repo-structure-check`:
   - verifica presenza e convenzioni minime su `commons/<env>`, `microservices/*/<env>/values.yaml`, `jobs/*/<env>/values.yaml`.
   - fail esplicito con messaggi puntuali per directory/file mancanti.
2. `argocd-manifest-check`:
   - validazione YAML sintattica di `argocd/**/*.yaml`.
   - validazione minima schema/chiavi obbligatorie per `Application`/`ApplicationSet` (anche con script custom se non si introduce tool esterno).
3. `argocd-generator-path-check`:
   - estrazione path da `spec.generators[*].git.directories[].path` e `files[].path`.
   - verifica esistenza path (con supporto wildcard) nel repository.
4. `argocd-valuefiles-check`:
   - estrazione `spec.template.spec.sources[*].helm.valueFiles[]`.
   - normalizzazione `$values/...` e verifica che i file target esistano per ogni servizio/job atteso.

### Step C - Ordine job in pipeline

1. `repo-structure-check` (fail-fast)
2. `argocd-manifest-check` + `argocd-generator-path-check` + `argocd-valuefiles-check`
3. `common-deployment-values-validation` (template + kube-linter)
4. `kubectl diff` opzionale (se abilitato)

## 5) Punti aperti

1. Decidere se mantenere entrambi i percorsi di template/lint (locale + comune) o migrare gradualmente al solo comune per ridurre duplicazioni.
2. Confermare la strategia ambienti in PR: solo `dev` o matrice multi-env (almeno `dev` + env ArgoCD sperimentali più usati).
3. Definire il livello di severità kube-linter (`strict_kube_linter_checks`) in PR standard.
4. Concordare con Platform il tool preferito per lint ArgoCD (CLI ArgoCD, schema custom, o tool Kubernetes-oriented).
