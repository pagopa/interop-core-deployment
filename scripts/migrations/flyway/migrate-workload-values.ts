#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMap, isScalar, parseDocument, type Document, type ParsedNode } from 'yaml';
import { extractReportDir, writePhaseReport, type ReportRow, type StatusDefinition } from './phase-report.js';

interface Options {
  root: string;
  environment: string;
  dryRun: boolean;
  help: boolean;
}

interface Candidate {
  file: string;
  workloadKind: 'microservice' | 'job';
  workloadName: string;
  domain: string;
  changed: boolean;
  output: string;
}

type SkipStatus = 'NO_FLYWAY_INIT_CONTAINER' | 'NO_MIGRATION_REFERENCE' | 'IGNORED';

interface Skipped {
  skipped: SkipStatus;
  domain?: string;
  key?: string;
}

const DEFINITIONS: Record<string, StatusDefinition> = {
  WOULD_UPDATE: { severity: 'info', description: 'Dry run: migrationsConfigmap would be renamed to migrationDomain.' },
  UPDATED: { severity: 'ok', description: 'migrationsConfigmap has been renamed to migrationDomain and the file content verified after writing.' },
  NOT_APPLIED: { severity: 'warning', description: 'Workload needs migration but no file was changed because validation failed for other workloads (all-or-nothing).' },
  ALREADY_MIGRATED: { severity: 'ok', description: 'Workload already uses migrationDomain; nothing to do.' },
  IGNORED: { severity: 'info', description: 'Known exception (deprecated Scala MongoDB domain); reference left unchanged.' },
  NO_FLYWAY_INIT_CONTAINER: { severity: 'info', description: 'Workload values have no flywayInitContainer section; not in scope.' },
  NO_MIGRATION_REFERENCE: { severity: 'info', description: 'flywayInitContainer has neither migrationsConfigmap nor migrationDomain; not in scope.' },
  INVALID_REFERENCE: { severity: 'critical', description: 'Workload reference is invalid (malformed YAML, conflicting keys or domain without generated Flyway source); no file was changed.' },
  WRITE_VERIFICATION_FAILED: { severity: 'critical', description: 'File content read back after writing differs from the expected content.' },
};
const COLUMNS = ['workloadType', 'workloadName', 'configMap', 'fromKey', 'toKey', 'valuesFile'];

interface WorkloadFile {
  file: string;
  section: 'deployment' | 'cronjob';
  workloadKind: 'microservice' | 'job';
  workloadName: string;
}

const YAML_FILE = /\.ya?ml$/i;
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const IGNORED_MIGRATION_DOMAINS = new Set(['common-db-migrations']);

function fail(message: string): never {
  throw new Error(message);
}

function usage(): string {
  return `Usage: npm run migrate:workloads -- --environment <env> [--root <absolute-path>] [--dry-run] [--report-dir <dir>]

Replaces migrationsConfigmap with migrationDomain in:
  microservices/*/<env>/values.yaml
  jobs/*/<env>/values.yaml

Every referenced domain must originate from commons/<env>/configmaps/flyway*.yaml
and exist as the same second-level key in its generated migration values file.
Validation is completed before any file is written.`;
}

function parseOptions(args: string[]): Options {
  const options: Options = { root: DEFAULT_ROOT, environment: '', dryRun: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '-h' || option === '--help') return { ...options, help: true };
    if (option === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (option !== '-r' && option !== '--root' && option !== '-e' && option !== '--environment') {
      fail(`Unknown option '${option}'.`);
    }
    const value = args[++index];
    if (value === undefined) fail(`Missing value for ${option}.`);
    if (option === '-r' || option === '--root') options.root = value;
    else options.environment = value;
  }

  if (!options.environment) fail('Target environment is required.');
  if (options.environment === '.' || options.environment === '..' || options.environment.includes('/')) {
    fail(`Invalid environment: ${options.environment}`);
  }
  options.root = resolve(options.root);
  if (!isAbsolute(options.root) || !existsSync(options.root) || !statSync(options.root).isDirectory()) {
    fail(`Project root must be an existing directory: ${options.root}`);
  }
  options.root = realpathSync(options.root);
  return options;
}

