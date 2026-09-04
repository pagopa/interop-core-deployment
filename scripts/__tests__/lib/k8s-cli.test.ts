/**
 * Tests for Kubernetes CLI argument parsing
 */

import { describe, it, expect } from 'vitest';
import { parseK8sArgs, parseK8sOutputFormat } from '../../lib/k8s-cli.js';

describe('k8s-cli', () => {
  describe('parseK8sArgs', () => {
    it('parses required --cluster and --namespace arguments', () => {
      const args = parseK8sArgs(['--cluster', 'prod', '--namespace', 'dev']);
      expect(args.cluster).toBe('prod');
      expect(args.namespace).toBe('dev');
      expect(args.format).toBe('csv');
      expect(args.outputDir).toBe('secret-inventory');
    });

    it('parses short -n form for namespace', () => {
      const args = parseK8sArgs(['--cluster', 'prod', '-n', 'production']);
      expect(args.cluster).toBe('prod');
      expect(args.namespace).toBe('production');
    });

    it('parses --output-dir argument', () => {
      const args = parseK8sArgs(['--cluster', 'us-east-1', '--namespace', 'dev', '--output-dir', '/tmp/output']);
      expect(args.outputDir).toBe('/tmp/output');
    });

    it('parses --format csv', () => {
      const args = parseK8sArgs(['--cluster', 'prod', '--namespace', 'dev', '--format', 'csv']);
      expect(args.format).toBe('csv');
    });

    it('parses --format json', () => {
      const args = parseK8sArgs(['--cluster', 'prod', '--namespace', 'dev', '--format', 'json']);
      expect(args.format).toBe('json');
    });

    it('parses --format both', () => {
      const args = parseK8sArgs(['--cluster', 'prod', '--namespace', 'dev', '--format', 'both']);
      expect(args.format).toBe('both');
    });

    it('ignores unknown arguments', () => {
      const args = parseK8sArgs(['--cluster', 'prod', '--namespace', 'dev', '--unknown', 'value']);
      expect(args.cluster).toBe('prod');
      expect(args.namespace).toBe('dev');
    });

    it('throws error if --namespace is missing', () => {
      expect(() => parseK8sArgs(['--cluster', 'prod'])).toThrow(
        '--namespace (or -n) is required'
      );
    });

    it('throws error if --cluster is missing', () => {
      expect(() => parseK8sArgs(['--namespace', 'dev'])).toThrow('--cluster is required');
    });

    it('throws error if both required arguments are missing', () => {
      expect(() => parseK8sArgs([])).toThrow();
    });

    it('defaults to csv format when not specified', () => {
      const args = parseK8sArgs(['--cluster', 'prod', '-n', 'dev']);
      expect(args.format).toBe('csv');
    });

    it('handles multiple flags in any order', () => {
      const args = parseK8sArgs([
        '--format',
        'json',
        '--namespace',
        'staging',
        '--output-dir',
        './output',
        '--cluster',
        'us-west',
      ]);
      expect(args.cluster).toBe('us-west');
      expect(args.namespace).toBe('staging');
      expect(args.outputDir).toBe('./output');
      expect(args.format).toBe('json');
    });
  });

  describe('parseK8sOutputFormat', () => {
    it('accepts csv format', () => {
      expect(parseK8sOutputFormat('csv')).toBe('csv');
    });

    it('accepts json format', () => {
      expect(parseK8sOutputFormat('json')).toBe('json');
    });

    it('accepts both format', () => {
      expect(parseK8sOutputFormat('both')).toBe('both');
    });

    it('accepts uppercase CSV', () => {
      expect(parseK8sOutputFormat('CSV')).toBe('csv');
    });

    it('throws on unknown format', () => {
      expect(() => parseK8sOutputFormat('xml')).toThrow('Unknown output format');
    });
  });
});
