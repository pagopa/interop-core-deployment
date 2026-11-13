import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { crc32 } from 'node:zlib';
import { fail, field, keys, mapping, parseOptions, paths, readSourceConfigMap, scalarText, SourceConfigMapError, sourceConfigMapFiles, yamlDocument, type SourceConfigMap } from './common.js';
import { extractReportDir, writePhaseReport, type ReportRow, type StatusDefinition } from './phase-report.js';

type ChecksumMode = 'crc32' | 'sha256';

const DEFINITIONS: Record<string, StatusDefinition> = {
  MATCH: { severity: 'ok', description: 'Checksum of the migration in the generated values file matches the source ConfigMap.' },
  MISMATCH: { severity: 'critical', description: 'Checksum differs between source ConfigMap and generated values file; Flyway would detect a modified migration.' },
  MISSING_IN_GENERATED: { severity: 'critical', description: 'Migration key exists in the source ConfigMap but not in the generated values file.' },
  UNEXPECTED_IN_GENERATED: { severity: 'critical', description: 'Migration key exists in the generated values file but not in the source ConfigMap.' },
  INVALID_VALUE: { severity: 'critical', description: 'Source or generated migration value is not a string.' },
  MISSING_GENERATED_FILE: { severity: 'critical', description: 'The generated migration values file for this ConfigMap does not exist in commons/<env>/migrations; run the generate phase.' },
  INVALID_CONFIGMAP: { severity: 'critical', description: 'Source file is not a valid ConfigMap (kind or metadata.name).' },
  DUPLICATE_CONFIGMAP: { severity: 'critical', description: 'Another source file declares the same metadata.name.' },
  INVALID_DATA: { severity: 'critical', description: 'Source data or the generated migrations mapping for this ConfigMap is not a YAML mapping.' },
  NO_MIGRATIONS: { severity: 'critical', description: 'Source ConfigMap has no migration keys.' },
  NO_SOURCE: { severity: 'critical', description: 'No flyway*.yaml/yml ConfigMap was found in commons/<env>/configmaps.' },
  DIRECTORY_MISSING: { severity: 'critical', description: 'commons/<env>/configmaps or commons/<env>/migrations does not exist.' },
  UNEXPECTED_GENERATED_FILE: { severity: 'critical', description: 'Generated YAML file has no corresponding source filename <metadata.name>.yaml.' },
  UNEXPECTED_GENERATED_DOMAIN: { severity: 'critical', description: 'Generated domain has no validated source ConfigMap with that metadata.name.' },
  MISPLACED_GENERATED_DOMAIN: { severity: 'critical', description: 'Known domain is defined outside its expected <metadata.name>.yaml file.' },
  DUPLICATE_GENERATED_DOMAIN: { severity: 'critical', description: 'Domain is defined in multiple generated files; Helm would merge or overwrite its values.' },
  INVALID_GENERATED_FILE: { severity: 'critical', description: 'Generated YAML is invalid or does not contain only a root migrations mapping with domain mappings.' },
};
const COLUMNS = ['configMap', 'key', 'sourceChecksum', 'generatedChecksum', 'sourceFile', 'targetFile'];

function checksum(value: string, mode: ChecksumMode): string | number {
  const raw = `${value}\n`;
  
  if (mode === 'sha256') 
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  
  // CRC32 requires removing BOM (Byte-Order-Mark) and newlines before computing the checksum
  if (mode === 'crc32') 
    return crc32(raw.replace(/^\uFEFF/, '').replace(/[\r\n]/g, '')) | 0;
  
  throw new Error(`Unsupported checksum mode: ${String(mode)}`);
}

