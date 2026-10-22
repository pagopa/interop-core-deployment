import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fail, field, files, mapping, parseOptions, paths, scalarText, yamlDocument } from './common.js';

const usage = `Generate Flyway migration values from Kubernetes ConfigMaps.

Usage: npm run generate -- --root <project_root> --environment <environment> [--prune]
Options: -r, --root   Absolute project root
         -e, --environment   Environment under commons/
         -p, --prune  Remove unmatched YAML files in migrations/
         -h, --help   Show this help
Requires: Node.js >=22.2.0; npm ci in scripts/migrations/node.
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

export async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2), true);
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  const directories = paths(options);
  for (const directory of [directories.commons, directories.configmaps]) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      console.error(`WARN - Directory not found: ${directory}`);
      return;
    }
  }
  if (files(directories.configmaps, /./).length === 0) {
    console.error(`WARN - ConfigMap directory is empty: ${directories.configmaps}`);
    return;
  }

  const temporary = mkdtempSync(join(tmpdir(), 'flyway-migrations-'));
  try {
    const sourceFiles = files(directories.configmaps, /^flyway.*\.ya?ml$/);
    let generated = 0;
    for (const sourceFile of sourceFiles) {
      const document = yamlDocument(sourceFile);
      const kind = scalarText(field(document.contents, 'kind')) ?? '';
      const name = scalarText(field(field(document.contents, 'metadata'), 'name')) ?? '';
      const data = field(document.contents, 'data');

      if (kind !== 'ConfigMap') fail(`${sourceFile}: expected kind ConfigMap, found '${kind || "<empty>"}'.`);
      if (!name) fail(`${sourceFile}: metadata.name is required.`);
      if (!mapping(data)) fail(`${sourceFile}: data must be a YAML mapping.`);
      if (data.items.length === 0) fail(`${sourceFile}: data must contain at least one migration.`);
      if (name === '.' || name === '..' || name.includes('/')) fail(`${sourceFile}: invalid metadata.name '${name}'.`);

      const outputFile = join(temporary, `${name}.yaml`);
      if (existsSync(outputFile)) fail(`Duplicate metadata.name '${name}' found while processing '${sourceFile}'.`);

      const output = rawData(readFileSync(sourceFile, 'utf8'), name);
      writeFileSync(outputFile, output);
      yamlDocument(outputFile);
      generated += 1;
    }
    if (generated === 0) fail(`No flyway*.yaml or flyway*.yml ConfigMaps found in ${directories.configmaps}.`);

    mkdirSync(directories.migrations, { recursive: true });
    for (const generatedFile of files(temporary, /\.yaml$/)) {
      const destination = join(directories.migrations, basename(generatedFile));
      copyFileSync(generatedFile, destination);
      console.log(`GENERATED - ${relative(options.root, destination)}`);
    }
    if (options.prune) {
      for (const existingFile of files(directories.migrations, /\.ya?ml$/)) {
        if (!existsSync(join(temporary, basename(existingFile)))) {
          rmSync(existingFile);
          console.log(`REMOVED UNMATCHED FILE - ${relative(options.root, existingFile)}`);
        }
      }
    }
    console.log(`DONE - Generated ${generated} Flyway migration file(s) for environment '${options.environment}'.`);
    console.log(`Configmap dir contains # of 'flyway' files: ${sourceFiles.length}`);
    console.log(`Migrations dir contains # of files: ${files(directories.migrations, /./).length}`);
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