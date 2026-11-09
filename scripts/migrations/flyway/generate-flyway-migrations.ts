import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fail, field, files, mapping, parseOptions, paths, scalarText, yamlDocument } from './common.js';
import { extractReportDir, writePhaseReport, type ReportRow, type StatusDefinition } from './phase-report.js';

const usage = `Generate Flyway migration values from Kubernetes ConfigMaps.

Usage: npm run generate -- --root <project_root> --environment <environment> [--prune] [--report-dir <dir>]
Options: -r, --root   Absolute project root
         -e, --environment   Environment under commons/
         -p, --prune  Remove unmatched YAML files in migrations/
         --report-dir <dir>  Write generate-<env>.{json,csv} reports into <dir>
         -h, --help   Show this help
Requires: Node.js >=22.2.0; npm ci in scripts/migrations/flyway.
`;

function rawData(source: string, name: string): string {
  const lines = source.split('\n');
  if (source.endsWith('\n')) lines.pop();
  
  const dataIndex = lines.findIndex(line => line.startsWith('data:'));
  if (dataIndex < 0) fail('top-level data: key not found.');

  const content: string[] = [];
  for (const line of lines.slice(dataIndex + 1)) {
    if (line && !/^\s/.test(line)) break;
    content.push(/\S/.test(line) ? `  ${line}` : '');
  }
  
  return `migrations:\n  ${name}:\n${content.map(line => `${line}\n`).join('')}`;
}

const DEFINITIONS: Record<string, StatusDefinition> = {
  CREATED: { severity: 'ok', description: 'Migration values file did not exist and has been created from the ConfigMap.' },
  UPDATED: { severity: 'ok', description: 'Migration values file existed with different content and has been overwritten from the ConfigMap.' },
  UNCHANGED: { severity: 'ok', description: 'Migration values file already matched the ConfigMap; rewritten with identical content.' },
  NOT_WRITTEN: { severity: 'warning', description: 'Source is valid but nothing was written because other sources failed validation (all-or-nothing).' },
  INVALID_SOURCE: { severity: 'critical', description: 'Source ConfigMap is invalid (kind, metadata.name or data); no file was written.' },
  DUPLICATE_CONFIGMAP: { severity: 'critical', description: 'Another source file declares the same metadata.name; no file was written.' },
  NO_SOURCE: { severity: 'critical', description: 'No flyway*.yaml/yml ConfigMap was found in commons/<env>/configmaps.' },
  SOURCE_DIR_MISSING: { severity: 'warning', description: 'commons/<env> or commons/<env>/configmaps does not exist or is empty; nothing to generate.' },
  REMOVED: { severity: 'info', description: 'Migration values file without a matching ConfigMap has been removed (--prune).' },
  UNMATCHED_TARGET: { severity: 'warning', description: 'Migration values file without a matching ConfigMap; kept because --prune was not set.' },
};
const COLUMNS = ['configMap', 'keys', 'sourceFile', 'targetFile'];