function yamlDocument(file: string): Document.Parsed<ParsedNode> {
  const document = parseDocument(readFileSync(file, 'utf8'), { uniqueKeys: true });
  if (document.errors.length > 0) fail(`${file}: ${document.errors[0].message}`);
  return document as Document.Parsed<ParsedNode>;
}

function scalarString(node: unknown): string | undefined {
  return isScalar(node) && typeof node.value === 'string' ? node.value : undefined;
}

function yamlFiles(directory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) fail(`Directory not found: ${directory}`);
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && YAML_FILE.test(entry.name))
    .map(entry => join(directory, entry.name))
    .sort();
}

export function loadMigrationDomains(configmapDirectory: string, migrationDirectory: string): Map<string, string> {
  const domains = new Map<string, string>();
  const sourceFiles = yamlFiles(configmapDirectory).filter(file => /^flyway.*\.ya?ml$/i.test(basename(file)));
  if (sourceFiles.length === 0) fail(`No flyway*.yaml or flyway*.yml ConfigMaps found in ${configmapDirectory}`);

  for (const sourceFile of sourceFiles) {
    const source = yamlDocument(sourceFile);
    const kind = scalarString(source.get('kind', true));
    const metadata = source.get('metadata', true);
    const domain = isMap(metadata) ? scalarString(metadata.get('name', true)) : undefined;
    if (kind !== 'ConfigMap') fail(`${sourceFile}: expected kind ConfigMap, found '${kind ?? '<empty>'}'.`);
    if (!domain) fail(`${sourceFile}: metadata.name is required.`);
    const previous = domains.get(domain);
    if (previous) fail(`Duplicate Flyway ConfigMap metadata.name '${domain}' in ${previous} and ${sourceFile}.`);

    const migrationFile = join(migrationDirectory, `${domain}.yaml`);
    if (!existsSync(migrationFile)) fail(`${sourceFile}: generated migration values file not found: ${migrationFile}`);
    const migrations = yamlDocument(migrationFile).get('migrations', true);
    if (!isMap(migrations)) fail(`${migrationFile}: expected a root 'migrations' mapping.`);
    if (!migrations.has(domain)) {
      fail(`${migrationFile}: expected migration domain key '${domain}' generated from ${sourceFile}.`);
    }
    domains.set(domain, migrationFile);
  }
  return domains;
}

function workloadFiles(root: string, environment: string): WorkloadFile[] {
  const result: WorkloadFile[] = [];
  for (const [directoryName, section, workloadKind] of [
    ['microservices', 'deployment', 'microservice'],
    ['jobs', 'cronjob', 'job'],
  ] as const) {
    const directory = join(root, directoryName);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const file = join(directory, entry.name, environment, 'values.yaml');
      if (existsSync(file) && statSync(file).isFile()) {
        result.push({ file, section, workloadKind, workloadName: entry.name });
      }
    }
  }
  return result;
}

