# ✅ MIGRAZIONE ARGOCD - CHECKLIST COMPLETA

**Data**: 2026-06-23
**Stato**: WIP - Piano di rilascio con TDD
**Rischio Complessivo**: HIGH (parallel deployment → cutover)
**Requisito Critico**: Zero-downtime, rollback facile a GH Actions, TDD per ogni task

---

## 📋 FASI DI MIGRAZIONE (30 Task)

### **FASE 1: Infrastructure Setup (Rischio: MEDIUM | 2-3 giorni)**

#### P1-T1 - Provisionare ALB interno + TargetGroup + TGB

**✅ Pre-Conditions**
- [ ] AWS account access (terraform state clean)
- [ ] Security groups per ALB ingress (443)
- [ ] EC2 targets tagged correctly

**✅ Success Criteria**
- ALB active in AWS console
- Target health: 2/2 Healthy
- Health check response: 200 OK
- TGB DNS resolution: < 1ms

**🔧 Automated Checks**
\`\`\`bash
terraform plan -no-color | grep -E "Create|Destroy"
aws elbv2 describe-target-health --target-group-arn <arn> | jq '.TargetHealthDescriptions | length'
aws elbv2 describe-target-health --target-group-arn <arn> | jq '.TargetHealthDescriptions[] | select(.TargetHealth.State != "healthy") | length'
\`\`\`

**🔄 Revert**: terraform destroy (RTO: 5 min)

---

#### P1-T2 - Configurare DNS interno

**✅ Success Criteria**
- DNS A record: points to ALB DNS name
- Resolution time: < 1ms
- TTL: 300s (allows quick rollback)

**🔄 Revert**: Route53 rollback (RTO: 2 min)

---

#### P1-T3 - Deploy ExternalSecrets operator

**✅ Success Criteria**
- Deployment READY: external-secrets-webhook (1/1)
- Webhook operational: /validate endpoint accessible
- ExternalSecret CRD: installed

**🔄 Revert**: helm uninstall (RTO: 5 min)

---

#### P1-T4 - Deploy ArgoCD base

**✅ Success Criteria**
- All 3 Deployments READY 1/1
- Server pod logs no CrashLoop
- Admin password set
- ArgoCD CLI connects successfully

**🔄 Revert**: helm uninstall argo-cd (RTO: 10 min)

---

#### P1-T5 - Configurare ArgoCD plugins custom

**✅ Success Criteria**
- Plugins configmap exists
- Plugin.yaml syntax valid

**🔄 Revert**: kubectl patch configmap (RTO: 3 min)

---

#### P1-T6 - Setup monitoring (Prometheus/Grafana)

**✅ Success Criteria**
- Prometheus targets ArgoCD (8083), ExternalSecrets scraped
- Grafana dashboard renders

**🔄 Revert**: Disable scrape configs (RTO: 5 min)

---

### **FASE 2: ExternalSecrets Migration (Rischio: HIGH | 3-5 giorni)**

#### P2-T1 - Audit di tutti i secrets

**✅ Success Criteria**
- secrets-audit.csv: namespace, name, type, size_kb, last_modified

---

#### P2-T2 - Creare SecretStore AWS

**✅ Success Criteria**
- SecretStore status: Ready=True
- Test ExternalSecret OK

**🔄 Revert**: kubectl delete secretstore (RTO: 3 min)

---

#### P2-T3 - Migrare secrets dev (test phase)

**✅ Success Criteria**
- ExternalSecret status: `SecretAvailable: True`
- Pod mountPath: `/etc/secrets/<name>` readable
- Pod restart count: 0
- App healthcheck: 200 OK

**⏱️ Bake Time**: 24h

**🔄 Revert**: Delete ExternalSecret + restore manifest (RTO: 5 min)

---

#### P2-T4 - Verificare funzionamento servizi dev (24h bake)

**✅ Success Criteria**
- Healthcheck passing
- No "secret not found" errors
- Pod restart count stable

**⏱️ Bake Time**: 24h

---

#### P2-T5 - Rolling migration altri ambienti

**✅ Success Criteria**
- test → qa → prod: per-env 24h bake each

**⏱️ Bake Time**: 72h+

---

#### P2-T6 - Post-migration audit secrets

**✅ Success Criteria**
- git log: 0 secrets leaked
- GitHub scanning: no alerts

---

### **FASE 3: ConfigMaps Refactoring (Rischio: MEDIUM | 2-3 giorni)**

⚠️ **BLOCCO**: Iniziare SOLO DOPO Phase 2 stabile in TUTTI gli ambienti 3-5 giorni

#### P3-T1 - Refactor commons configmaps → Helm values

**✅ Success Criteria**
- values.yaml created (ConfigMap content replicated)
- No missing keys

---

#### P3-T2 - Aggiornare Helm charts

**✅ Success Criteria**
- helm lint passes
- helm template --validate outputs clean

---

#### P3-T3 - Test in dev con ArgoCD sync-wave 0

**✅ Success Criteria**
- Configmaps sync BEFORE deployments
- No pod crashes
- ArgoCD sync completes without errors

---

#### P3-T4 - Rolling update ambienti

**✅ Success Criteria**
- test → qa → prod
- Per-env: pods READY, no restarts, 24h+ bake

---

### **FASE 4: Parallel Deployment Setup (Rischio: HIGH | 3-7 giorni)**

🚨 **REQUISITO CRITICO**: GH Actions e ArgoCD coesistono **senza conflicts**

#### P4-T1 - Creare ArgoCD Applications per dev

**✅ Success Criteria**
- argocd app list shows all apps
- App status: Healthy or Progressing

---

#### P4-T2 - Annotare risorse esistenti in dev

**✅ Success Criteria**
- All resources annotated: `argocd.argoproj.io/managed-by: knodia-dev`

\`\`\`bash
kubectl -n dev annotate deployment --all argocd.argoproj.io/managed-by=knodia-dev --overwrite
kubectl -n dev annotate service --all argocd.argoproj.io/managed-by=knodia-dev --overwrite
\`\`\`

**🔄 Revert**: Remove annotation (RTO: 2 min)

---

#### P4-T3 - Primo sync DRY-RUN

**✅ Success Criteria**
- Dry-run diff: 0 DELETIONS
- Only UPDATE/CREATE lines
- Diff report approved

\`\`\`bash
argocd app sync dev --prune=false --dry-run
argocd app diff dev > diff-report.txt
grep -c "DELETE" diff-report.txt  # Should be 0
\`\`\`

---

#### P4-T4 - Primo sync REALE con prune=false

**🧪 Test Plan**
- `argocd app sync dev --prune=false` (REAL)
- Monitor: all pods still Running
- Verify: no CrashLoopBackOff
- Verify: no "Ownership conflict" errors

**✅ Success Criteria**
- Sync status: Synced (green)
- Pod status: all RUNNING
- Pod restart count: stable
- Error events: 0 "Ownership conflict"
- Resource count: matches (no deletions)

**🔧 Automated Checks**
\`\`\`bash
argocd app sync dev --prune=false
argocd app wait dev --sync

SYNC_STATUS=$(argocd app get dev --output json | jq -r '.status.syncResult.status')
[ "$SYNC_STATUS" = "Synced" ] || exit 1

CRASH_PODS=$(kubectl get pods -n dev --field-selector=status.phase!=Running --no-headers | wc -l)
[ "$CRASH_PODS" -eq 0 ] || exit 1
\`\`\`

**⏱️ Bake Time**: 10 min

**🔄 Revert**: Delete Application + restore via kubectl (RTO: 10 min)

---

#### P4-T5 - Verificare ownership ArgoCD

**✅ Success Criteria**
- All resources owned by ArgoCD
- No orphaned manifests

---

#### P4-T6 - Test coesistenza (dual deploy)

**✅ Success Criteria**
- GH Actions + ArgoCD: no conflicts
- Only ONE version running

---

#### P4-T7 - Monitoring bake period (48-72 ore)

🚨 **CRITICAL PHASE**

**✅ Success Criteria**
- Sync success rate > 99.5%
- Pod restart rate < 0.1/day
- Drift detected: 0

**📊 Metriche (Hourly → 2x Daily)**
- sync_failures: 0/hour
- pod_restarts: 0/hour
- drift_detected: 0/hour

**✅ Hourly Checklist (first 24h)**
- [ ] Sync success rate > 99%
- [ ] Pod CrashLoopBackOff = 0
- [ ] "Ownership conflict" events = 0
- [ ] Application status = Synced
- [ ] Resource count stable

**✅ 2x Daily Checklist (24-72h)**
- [ ] Cumulative sync success > 99.5%
- [ ] Pod restart rate < 0.1/day
- [ ] Drift detections = 0
- [ ] Team: no manual issues

**🚨 ABORT CRITERIA (IMMEDIATE REVERT)**
- Sync failure rate > 1% in 1h
- Pod CrashLoopBackOff (not transient)
- "Ownership conflict" detected
- Downtime > 5 min

→ EXECUTE: `./revert-first-sync.sh`

---

### **FASE 5: Cutover & Verification (Rischio: CRITICAL | 1-2 giorni)**

#### P5-T1 - Disabilitare GH Actions deployment (canary)

**✅ Success Criteria**
- GH Actions workflow skipped per canary apps
- ArgoCD syncs successfully

---

#### P5-T2 - Monitorare 24h senza GH Actions (canary)

**✅ Success Criteria**
- Canary apps stable 24h
- Pod restart count = 0

**⏱️ Bake Time**: 24h

---

#### P5-T3 - Disabilitare GH Actions globalmente

**✅ Success Criteria**
- All GH Actions workflows disabled
- ArgoCD only

---

#### P5-T4 - Rollback plan drill

**✅ Test Plan**
- Simulare rollback completo: ArgoCD → GH Actions
- Target: < 15 min RTO

**✅ Success Criteria**
- RTO < 15 min confirmed
- Services responsive post-recovery

---

### **FASE 6: Decommission Old (Rischio: LOW | 1 giorno)**

#### P6-T1 - Archive GitHub Actions workflows

- [ ] Move to `archived/.github/workflows/`
- [ ] NON cancellarli

---

#### P6-T2 - Documentazione post-migration

- [ ] Runbook: "How to deploy with ArgoCD"
- [ ] Troubleshooting guide
- [ ] Escalation contacts
- [ ] Disaster recovery guide

---

#### P6-T3 - Training team

- [ ] 1h workshop: ArgoCD basics
- [ ] 1h hands-on: deploy service
- [ ] 80% team completion

---

## 🚨 EMERGENCY ROLLBACK (< 15 MIN)

\`\`\`bash
#!/bin/bash
# revert-all-argocd.sh - KILL SWITCH

set -e
echo "🚨 EMERGENCY ROLLBACK: ArgoCD → GH Actions"

# 1. Disable ArgoCD
kubectl patch application -n argocd -p '{"metadata":{"finalizers":[]}}' --type merge 2>/dev/null || true
kubectl delete application -n argocd --all --grace-period=5 2>/dev/null || true

# 2. Re-enable GH Actions
git restore .github/workflows/ && git push origin HEAD 2>/dev/null || true

# 3. Delete ArgoCD
kubectl delete namespace argocd external-secrets-system --ignore-not-found=true

# 4. Wait for GH Actions
echo "Waiting for pods to recover..."
for i in {1..30}; do
  RUNNING=$(kubectl get pods -n dev -o jsonpath='{.items[].status.phase}' | grep -c Running || true)
  if [ "$RUNNING" -ge 3 ]; then
    echo "✓ ROLLBACK SUCCESSFUL (RTO < 15 min)"
    exit 0
  fi
  sleep 10
done

echo "✗ Rollback timeout"
exit 1
\`\`\`

---

## 📊 GO/NO-GO DECISION MATRIX

| Fase | Gate | Owner | Criterio | Date |
|------|------|-------|----------|------|
| **P1** | Infra Setup ✅ | Infra Lead | All pods running, no errors | TBD |
| **P2-T1** | Audit completo | Secrets Lead | secrets-audit.csv created | TBD |
| **P2-T4** | 24h bake OK | On-Call | Pod restarts 0 | TBD |
| **P2-T6** | Git audit ✅ | Security | 0 secrets leaked | TBD |
| **P3** | ConfigMaps Helm ✅ | ConfigMaps Lead | Sync wave 0 OK | TBD |
| **P4-T3** | Dry-run approved | Tech Lead | 0 DELETE in diff | TBD |
| **P4-T7** | Bake 48-72h ✅ | Team | 0 failures, 0 conflicts | TBD |
| **P5-T4** | Drill successful | SRE | < 15min RTO | TBD |
| **CUTOVER** | ArgoCD solo ✅ | Tech Lead | GH Actions disabled | TBD |

---

## ⚠️ PUNTI APERTI

### **1. ArgoCD Project: Infra Repo (CONSIGLIATO)**
- Projects sono infra, non deployment logic
- Bootstrap idempotente via Terraform + Helm
- Single source of truth

### **2. Sync Policy (SPLIT CONSIGLIATO)**
- **dev/test**: auto-sync prune=false + selfHeal=true
- **qa/prod**: manual-sync

### **3. Secrets: ExternalSecrets ✅ (CONFERMATO)**
- Backend: AWS Secrets Manager
- Audit trail, rotation support