export async function main(): Promise<void> {
  const { reportDir, args } = extractReportDir(process.argv.slice(2));
  const options = parseOptions(args, true);
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  const rows: ReportRow[] = [];
  const report = () => writePhaseReport(reportDir, `generate-${options.environment}`, {
    phase: 'generate', environment: options.environment, root: options.root, definitions: DEFINITIONS, columns: COLUMNS, rows,
    parameters: { prune: options.prune },
  });
  const label = (file: string) => relative(options.root, file);
  const directories = paths(options);
  for (const directory of [directories.commons, directories.configmaps]) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      console.error(`WARN - Directory not found: ${directory}`);
      rows.push({ status: 'SOURCE_DIR_MISSING', detail: `Directory not found: ${label(directory)}` });
      report();
      return;
    }
  }
  if (files(directories.configmaps, /./).length === 0) {
    console.error(`WARN - ConfigMap directory is empty: ${directories.configmaps}`);
    rows.push({ status: 'SOURCE_DIR_MISSING', detail: `ConfigMap directory is empty: ${label(directories.configmaps)}` });
    report();
    return;
  }

  const temporary = mkdtempSync(join(tmpdir(), 'flyway-migrations-'));
  try {
    const sourceFiles = files(directories.configmaps, /^flyway.*\.ya?ml$/);
    const valid: ReportRow[] = [];
    for (const sourceFile of sourceFiles) {
      let name = '';
      try {
        const document = yamlDocument(sourceFile);
        const kind = scalarText(field(document.contents, 'kind')) ?? '';
        name = scalarText(field(field(document.contents, 'metadata'), 'name')) ?? '';
        const data = field(document.contents, 'data');

        if (kind !== 'ConfigMap') fail(`${sourceFile}: expected kind ConfigMap, found '${kind || "<empty>"}'.`);
        if (!name) fail(`${sourceFile}: metadata.name is required.`);
        if (!mapping(data)) fail(`${sourceFile}: data must be a YAML mapping.`);
        if (data.items.length === 0) fail(`${sourceFile}: data must contain at least one migration.`);
        if (name === '.' || name === '..' || name.includes('/')) fail(`${sourceFile}: invalid metadata.name '${name}'.`);

        const outputFile = join(temporary, `${name}.yaml`);
        let fd: number;
        try {
          fd = openSync(outputFile, 'wx');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            rows.push({ status: 'DUPLICATE_CONFIGMAP', configMap: name, sourceFile: label(sourceFile), detail: `Duplicate metadata.name '${name}' found while processing '${label(sourceFile)}'.` });
            continue;
          }
          throw err;
        }
        try {
          writeSync(fd, rawData(readFileSync(sourceFile, 'utf8'), name));
        } finally {
          closeSync(fd);
        }
        yamlDocument(outputFile);
        valid.push({ status: 'NOT_WRITTEN', configMap: name, keys: data.items.length, sourceFile: label(sourceFile), targetFile: label(join(directories.migrations, `${name}.yaml`)), detail: '' });
      } catch (err) {
        rows.push({ status: 'INVALID_SOURCE', configMap: name, sourceFile: label(sourceFile), detail: err instanceof Error ? err.message : String(err) });
      }
    }
    if (sourceFiles.length === 0) rows.push({ status: 'NO_SOURCE', detail: `No flyway*.yaml or flyway*.yml ConfigMaps found in ${label(directories.configmaps)}.` });

    if (rows.length > 0) {
      const invalid = rows.length;
      rows.push(...valid.map(row => ({ ...row, detail: `${row.keys} migration key(s) valid but not written: ${invalid} other source problem(s).` })));
      console.error(`FAILED - ${rows.length - valid.length} invalid source(s); no file was written:\n${rows.filter(row => row.detail).map(row => `- ${row.detail}`).join('\n')}`);
      report();
      process.exitCode = 1;
      return;
    }

    mkdirSync(directories.migrations, { recursive: true });
    for (const row of valid) {
      const generatedFile = join(temporary, `${row.configMap}.yaml`);
      const destination = join(directories.migrations, basename(generatedFile));
      const content = readFileSync(generatedFile, 'utf8');
      const previous = existsSync(destination) ? readFileSync(destination, 'utf8') : undefined;
      copyFileSync(generatedFile, destination);
      const status = previous === undefined ? 'CREATED' : previous === content ? 'UNCHANGED' : 'UPDATED';
      const action = { CREATED: 'created', UNCHANGED: 'already up to date', UPDATED: 'content changed and overwritten' }[status];
      rows.push({ ...row, status, detail: `${row.keys} migration key(s) from ${row.sourceFile}; ${row.targetFile} ${action}.` });
      console.log(`GENERATED - ${label(destination)}`);
    }
    for (const existingFile of files(directories.migrations, /\.ya?ml$/)) {
      if (existsSync(join(temporary, basename(existingFile)))) continue;
      if (options.prune) {
        rmSync(existingFile);
        console.log(`REMOVED UNMATCHED FILE - ${label(existingFile)}`);
      }
      rows.push({
        status: options.prune ? 'REMOVED' : 'UNMATCHED_TARGET',
        targetFile: label(existingFile),
        detail: `No flyway ConfigMap in ${label(directories.configmaps)} generates ${basename(existingFile)}; ${options.prune ? 'removed' : 'kept (use --prune to remove)'}.`,
      });
    }
    console.log(`DONE - Generated ${valid.length} Flyway migration file(s) for environment '${options.environment}'.`);
    console.log(`Configmap dir contains # of 'flyway' files: ${sourceFiles.length}`);
    console.log(`Migrations dir contains # of files: ${files(directories.migrations, /./).length}`);
    report();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
