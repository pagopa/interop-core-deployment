/**
 * CLI argument parsing for cluster inventory script
 */

import type { K8sCliArgs } from './k8s-types.js';
import * as path from 'path';

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

    if ((arg === '--namespace' || arg === '-n') && i + 1 < argv.length) {
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
