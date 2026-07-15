# VAL-003 (PIN-10587) - Validazione struttura generale repo

## Obiettivo

Implementare un check automatico in PR validation per intercettare prima di ArgoCD/Helm:

- path mancanti;
- `values.yaml` assenti;
- YAML malformati;
- ambienti non riconosciuti.

## Deliverable implementati

1. Script di validazione struttura repo (poi da migrare in interop-infra-commons):
   - `scripts/validation/validate-repo-structure.sh`
2. Integrazione in pipeline PR:
   - `.github/workflows/pr-validation-generic-env.yaml`
   - nuovo job `repo_structure_validation`
3. File eccezioni legacy versionato:
   - `docs/repo-structure-validation-exceptions.txt`

## Feature flag

1. `ENABLE_REPO_STRUCTURE_VALIDATION`
   - `true`: abilita il job strutturale
   - `false`: skippa il job
2. `REPO_STRUCTURE_VALIDATION_WARNING_ONLY`
   - `true`: warning-only (non blocca se job va in errore)
   - `false`: blocking mode (default consigliato a regime)
3. `ENABLE_ARGO_TEMPLATE_VALIDATION`
   - flag introdotto per i controlli sintattici/semantici dei template ArgoCD implementati ins task successivi
   - in VAL-003 e' solo tracciato in log (non applica ancora validazioni Argo template)

## Regole validate

### Commons

Per l'ambiente target (`${{ inputs.environment }}` in workflow):

- `commons/<env>/values-microservice.yaml`
- `commons/<env>/values-cronjob.yaml`
- `commons/<env>/images.yaml`
- `commons/<env>/Chart.yaml`
- `commons/<env>/configmaps/`

### Workloads

- `microservices/<name>/<env>/values.yaml`
- `jobs/<name>/<env>/values.yaml`

### Coerenza ambienti

- ogni ambiente workload deve essere riconosciuto;
- ogni ambiente workload deve avere `commons/<env>` corrispondente.

### YAML validation

- validazione sintassi YAML su tutti i file obbligatori trovati;
- annotazioni GitHub con `::error file=...::...` o `::warning ...` in warning-only.

## Eccezioni legacy

### Perche' esistono

Il meccanismo eccezioni legacy serve a evitare due estremi durante il rollout:

1. bloccare tutte le PR per debito tecnico preesistente non ancora bonificato;
2. disabilitare completamente il controllo strutturale, perdendo valore del check.

Le eccezioni permettono quindi un approccio graduale: enforcement forte sulle nuove regressioni, tolleranza esplicita e tracciata sui soli casi legacy gia' noti.

### Come funziona

Eccezioni documentate e versionate in:

- `docs/repo-structure-validation-exceptions.txt`

Formato file:

1. una riga per path (relativo alla root repo);
2. righe vuote consentite;
3. commenti consentiti con prefisso `#`.

Comportamento script:

1. se un path mancante e' presente nel file eccezioni, non viene segnalato come errore bloccante;
2. tutti i path non presenti restano soggetti a validazione standard.

### Criteri per aggiungere una eccezione

Aggiungere una nuova eccezione solo se sono vere tutte le condizioni:

1. il problema e' legacy (preesistente) e non introdotto dalla PR corrente;
2. esiste una motivazione tecnica chiara e temporanea;
3. e' pianificata una bonifica con ticket/attivita' dedicata;
4. il path e' specifico (no wildcard generiche che riducono la copertura).

### Criteri per rimuovere una eccezione

Rimuovere l'entry quando la struttura viene riallineata (file/cartella ripristinati) e verificare in PR che il check passi senza whitelist.

### Esempio

Eccezione iniziale inserita:

- `commons/dev-experimental-argocd-interop-apps-post-sync-hook/values-cronjob.yaml`

Esempio di motivazione (template suggerito in PR):

- `path`: `commons/dev-experimental-argocd-interop-apps-post-sync-hook/values-cronjob.yaml`
- `motivo`: ambiente sperimentale post-sync-hook senza cronjobs attivi
- `piano rimozione`: rimozione eccezione al riallineamento della struttura commons dell'ambiente, ad esempio introducendo un values-cronjob.yaml vuoto

## Integrazione workflow

Nel workflow `pr-validation-generic-env.yaml`:

1. nuovo job `repo_structure_validation` (dopo `actionlint`);
2. `lint` dipende da `repo_structure_validation`;
3. in caso di failure strutturale (blocking mode), il flusso si interrompe prima dei check Helm/diff;
4. in warning-only, il job annota warning ma non blocca.

## Test plan operativo

### Positivi

1. PR valida con `ENABLE_REPO_STRUCTURE_VALIDATION=true` e `REPO_STRUCTURE_VALIDATION_WARNING_ONLY=false`.
2. Verifica pass del job `repo_structure_validation`.

### Negativi controllati

1. Rimuovere `commons/<env>/images.yaml` e verificare failure con path esplicito.
2. Rimuovere `microservices/<name>/<env>/values.yaml` o `jobs/<name>/<env>/values.yaml` e verificare failure.
3. Introdurre YAML malformato in file obbligatorio e verificare failure.
4. Introdurre ambiente non riconosciuto in workload e verificare failure (o warning in warning-only).

## Success criteria coperti

1. Check eseguibile localmente: `bash scripts/validation/validate-repo-structure.sh --repo-root . --target-env dev --legacy-exceptions-file docs/repo-structure-validation-exceptions.txt`.
2. Check eseguibile in GitHub Actions via job dedicato.
3. Failure su file obbligatori mancanti.
4. Failure su YAML malformati.
5. Segnalazione su ambienti non riconosciuti.
6. Errori con path e causa tramite annotazioni GitHub.
7. Eccezioni legacy documentate e versionate.

## Revert strategy

1. Impostare `ENABLE_REPO_STRUCTURE_VALIDATION=false`.
2. In alternativa, mantenere il job attivo ma in `REPO_STRUCTURE_VALIDATION_WARNING_ONLY=true`.
3. Se necessario, revert del commit workflow/script.
