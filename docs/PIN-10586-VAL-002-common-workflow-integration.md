# VAL-002 - Integrazione workflow comune di validazione da infra-commons

## Obiettivo

Integrare in `interop-core-deployment` il workflow comune `common-deployment-values-validation.yaml` di `interop-infra-commons` per eseguire i controlli standard Interop anche su questo repository, in affiancamento ai controlli locali esistenti (Helm lint/template/kube diff).

## Scope implementato

Modifica applicata a:

- `.github/workflows/pr-validation-generic-env.yaml`

Integrazione realizzata:

1. Nuovo job riusabile `common_values_validation` che richiama:
   - `pagopa/interop-infra-commons/.github/workflows/common-deployment-values-validation.yaml@main`
2. Nuovo job `actionlint` per validare sintassi e semantica GitHub Actions su `.github/workflows/*.yaml`. Job transitorio, da rimuovere quando la pipeline sara' stabile. Consente di:
   - Trovare errori di sintassi YAML nei workflow.
   - Trovare campi GitHub Actions non validi o usati nel posto sbagliato.
   - Verificare riferimenti a job, needs, outputs, expression e context.
   - Segnalare problemi comuni su shell script negli step run.
   - Ridurre i failure “tardi” in PR, perché blocca subito config errate.
2. Feature flag di controllo esecuzione:
   - `ENABLE_COMMON_VALUES_VALIDATION == 'true'`
3. Input passati al workflow comune:
   - `environment: ${{ inputs.environment }}`
   - `infra_commons_tag: ${{ vars.INFRA_COMMONS_TAG }}`
   - `strict_kube_linter_checks: true`
4. Preservazione pipeline locale:
   - job locali di lint/template e kube diff non rimossi
   - `create_runner` resta condizionato da `ENABLE_KUBE_DIFF == 'true'`
   - `create_runner` dipende solo da `lint` locale (nessuna dipendenza dal job comune)
5. Ordine di esecuzione aggiornato:
   - `actionlint` -> `lint` locale -> percorso `kube diff` (se flag attivo)
   - `common_values_validation` (se flag attivo) eseguito in parallelo, indipendente dal percorso diff

## Analisi sovrapposizioni (common vs locale)

La valutazione delle sovrapposizioni e' stata effettuata sulla base di VAL-001 e del wiring effettivo in pipeline.

| Check | Workflow locale | Workflow comune | Classificazione |
|---|---|---|---|
| Helm lint chart (microservice/cronjob) | Si (`chart_validation`) | No (nel common non c'e' `helmLint-main.sh`) | Solo locale |
| Helm template microservices | Si (`template_microservices`) | Si (`microservices_validation`) | Sovrapposto |
| Helm template cronjobs | Si (`template_cronjobs`) | Si (`cronjobs_validation`) | Sovrapposto |
| Kube-linter su renderizzati microservices | Si (`diff_microservices`) | Si (`microservices_validation`) | Sovrapposto |
| Kube-linter su renderizzati cronjobs | Si (`diff_cronjobs`) | Si (`cronjobs_validation`) | Sovrapposto |
| Kubectl diff verso cluster | Si (`diff_microservices` / `diff_cronjobs`) | No | Solo locale |
| Validazione workflow GitHub Actions | No (prima di VAL-002) | No | Nuovo (VAL-002: `actionlint`) |

Implicazione pratica:

- l'affiancamento iniziale introduce una duplicazione controllata su template+linter (attesa e voluta in fase transitoria);
- non c'e' duplicazione su `helm lint chart` e `kubectl diff`, che restano differenzianti del percorso locale.

## Comportamento atteso

- Se `ENABLE_COMMON_VALUES_VALIDATION=true`:
  - il job `common_values_validation` viene eseguito
  - il flusso diff continua a dipendere solo da `lint` locale
- Se `ENABLE_COMMON_VALUES_VALIDATION=false`:
  - il job comune viene skippato
  - i job locali continuano a funzionare come fallback

## Compatibilita' con pre-condizioni

1. Gap analysis VAL-001: usata come baseline per VAL-002.
2. Interfaccia workflow comune: inserita utilizzando input `environment`, `infra_commons_tag`, `strict_kube_linter_checks`.
3. Strategia di affiancamento: rispettata (nessuna rimozione di controlli locali).
4. Ambiente iniziale: `dev` (derivato dall'entrypoint esistente `pr-validation-main.yaml`).
5. Feature flag: introdotta (`ENABLE_COMMON_VALUES_VALIDATION`).

## Automated checks (VAL-002)

Eseguiti localmente:

1. Verifica wiring reusable workflow:
   - presente `uses: pagopa/interop-infra-commons/.github/workflows/common-deployment-values-validation.yaml@main`
2. Verifica feature flag:
   - presente `if: ${{ vars.ENABLE_COMMON_VALUES_VALIDATION == 'true' }}`
3. Wiring `actionlint` in pipeline:
   - job `actionlint` aggiunto e messo come prerequisito del job `lint`


## Test plan operativo

### Test positivo (PR con modifica valida)

1. Impostare `ENABLE_COMMON_VALUES_VALIDATION=true`.
2. Aprire PR con modifica valida (es. update non-breaking su values).
3. Verificare che il job `common_values_validation` sia eseguito e `success`.
4. Verificare che i job locali (`lint`, eventuale `diff`) restino eseguiti senza regressioni.

### Test negativo controllato

1. Introdurre una modifica volutamente invalida su un `values.yaml` di `dev`.
2. Aprire PR con `ENABLE_COMMON_VALUES_VALIDATION=true`.
3. Verificare failure nel job `common_values_validation` con log leggibile.
4. Verificare che il failure mode sia coerente con il tipo di errore (templating/lint).

### Validazioni aggiuntive richieste

1. Verifica log PR.
2. Verifica assenza duplicazioni dannose di job (duplicazione funzionale iniziale e' attesa in fase di affiancamento).
3. Verifica che il nuovo job sia bloccante per le PR.

## Revert strategy

1. Revert rapido via flag:
   - impostare `ENABLE_COMMON_VALUES_VALIDATION=false`.
2. Revert strutturale:
   - revert commit che introduce `common_values_validation`.
3. Continuita' operativa:
   - workflow locali preesistenti restano disponibili come fallback.

## Note

- Questa attivita' copre l'integrazione del workflow comune, non i gap ArgoCD strutturali (`ApplicationSet`, `generator path`, `valueFiles`) classificati in VAL-001 come `missing`.
- Il job `actionlint` e' considerato temporaneo in fase di stabilizzazione iniziale; a regime dovra' essere rimosso dalla pipeline.