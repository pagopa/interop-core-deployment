import { describe, expect, it, vi } from 'vitest';
import { parseK8sArgs } from '../../lib/k8s-cli.js';
import { parseComparisonArgs } from '../../secret-references-compare.js';
import { parseArgs as parseGeneratorArgs } from '../../secret-references-external-secrets-generator.js';
import { parseArgs as parseValidatorArgs } from '../../secret-references-external-secrets-validator.js';
import { parseArgs as parseListArgs } from '../../list-external-secrets.js';

describe('workload filters across CLI commands', () => {
  it('prints help and exits for cluster inventory', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(() => parseK8sArgs(['--help'])).toThrow('process.exit:0');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('prints help and exits for compare', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(() => parseComparisonArgs(['--help'])).toThrow('process.exit:0');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('prints help and exits for generator', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(() => parseGeneratorArgs(['--help'])).toThrow('process.exit:0');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('prints help and exits for validator', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(() => parseValidatorArgs(['--help'])).toThrow('process.exit:0');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('parses both filters in compare', () => {
    const args = parseComparisonArgs([
      '--env', 'dev',
      '--cluster', 'dev-cluster',
      '--microservice', 'api-gateway',
      '--cronjob', 'readmodel-checker',
    ]);
    expect(args.microservice).toBe('api-gateway');
    expect(args.cronjob).toBe('readmodel-checker');
  });

  it('parses both filters in generator without scope', () => {
    const args = parseGeneratorArgs([
      '--env', 'dev',
      '--cluster', 'dev-cluster',
      '--namespace', 'dev',
      '--microservice', 'api-gateway',
      '--cronjob', 'readmodel-checker',
    ]);
    expect(args.microservice).toBe('api-gateway');
    expect(args.cronjob).toBe('readmodel-checker');
  });

  it('rejects scope combined with a generator workload filter', () => {
    expect(() => parseGeneratorArgs([
      '--env', 'dev',
      '--cluster', 'dev-cluster',
      '--namespace', 'dev',
      '--scope', 'microservice',
      '--microservice', 'api-gateway',
    ])).toThrow('--scope cannot be combined with --microservice or --cronjob');
  });

  it('uses suffixed default inputs in validator', () => {
    const args = parseValidatorArgs(['--env', 'dev', '--microservice', 'api-gateway']);
    expect(args.migrationReportPath).toContain('external-secrets-migration-dev-microservice-api-gateway.json');
    expect(args.repoInventoryPath).toContain('secret-references-repo-dev-microservice-api-gateway.json');
    expect(args.clusterInventoryPath).toContain('secret-inventory-cluster-secrets-dev-microservice-api-gateway.json');
  });

  it('rejects scope combined with a validator workload filter', () => {
    expect(() => parseValidatorArgs([
      '--env', 'dev',
      '--scope', 'cronjob',
      '--cronjob', 'readmodel-checker',
    ])).toThrow('--scope cannot be combined with --microservice or --cronjob');
  });

  it('parses both filters in list-external-secrets', () => {
    const args = parseListArgs([
      '--env', 'dev',
      '--microservice', 'api-gateway',
      '--cronjob', 'readmodel-checker',
    ]);
    expect(args.microservice).toBe('api-gateway');
    expect(args.cronjob).toBe('readmodel-checker');
  });
});