export function verify(mode: ChecksumMode, rawArgs: string[]): void {
  const { reportDir, args } = extractReportDir(rawArgs);
  let scriptName = null;
  switch (mode) {
    case 'crc32':
      scriptName = 'verify-flyway-migration-crc32';
      break;
    case 'sha256':
      scriptName = 'verify-flyway-migration-sha256';
      break;
    default:
      throw new Error(`Unsupported checksum mode: ${String(mode)}`);
  }

  const options = parseOptions(args);
  if (options.help) {
    console.log(`Verify ${mode === 'sha256' ? 'SHA-256 hashes' : mode === 'crc32' ? 'Flyway CRC32 checksums' : 'unknown checksums'} between ConfigMaps and generated values.

Usage: npm run ${mode === 'sha256' ? 'verify:sha256' : mode === 'crc32' ? 'verify:crc32' : '?'} -- --root <project_root> --environment <environment> [--report-dir <dir>]
Requires: Node.js >=22.2.0; npm ci in scripts/migrations/flyway.
Expected layout: commons/<environment>/configmaps/flyway*.yaml (or .yml)
                 commons/<environment>/migrations/<metadata.name>.yaml`);
    return;
  }

  const rows: ReportRow[] = [];
  const writeReport = () => writePhaseReport(reportDir, `verify-${mode}-${options.environment}`, {
    phase: `verify-${mode}`, environment: options.environment, root: options.root, definitions: DEFINITIONS, columns: COLUMNS, rows,
  });
  const directories = paths(options);
  for (const directory of [directories.configmaps, directories.migrations]) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      rows.push({ status: 'DIRECTORY_MISSING', detail: `Directory not found: ${relative(options.root, directory)}` });
      writeReport();
      fail(`Directory not found: ${directory}`);
    }
  }

  let examined = 0;
  let checked = 0;
  const errors: string[] = [];
  const seen = new Set<string>();
  const sourceFiles = sourceConfigMapFiles(directories.configmaps);
  const sources: SourceConfigMap[] = [];

  for (const sourceFile of sourceFiles) {
    examined += 1;
    const sourceLabel = relative(options.root, sourceFile);
    let source: SourceConfigMap;
    try {
      source = readSourceConfigMap(sourceFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      rows.push({ status: error instanceof SourceConfigMapError ? error.code : 'FATAL_ERROR', sourceFile: sourceLabel, detail: message });
      continue;
    }
    const configmapName = source.name;
    if (seen.has(configmapName)) {
      errors.push(`Duplicate source ConfigMap metadata.name '${configmapName}'.`);
      rows.push({ status: 'DUPLICATE_CONFIGMAP', configMap: configmapName, sourceFile: sourceLabel, detail: errors.at(-1)! });
      continue;
    }
    seen.add(configmapName);
    sources.push(source);
  }

  const generated = new Map<string, ReturnType<typeof yamlDocument>>();
  const domainFiles = new Map<string, string>();
  for (const filename of readdirSync(directories.migrations).sort()) {
    const targetFile = join(directories.migrations, filename);
    if (!/\.ya?ml$/.test(filename) || !statSync(targetFile).isFile()) continue;
    const targetLabel = relative(options.root, targetFile);
    const add = (status: string, detail: string, configMap = '') => {
      errors.push(detail);
      rows.push({ status, targetFile: targetLabel, configMap, detail });
    };
    if (!sources.some(source => filename === `${source.name}.yaml`)) {
      add('UNEXPECTED_GENERATED_FILE', `${targetLabel}: no source generates this filename (expected <metadata.name>.yaml).`);
    }
    let document: ReturnType<typeof yamlDocument>;
    try {
      document = yamlDocument(targetFile);
    } catch (error) {
      add('INVALID_GENERATED_FILE', error instanceof Error ? error.message : String(error));
      continue;
    }
    const migrations = field(document.contents, 'migrations');
    if (!mapping(document.contents) || keys(document.contents).some(key => key !== 'migrations') || !mapping(migrations)) {
      add('INVALID_GENERATED_FILE', `${targetLabel}: expected only a root migrations mapping.`);
      continue;
    }
    generated.set(targetFile, document);
    for (const domain of keys(migrations)) {
      if (!seen.has(domain)) add('UNEXPECTED_GENERATED_DOMAIN', `${targetLabel}: domain '${domain}' has no source ConfigMap.`, domain);
      else if (filename !== `${domain}.yaml`) add('MISPLACED_GENERATED_DOMAIN', `${targetLabel}: domain '${domain}' belongs in ${domain}.yaml.`, domain);
      const previous = domainFiles.get(domain);
      if (previous) add('DUPLICATE_GENERATED_DOMAIN', `${targetLabel}: domain '${domain}' is also defined in ${previous}.`, domain);
      else domainFiles.set(domain, targetLabel);
      if (!mapping(field(migrations, domain))) add('INVALID_GENERATED_FILE', `${targetLabel}: migrations.${domain} must be a mapping.`, domain);
    }
  }

  for (const source of sources) {
    const configmapName = source.name;
    const sourceLabel = relative(options.root, source.file);
    // Determine the corresponding target migration file.
    const targetFile = join(directories.migrations, `${configmapName}.yaml`);
    const targetLabel = relative(options.root, targetFile);
    const location = { configMap: configmapName, sourceFile: sourceLabel, targetFile: targetLabel };
    if (!existsSync(targetFile)) {
      errors.push(`Missing generated file: ${targetLabel}`);
      rows.push({ status: 'MISSING_GENERATED_FILE', ...location, detail: errors.at(-1)! });
      continue;
    }

    // Extract target data for comparison; source data was validated by readSourceConfigMap.
    const document = generated.get(targetFile);
    if (!document) continue;
    const targetData = field(field(document.contents, 'migrations'), configmapName);
    if (!mapping(targetData)) {
      errors.push(`${configmapName}: generated migrations must be a YAML mapping.`);
      rows.push({ status: 'INVALID_DATA', ...location, detail: errors.at(-1)! });
      continue;
    }

    // Create sets of source and target migration names for comparison.
    const sourceKeys = Object.keys(source.data).sort();
    const targetKeys = keys(targetData);
    const sourceSet = new Set(sourceKeys);
    const targetSet = new Set(targetKeys);
    for (const migrationName of sourceKeys) {
      if (!migrationName && mode === 'crc32') continue;
      if (!targetSet.has(migrationName)) {
        errors.push(`${configmapName}: missing migration '${migrationName}'.`);
        rows.push({ status: 'MISSING_IN_GENERATED', ...location, key: migrationName, detail: errors.at(-1)! });
        continue;
      }
      const sourceValue = source.data[migrationName];
      const targetValue = scalarText(field(targetData, migrationName));
      if (sourceValue === undefined || targetValue === undefined) {
        errors.push(`${configmapName}/${migrationName}: both migration values must be strings.`);
        rows.push({ status: 'INVALID_VALUE', ...location, key: migrationName, detail: errors.at(-1)! });
        continue;
      }
      const sourceHash = checksum(sourceValue, mode);
      const targetHash = checksum(targetValue, mode);
      checked += 1;
      const checksums = { key: migrationName, sourceChecksum: sourceHash, generatedChecksum: targetHash };
      if (sourceHash !== targetHash) {
        errors.push(`${configmapName}/${migrationName}: ${mode === 'sha256' ? 'SHA-256' : 'Flyway checksum'} mismatch (source=${sourceHash}, generated=${targetHash}).`);
        rows.push({ status: 'MISMATCH', ...location, ...checksums, detail: errors.at(-1)! });
      } else {
        rows.push({ status: 'MATCH', ...location, ...checksums, detail: `${mode === 'sha256' ? 'SHA-256' : 'Flyway CRC32 checksum'} ${sourceHash} identical in source and generated file.` });
        console.log(`MATCH - ${configmapName}/${migrationName} ${mode === 'sha256' ? 'sha256' : 'checksum'}=${sourceHash}`);
      }
    }
    for (const migrationName of targetKeys) {
      if (!migrationName && mode === 'crc32') continue;
      if (!sourceSet.has(migrationName)) {
        errors.push(`${configmapName}: unexpected migration '${migrationName}'.`);
        rows.push({ status: 'UNEXPECTED_IN_GENERATED', ...location, key: migrationName, detail: errors.at(-1)! });
      }
    }
  }

  if (examined === 0) {
    errors.push(`No flyway ConfigMaps found in ${directories.configmaps}.`);
    rows.push({ status: 'NO_SOURCE', detail: errors.at(-1)! });
  }
  writeReport();
  console.log(`\nSUMMARY - ${examined} ConfigMap(s), ${checked} migration(s) compared, ${errors.length} error(s).`);
  if (errors.length > 0) {
    console.error(`Errors found:\n${errors.map(error => `ERROR - ${error}`).join('\n')}`);
    fail(`Verification completed with ${errors.length} error(s).`);
  }
  console.log(`SUCCESS - Verified ${checked} ${mode === 'sha256' ? 'SHA-256 hashes' : 'Flyway checksum(s)'} in ${examined} ConfigMap(s) for environment '${options.environment}'.`);
}
