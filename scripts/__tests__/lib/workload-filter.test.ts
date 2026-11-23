import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertScopeNotCombinedWithFilters,
  getWorkloadFilterSuffix,
  selectWorkloads,
} from '../../lib/workload-filter.js';

describe('workload-filter', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'workload-filter-'));
    writeValues('microservices', 'api-gateway', 'interop-be-api-gateway');
    writeValues('microservices', 'catalog-process', 'interop-be-catalog-process');
    writeValues('jobs', 'readmodel-checker', 'interop-be-readmodel-checker');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns every workload when no filter is provided', () => {
    const workloads = selectWorkloads(root, 'dev', {});
    expect(workloads).toHaveLength(3);
  });

  it('selects one microservice and one cronjob by folder name', () => {
    const workloads = selectWorkloads(root, 'dev', {
      microservice: 'api-gateway',
      cronjob: 'readmodel-checker',
    });

    expect(workloads.map((workload) => workload.component)).toEqual([
      'interop-be-api-gateway',
      'interop-be-readmodel-checker',
    ]);
  });

  it('throws when a selected folder does not exist for the environment', () => {
    expect(() => selectWorkloads(root, 'dev', { microservice: 'missing' })).toThrow(
      'Selected microservice folder not found for environment "dev"'
    );
  });

  it('rejects combining scope with workload filters', () => {
    expect(() => assertScopeNotCombinedWithFilters(true, { cronjob: 'readmodel-checker' })).toThrow(
      '--scope cannot be combined with --microservice or --cronjob'
    );
  });

  it('builds a deterministic suffix for one or both filters', () => {
    expect(getWorkloadFilterSuffix({ microservice: 'api-gateway' })).toBe('-microservice-api-gateway');
    expect(getWorkloadFilterSuffix({
      microservice: 'api-gateway',
      cronjob: 'readmodel-checker',
    })).toBe('-microservice-api-gateway-cronjob-readmodel-checker');
  });

  function writeValues(baseDir: string, folder: string, name: string): void {
    const directory = path.join(root, baseDir, folder, 'dev');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'values.yaml'), `name: ${name}\n`);
  }
});
