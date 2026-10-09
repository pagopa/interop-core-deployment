import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { crc32 } from 'node:zlib';
import { fail, field, files, keys, mapping, parseOptions, paths, scalarText, yamlDocument } from './common.js';

type ChecksumMode = 'crc32' | 'sha256';

function checksum(value: string, mode: ChecksumMode): string | number {
  const raw = `${value}\n`;
  
  if (mode === 'sha256') 
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  
  // CRC32 requires removing BOM (Byte-Order-Mark) and newlines before computing the checksum
  if (mode === 'crc32') 
    return crc32(raw.replace(/^\uFEFF/, '').replace(/[\r\n]/g, '')) | 0;
  
  throw new Error(`Unsupported checksum mode: ${String(mode)}`);
}

export function verify(mode: ChecksumMode, args: string[]): void {
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

Usage: npm run ${mode === 'sha256' ? 'verify:sha256' : mode === 'crc32' ? 'verify:crc32' : '?'} -- --root <project_root> --environment <environment>
Requires: Node.js >=22.2.0; npm ci in scripts/migrations/node.
Expected layout: commons/<environment>/configmaps/flyway*.yaml (or .yml)
                 commons/<environment>/migrations/<metadata.name>.yaml`);
    return;
  }

  const directories = paths(options);
  for (const directory of [directories.configmaps, directories.migrations]) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) fail(`Directory not found: ${directory}`);
  }

  let examined = 0;
  let checked = 0;
  const errors: string[] = [];
  const seen = new Set<string>();
  const sourceFiles = files(directories.configmaps, /^flyway.*\.ya?ml$/);

  for (const sourceFile of sourceFiles) {
    examined += 1;
    const source = yamlDocument(sourceFile).contents;
    const kind = scalarText(field(source, 'kind')) ?? '';
    const configmapName = scalarText(field(field(source, 'metadata'), 'name')) ?? '';
    const sourceLabel = relative(options.root, sourceFile);
    if (kind !== 'ConfigMap' || !configmapName || configmapName === '.' || configmapName === '..' || configmapName.includes('/')) {
      errors.push(`Invalid ConfigMap kind or metadata.name in ${sourceLabel}.`);
      continue;
    }
    if (seen.has(configmapName)) {
      errors.push(`Duplicate source ConfigMap metadata.name '${configmapName}'.`);
      continue;
    }
    seen.add(configmapName);

    // Determine the corresponding target migration file.
    const targetFile = join(directories.migrations, `${configmapName}.yaml`);
    if (!existsSync(targetFile)) {
      errors.push(`Missing generated file: ${relative(options.root, targetFile)}`);
      continue;
    }

    // Extract source and target data for comparison.
    const sourceData = field(source, 'data');
    const targetData = field(field(yamlDocument(targetFile).contents, 'migrations'), configmapName);
    if (!mapping(sourceData) || !mapping(targetData)) {
      errors.push(`${configmapName}: source data and generated migrations must be YAML mappings.`);
      continue;
    }

    // Create sets of source and target migration names for comparison.
    const sourceKeys = keys(sourceData);
    const targetKeys = keys(targetData);
    const sourceSet = new Set(sourceKeys);
    const targetSet = new Set(targetKeys);
    if (mode === 'sha256' && sourceKeys.length === 0) {
      errors.push(`${configmapName}: no migrations in source data.`);
      continue;
    }

    for (const migrationName of sourceKeys) {
      if (!migrationName && mode === 'crc32') continue;
      if (!targetSet.has(migrationName)) {
        errors.push(`${configmapName}: missing migration '${migrationName}'.`);
        continue;
      }
      const sourceValue = scalarText(field(sourceData, migrationName));
      const targetValue = scalarText(field(targetData, migrationName));
      if (sourceValue === undefined || targetValue === undefined) {
        errors.push(`${configmapName}/${migrationName}: both migration values must be strings.`);
        continue;
      }
      const sourceHash = checksum(sourceValue, mode);
      const targetHash = checksum(targetValue, mode);
      checked += 1;
      if (sourceHash !== targetHash) {
        errors.push(`${configmapName}/${migrationName}: ${mode === 'sha256' ? 'SHA-256' : 'Flyway checksum'} mismatch (source=${sourceHash}, generated=${targetHash}).`);
      } else {
        console.log(`MATCH - ${configmapName}/${migrationName} ${mode === 'sha256' ? 'sha256' : 'checksum'}=${sourceHash}`);
      }
    }
    for (const migrationName of targetKeys) {
      if (!migrationName && mode === 'crc32') continue;
      if (!sourceSet.has(migrationName)) errors.push(`${configmapName}: unexpected migration '${migrationName}'.`);
    }
  }

  if (examined === 0) errors.push(`No flyway ConfigMaps found in ${directories.configmaps}.`);
  console.error(`SUMMARY - ${examined} ConfigMap(s), ${checked} migration(s) compared, ${errors.length} error(s).`);
  if (errors.length > 0) {
    console.error(`Errors found:\n${errors.map(error => `ERROR - ${error}`).join('\n')}`);
    fail(`Verification completed with ${errors.length} error(s).`);
  }
  console.log(`SUCCESS - Verified ${checked} ${mode === 'sha256' ? 'SHA-256 hashes' : 'Flyway checksum(s)'} in ${examined} ConfigMap(s) for environment '${options.environment}'.`);
}