function inspectCandidate(workloadFile: WorkloadFile, domains: Map<string, string>): Candidate | Skipped {
  const { file, section, workloadKind, workloadName } = workloadFile;
  const source = readFileSync(file, 'utf8');
  const document = yamlDocument(file);
  const workload = document.get(section, true);
  if (workload === undefined) return { skipped: 'NO_FLYWAY_INIT_CONTAINER' };
  if (!isMap(workload)) fail(`${file}: '${section}' must be a mapping.`);
  const flyway = workload.get('flywayInitContainer', true);
  if (flyway === undefined) return { skipped: 'NO_FLYWAY_INIT_CONTAINER' };
  if (!isMap(flyway)) fail(`${file}: '${section}.flywayInitContainer' must be a mapping.`);

  const legacyPair = flyway.items.find(pair => scalarString(pair.key) === 'migrationsConfigmap');
  const newPair = flyway.items.find(pair => scalarString(pair.key) === 'migrationDomain');
  if (!legacyPair && !newPair) return { skipped: 'NO_MIGRATION_REFERENCE' };

  const legacy = legacyPair ? scalarString(legacyPair.value) : undefined;
  const current = newPair ? scalarString(newPair.value) : undefined;
  if (legacyPair && !legacy) fail(`${file}: 'migrationsConfigmap' must be a non-empty string.`);
  if (newPair && !current) fail(`${file}: 'migrationDomain' must be a non-empty string.`);
  if (legacy && current && legacy !== current) {
    fail(`${file}: migrationsConfigmap '${legacy}' conflicts with migrationDomain '${current}'.`);
  }

  const domain = current ?? legacy!;
  if (!domains.has(domain)) {
    if (IGNORED_MIGRATION_DOMAINS.has(domain)) {
      console.log(`IGNORED - ${relative(DEFAULT_ROOT, file)} -> ${domain} (deprecated Scala workload)`);
      return { skipped: 'IGNORED', domain, key: legacyPair ? 'migrationsConfigmap' : 'migrationDomain' };
    }
    fail(`${file}: migration domain '${domain}' is referenced but has no generated Flyway migration source.`);
  }
  if (!legacyPair) return { file, workloadKind, workloadName, domain, changed: false, output: source };

  const keyRange = isScalar(legacyPair.key) ? legacyPair.key.range : undefined;
  if (!keyRange) fail(`${file}: cannot locate 'migrationsConfigmap' in the original YAML text.`);
  let output: string;
  if (newPair) {
    const lineStart = source.lastIndexOf('\n', keyRange[0] - 1) + 1;
    const nextNewline = source.indexOf('\n', keyRange[2]);
    const lineEnd = nextNewline < 0 ? source.length : nextNewline + 1;
    output = source.slice(0, lineStart) + source.slice(lineEnd);
  } else {
    const keySource = source.slice(keyRange[0], keyRange[1]);
    const offset = keySource.indexOf('migrationsConfigmap');
    if (offset < 0) fail(`${file}: cannot replace 'migrationsConfigmap' in the original YAML text.`);
    const start = keyRange[0] + offset;
    output = source.slice(0, start) + 'migrationDomain' + source.slice(start + 'migrationsConfigmap'.length);
  }
  return { file, workloadKind, workloadName, domain, changed: true, output };
}

function printMigrationPlan(root: string, environment: string, candidates: Candidate[]): void {
  const changed = candidates.filter(candidate => candidate.changed);
  const microservices = changed.filter(candidate => candidate.workloadKind === 'microservice');
  const jobs = changed.filter(candidate => candidate.workloadKind === 'job');

  console.log("========================================");
  console.log(`MIGRATION PLAN - environment '${environment}'`);
  for (const [label, workloads] of [['Microservices', microservices], ['Cronjobs', jobs]] as const) {
    // console.log("\n");
    console.log("\n-------------------------------");
    console.log(`| ${label} to migrate: ${workloads.length}`);
    console.log("-------------------------------");
    for (const workload of workloads) {
      console.log(
        `- ${workload.workloadName} (${relative(root, workload.file)}): ` +
        `migrationsConfigmap='${workload.domain}' -> migrationDomain='${workload.domain}'`,
      );
    }
  }
  console.log("-----------------------------");
  console.log(`| Total files to migrate: ${changed.length}`);
  console.log("-----------------------------");
}

