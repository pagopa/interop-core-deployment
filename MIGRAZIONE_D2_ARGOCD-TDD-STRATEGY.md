# 🧪 MIGRAZIONE ARGOCD - TEST-DRIVEN DEPLOYMENT STRATEGY

**Data**: 2026-06-23
**Paradigma**: Test-First + Revert-Ready per ogni task
**Produzione**: Zero-downtime, Fully Reversible

---

## 📋 PRINCIPI TDD

Ogni task segue questo flow:

\`\`\`
1. PRE-CONDITIONS (cosa deve essere vero)
2. TEST PLAN (come verifichiamo)
3. SUCCESS CRITERIA (metriche concrete)
4. AUTOMATED CHECKS (script bash/kubectl)
5. MANUAL VERIFICATION (sguardo umano)
6. BAKE TIME (tempo osservazione)
7. REVERT STRATEGY (rollback script)
\`\`\`

---

## 🎯 ESEMPIO: P1-T1 (ALB)

### ✅ PRE-CONDITIONS
- AWS account access (terraform state clean)
- Security group per ALB ingress 443
- EC2 targets tagged

### 🧪 TEST PLAN
1. terraform plan → no deletions
2. ALB 2/2 targets healthy
3. TGB DNS risolve
4. Health check 200 OK

### ✅ SUCCESS CRITERIA
- ALB active + 2/2 Healthy
- Health check: 200 OK
- DNS: < 1ms

### 🔧 AUTOMATED CHECKS
\`\`\`bash
aws elbv2 describe-target-health --target-group-arn <arn> | \
  jq '.TargetHealthDescriptions[] | select(.TargetHealth.State != "healthy") | length'  # 0
\`\`\`

### 👀 MANUAL VERIFICATION
\`\`\`bash
kubectl run debug --image=curlimages/curl -it -- \
  curl -I https://argocd.internal.dev.pagopa.it/
# Expected: HTTP 200 or 302
\`\`\`

### ⏱️ BAKE TIME: 5 min

### 🔄 REVERT STRATEGY
\`\`\`bash
# revert-alb.sh
terraform plan -destroy && terraform apply -destroy
aws elbv2 describe-load-balancers --names argocd-alb 2>&1 | grep "not found"
\`\`\`
**RTO**: 5 min | **Risk**: ALB orphaned (no pod impact)

---

## 🧪 FASE 2-T3: Migrare secrets dev

### ✅ PRE-CONDITIONS
- [ ] SecretStore in AWS ready (P2-T2)
- [ ] 2-3 servizi non-critici identificati
- [ ] AWS Secrets Manager secrets creati

### 🧪 TEST PLAN
1. Create ExternalSecret YAML
2. kubectl apply
3. Status: SecretAvailable=True
4. Pod monta secret
5. App non crasha

### ✅ SUCCESS CRITERIA
- ExternalSecret status: `SecretAvailable: True`
- Pod mount: `/etc/secrets/<name>` readable
- Pod restarts: 0
- App healthcheck: 200 OK
- Logs: zero "secret not found"

### 🔧 AUTOMATED CHECKS
\`\`\`bash
SERVICE=$1
kubectl get externalsecret -n dev $SERVICE-secret || exit 1

STATUS=$(kubectl get externalsecret -n dev $SERVICE-secret \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
[ "$STATUS" = "True" ] || exit 1

POD=$(kubectl get pod -n dev -l app=$SERVICE -o name | head -1)
kubectl exec $POD -- curl -s http://localhost:8080/health | jq -r '.status' | grep -q UP || exit 1
\`\`\`

### ⏱️ BAKE TIME: 24h

### 🔄 REVERT STRATEGY
\`\`\`bash
# revert-secrets-dev.sh
kubectl delete externalsecret -n dev $SERVICE-secret
git show HEAD:microservices/$SERVICE/dev/secrets.yaml | kubectl apply -f -
kubectl rollout restart deployment -n dev $SERVICE
kubectl rollout status deployment/$SERVICE -n dev --timeout=2m
\`\`\`
**RTO**: 5 min | **Risk**: Pod restart (~30s downtime)

---

## 🚀 FASE 4-T7: BAKE PERIOD (48-72 ore)

**CRITICAL PHASE - No manual interventions**

### 📊 Prometheus Metrics (Every Hour)

\`\`\`bash
sync_failures=$(curl -s 'http://prometheus:9090/api/v1/query?query=increase(argocd_app_sync_total{dest_namespace="dev",phase="Failed"}[1h])')
# Target: 0 failures/hour

pod_restarts=$(curl -s 'http://prometheus:9090/api/v1/query?query=increase(kube_pod_container_status_restarts_total{namespace="dev"}[1h])')
# Target: 0 restarts/hour

drift_detected=$(curl -s 'http://prometheus:9090/api/v1/query?query=increase(argocd_app_sync_total{dest_namespace="dev",phase="OutOfSync"}[1h])')
# Target: 0 drifts/hour
\`\`\`

### ✅ HOURLY CHECKLIST (first 24h)
- [ ] Sync success rate > 99%
- [ ] Pod CrashLoopBackOff = 0
- [ ] "Ownership conflict" events = 0
- [ ] Application status = Synced (green)
- [ ] Resource count stable

### ✅ 2x DAILY CHECKLIST (24-72h)
- [ ] Cumulative sync success > 99.5%
- [ ] Pod restart rate < 0.1/day
- [ ] Drift detections = 0
- [ ] Team: no manual issues
- [ ] Load tests passing

### 🚨 ABORT CRITERIA (IMMEDIATE REVERT)
\`\`\`
- Sync failure rate > 1% in 1h
- Pod CrashLoopBackOff (not transient)
- "Ownership conflict" detected
- Data loss or corruption
- Service downtime > 5 min

→ EXECUTE: ./revert-first-sync.sh (P4-T4 revert)
\`\`\`

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

# 4. Wait for recovery
echo "Waiting for pods to recover via GH Actions..."
for i in {1..30}; do
  RUNNING=$(kubectl get pods -n dev -o jsonpath='{.items[].status.phase}' | grep -c Running || true)
  if [ "$RUNNING" -ge 3 ]; then
    echo "✓ ROLLBACK SUCCESSFUL (RTO < 15 min)"
    exit 0
  fi
  sleep 10
done

echo "✗ Rollback timeout - manual intervention needed"
exit 1
\`\`\`

---

## 📋 TASK MATRIX - TDD SUMMARY

| Phase | Task | Pre | Test | Success | Revert | RTO |
|-------|------|-----|------|---------|--------|-----|
| P1 | ALB | Terraform | plan | 2/2 healthy | destroy | 5m |
| P1 | DNS | ALB | dig | <1ms TTL | Route53 | 2m |
| P1 | ES | K8s | webhook | CRD installed | uninstall | 5m |
| P1 | ArgoCD | ES | pods | server running | uninstall | 10m |
| P2 | Audit | kubectl | list | CSV created | N/A | N/A |
| P2 | SecretStore | AWS | auth | Ready=True | delete | 3m |
| P2 | Dev secrets | Store | mount | mounted OK | restore | 5m |
| P2 | Bake 24h | mounted | health | no restarts | rollback | 5m |
| P2 | All envs | bake OK | per-env | stable | per-env | 10m |
| P2 | Audit git | migrated | scan | 0 leaked | filter-branch | 10m |
| P3 | Helm values | P2 done | diff | equivalent | keep fallback | 2m |
| P3 | Chart | values | lint | clean | git revert | 2m |
| P3 | Sync wave | chart | pod | no crashes | helm rollback | 5m |
| P3 | Rolling | dev OK | per-env | stable | per-env | 10m |
| P4 | Apps | ArgoCD | list | all apps | delete | 5m |
| P4 | Annotate | apps | grep | all tagged | remove | 2m |
| P4 | Dry-run | tagged | diff | 0 DELETE | N/A | N/A |
| P4 | Real sync | approved | sync | Synced | delete app | 10m |
| P4 | Ownership | sync done | check | ArgoCD owns | cleanup | 5m |
| P4 | Coexist | verified | dual | no conflicts | disable one | 5m |
| P4 | Bake 48-72h | coexist | monitor | 0 failures | revert sync | 10m |
| P5 | Canary | P4 done | skip GH | ArgoCD only | re-enable | 5m |
| P5 | Canary 24h | disabled | health | stable 24h | re-enable | 5m |
| P5 | Global | canary OK | disable all | ArgoCD only | re-enable | 5m |
| P5 | Drill | disabled | <15min RTO | success | DRILL | 15m |
| P6 | Archive | cutover | move | archived/ | restore | 5m |
| P6 | Docs | archived | PR | approved | N/A | N/A |
| P6 | Training | docs | quiz | 80% pass | N/A | N/A |

---

## ✅ PRINCIPI TDD PER PRODUZIONE

- ✅ **Test-First**: prima i test, poi l'implementazione
- ✅ **Revert-Ready**: ogni task ha script revert
- ✅ **Bake-Time**: osserviamo il comportamento
- ✅ **Zero-Downtime**: nessun outage
- ✅ **Go/No-Go**: decisioni esplicite
