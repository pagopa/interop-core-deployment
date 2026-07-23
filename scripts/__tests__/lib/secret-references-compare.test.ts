import { describe, expect, it } from 'vitest';
import {
  buildSecretComparisonReport,
  buildStatsComparisonReport,
  buildWorkloadComparisonReport,
  secretComparisonToCSV,
  statsComparisonToCSV,
  workloadComparisonToCSV,
  type ComparisonResult,
} from '../../lib/secret-references-compare.js';

const COMPARISON: ComparisonResult = {
  timestamp: '2026-07-09T00:00:00.000Z',
  environment: 'dev',
  cluster: 'interop-eks-cluster-dev',
  secretCentric: {
    missingInStatic: [
      {
        secretName: 'cluster-only-secret',
        secretNamespace: 'dev',
        keys: ['password'],
        usageInCluster: 1,
      },
    ],
    missingInDynamic: [],
    differencesBySecret: [],
  },
  workloadCentric: {
    missingInStatic: [],
    missingInDynamic: [
      {
        workloadType: 'Deployment',
        workloadName: 'repo-only-workload',
        workloadNamespace: 'dev',
        containerName: 'container',
        containerType: 'container',
        secretReferences: 2,
      },
    ],
    differencesByWorkload: [],
  },
  summary: {
    secretCentric: {
      totalSecretsStatic: 1,
      totalSecretsDynamic: 2,
      totalUniqueSecrets: 2,
      secretsOnlyInStatic: 0,
      secretsOnlyInDynamic: 1,
      secretsWithDifferentUsage: 0,
      discrepancyPercentage: 50,
    },
    workloadCentric: {
      totalWorkloadsStatic: 2,
      totalWorkloadsDynamic: 1,
      totalUniqueWorkloads: 2,
      workloadsOnlyInStatic: 1,
      workloadsOnlyInDynamic: 0,
      workloadsWithDifferentReferences: 0,
    },
  },
};

describe('secret-references-compare report split', () => {
  it('builds a secret-only report', () => {
    const report = buildSecretComparisonReport(COMPARISON);

    expect(report).toHaveProperty('secretCentric');
    expect(report).not.toHaveProperty('workloadCentric');
    expect(report).not.toHaveProperty('summary');
    expect(secretComparisonToCSV(report)).toContain('SECRETS MISSING IN REPO');
    expect(secretComparisonToCSV(report)).not.toContain('WORKLOADS MISSING');
  });

  it('builds a workload-only report', () => {
    const report = buildWorkloadComparisonReport(COMPARISON);

    expect(report).toHaveProperty('workloadCentric');
    expect(report).not.toHaveProperty('secretCentric');
    expect(report).not.toHaveProperty('summary');
    expect(workloadComparisonToCSV(report)).toContain('WORKLOADS MISSING IN CLUSTER');
    expect(workloadComparisonToCSV(report)).not.toContain('SECRETS MISSING');
  });

  it('builds a stats-only report', () => {
    const report = buildStatsComparisonReport(COMPARISON);

    expect(report).toHaveProperty('summary');
    expect(report).not.toHaveProperty('secretCentric');
    expect(report).not.toHaveProperty('workloadCentric');
    expect(statsComparisonToCSV(report)).toContain('discrepancyPercentage');
    expect(statsComparisonToCSV(report)).not.toContain('SECRETS MISSING');
    expect(statsComparisonToCSV(report)).not.toContain('WORKLOADS MISSING');
  });
});