export function migrate(rawArgs: string[]): number {
  const { reportDir, args } = extractReportDir(rawArgs);
  const options = parseOptions(args);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const phase = options.dryRun ? 'plan' : 'migrate';
  const rows: ReportRow[] = [];
  const writeReport = () => writePhaseReport(reportDir, `${phase}-${options.environment}`, {
    phase, environment: options.environment, root: options.root, definitions: DEFINITIONS, columns: COLUMNS, rows,
    parameters: { dryRun: options.dryRun },
  });
  // Same workload identity used by the inventory/validate reports: Kubernetes kind and the `name` declared in values.yaml.
  const describe = (workloadFile: WorkloadFile) => {
    let workloadName = workloadFile.workloadName;
    try {
      workloadName = scalarString(yamlDocument(workloadFile.file).get('name', true)) ?? workloadName;
    } catch {
      // Malformed files are reported as INVALID_REFERENCE; keep the folder name.
    }
    return {
      workloadType: workloadFile.section === 'deployment' ? 'Deployment' : 'CronJob',
      workloadName,
      valuesFile: relative(options.root, workloadFile.file),
    };
  };

  try {
    const commonsDirectory = join(options.root, 'commons', options.environment);
    const domains = loadMigrationDomains(join(commonsDirectory, 'configmaps'), join(commonsDirectory, 'migrations'));
    const errors: string[] = [];
    const candidates: Candidate[] = [];
    const candidateRows = new Map<Candidate, ReportRow>();

    for (const workloadFile of workloadFiles(options.root, options.environment)) {
      try {
        const result = inspectCandidate(workloadFile, domains);
        if ('skipped' in result) {
          const detail = {
            NO_FLYWAY_INIT_CONTAINER: `No ${workloadFile.section}.flywayInitContainer section.`,
            NO_MIGRATION_REFERENCE: `${workloadFile.section}.flywayInitContainer has neither migrationsConfigmap nor migrationDomain.`,
            IGNORED: `${result.key}: ${result.domain} left unchanged.`,
          }[result.skipped];
          rows.push({ status: result.skipped, ...describe(workloadFile), configMap: result.domain ?? '', fromKey: result.key ?? '', toKey: result.key ?? '', detail });
          continue;
        }
        candidates.push(result);
        const row: ReportRow = result.changed
          ? { status: options.dryRun ? 'WOULD_UPDATE' : 'NOT_APPLIED', ...describe(workloadFile), configMap: result.domain, fromKey: 'migrationsConfigmap', toKey: 'migrationDomain', detail: `${workloadFile.section}.flywayInitContainer.migrationsConfigmap: ${result.domain} -> migrationDomain: ${result.domain}${options.dryRun ? ' (dry run).' : ' not applied: validation failed for other workloads.'}` }
          : { status: 'ALREADY_MIGRATED', ...describe(workloadFile), configMap: result.domain, fromKey: 'migrationDomain', toKey: 'migrationDomain', detail: `${workloadFile.section}.flywayInitContainer.migrationDomain: ${result.domain}.` };
        rows.push(row);
        candidateRows.set(result, row);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        rows.push({ status: 'INVALID_REFERENCE', ...describe(workloadFile), detail: message });
      }
    }
    if (errors.length > 0) fail(`Validation failed; no files were changed:\n- ${errors.join('\n- ')}`);

    printMigrationPlan(options.root, options.environment, candidates);

    console.log("========================================");
    console.log(`UPDATE PLAN - environment '${options.environment}'`);
    console.log("========================================\n");
    const changed = candidates.filter(candidate => candidate.changed);
    for (const candidate of changed) {
      if (options.dryRun) {
        console.log(`WOULD UPDATE ${relative(options.root, candidate.file)} -> ${candidate.domain}`);
        continue;
      }
      writeFileSync(candidate.file, candidate.output, 'utf8');
      const row = candidateRows.get(candidate)!;
      if (readFileSync(candidate.file, 'utf8') !== candidate.output) {
        row.status = 'WRITE_VERIFICATION_FAILED';
        row.detail = `${relative(options.root, candidate.file)}: content read back after writing differs from the expected content.`;
        fail(`${candidate.file}: content verification failed after writing.`);
      }
      row.status = 'UPDATED';
      row.detail = `migrationsConfigmap: ${candidate.domain} -> migrationDomain: ${candidate.domain}; written and verified.`;
      console.log(`UPDATED ${relative(options.root, candidate.file)} -> ${candidate.domain}`);
    }
    console.log("========================================\n");
    console.log(`SUCCESS - validated ${candidates.length} Flyway workload reference(s); ${changed.length} file(s) ${options.dryRun ? 'would be updated' : 'updated'}.`);
    writeReport();
    return 0;
  } catch (error) {
    if (!rows.some(row => DEFINITIONS[row.status]?.severity === 'critical')) {
      rows.push({ status: 'FATAL_ERROR', detail: error instanceof Error ? error.message : String(error) });
    }
    writeReport();
    throw error;
  }
}

export async function main(): Promise<void> {
  process.exitCode = migrate(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
