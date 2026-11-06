/**
 * CLI argument parsing for cluster inventory script
 */

import type { K8sCliArgs } from './k8s-types.js';
import * as path from 'path';
import { validateWorkloadFilterValue } from './workload-filter.js';

/**
 * Parse command-line arguments
 * Supported: --cluster (or -c), --namespace (or -n), --output-dir, --format
 */
export function parseK8sArgs(argv: string[]): K8sCliArgs {
  const args: Partial<K8sCliArgs> = {
    outputDir: 'secret-inventory',
    format: 'csv',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if ((arg === '--namespace' || arg === '-n') && i + 1 < argv.length) {
      args.namespace = argv[++i];
    } else if ((arg === '--cluster' || arg === '-c') && i + 1 < argv.length) {
      args.cluster = argv[++i];
    } else if (arg === '--output-dir' && i + 1 < argv.length) {
      args.outputDir = argv[++i];
    } else if (arg === '--format' && i + 1 < argv.length) {
      const fmt = argv[++i].toLowerCase();
      if (['csv', 'json', 'both'].includes(fmt)) {
        args.format = fmt as 'csv' | 'json' | 'both';
      }
    } else if (arg === '--microservice' && i + 1 < argv.length) {
      args.microservice = validateWorkloadFilterValue(arg, argv[++i]);
    } else if (arg === '--cronjob' && i + 1 < argv.length) {
      args.cronjob = validateWorkloadFilterValue(arg, argv[++i]);
    }
  }

  if (!args.namespace) {
    throw new Error('--namespace (or -n) is required');
  }
  if (!args.cluster) {
    throw new Error('--cluster is required');
  }

  return args as K8sCliArgs;
}

function printHelp(): void {
  console.log(`Usage:
  npm run secret-references-cluster-inventory -- [options]

Options:
  -c, --cluster <arn>       Cluster ARN or context name (required)
  -n, --namespace <ns>      Namespace (required)
  -o, --output-dir <dir>    Output directory (default: secret-inventory)
      --format <csv|json|both> Output format (default: csv)
      --microservice <name> Only scan this microservice folder
      --cronjob <name>      Only scan this cronjob folder
  -h, --help                Show this help
`);
}

/**
 * Validate output format
 */
export function parseK8sOutputFormat(format: string): 'csv' | 'json' | 'both' {
  const fmt = format.toLowerCase();
  if (['csv', 'json', 'both'].includes(fmt)) {
    return fmt as 'csv' | 'json' | 'both';
  }
  throw new Error(`Unknown output format: ${format}. Supported: csv, json, both`);
}
