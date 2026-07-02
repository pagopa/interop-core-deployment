# External Secrets Lister

Script Node.js per elencare tutti gli `externalSecrets` definiti nei `values.yaml` di microservices e jobs per un ambiente specifico.

## Installazione

```bash
npm install js-yaml
```

## Utilizzo

```bash
node list-external-secrets.js <env> <project-root-path>
```

### Parametri

- `<env>`: L'ambiente da cercare (es. `dev-experimental-argocd-interop-apps-post-sync-hook`)
- `<project-root-path>`: Il percorso root del progetto (es. `/Users/manuelm/Documents/repo/PagoPA/Interop/interop-core-deployment`)

### Esempio

```bash
node list-external-secrets.js dev-experimental-argocd-interop-apps-post-sync-hook /Users/manuelm/Documents/repo/PagoPA/Interop/interop-core-deployment
```

## Output

Lo script:
1. **Scansiona** tutte le directory in `microservices/` e `jobs/`
2. **Cerca** `values.yaml` dentro le directory corrispondenti all'environment
3. **Estrae** tutti gli `externalSecrets.data[]` con i loro parametri:
   - `secretKey`
   - `remoteRef.key`
   - `remoteRef.property`
   - `remoteRef.version`
   - `remoteRef.conversionStrategy`
   - `remoteRef.decodingStrategy`
4. **Mostra** i risultati in formato tabellare
5. **Esporta** un CSV con tutti i dati trovati

## Struttura cercata

Lo script cerca file YAML con questa struttura:

```yaml
externalSecrets:
  data:
    - secretKey: username
      remoteRef:
        key: /path/to/secret
        property: username
        version: v1
        conversionStrategy: Default
        decodingStrategy: None
    - secretKey: password
      remoteRef:
        key: /path/to/secret
        property: password
        version: v1
```

## Note

- Il CSV di output viene salvato nella cartella root con il nome: `external-secrets-{env}.csv`
- Se non trova alcun secret, mostra un avviso
- Gestisce gli errori di parsing YAML in modo robusto
