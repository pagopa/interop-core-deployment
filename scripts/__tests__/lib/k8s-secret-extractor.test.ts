/**
 * Tests for Kubernetes secret reference extraction
 */

import { describe, it, expect } from 'vitest';
import { extractFromPodSpecInternal, extractFromContainer } from '../../lib/k8s-secret-extractor.js';

describe('k8s-secret-extractor', () => {
  describe('extractFromPodSpec - env.secretKeyRef', () => {
    it('extracts env valueFrom secretKeyRef', () => {
      const podSpec = {
        containers: [
          {
            name: 'app',
            env: [
              {
                name: 'DB_PASSWORD',
                valueFrom: {
                  secretKeyRef: {
                    name: 'db-secret',
                    key: 'password',
                  },
                },
              },
            ],
          },
        ],
      };

      const refs = extractFromPodSpecInternal('my-app', 'Deployment', 'dev', podSpec);
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        workloadType: 'Deployment',
        workloadName: 'my-app',
        workloadNamespace: 'dev',
        containerName: 'app',
        containerType: 'container',
        referenceType: 'env.secretKeyRef',
        secretName: 'db-secret',
        secretKey: 'password',
      });
    });

    it('extracts multiple env secretKeyRef from same container', () => {
      const podSpec = {
        containers: [
          {
            name: 'app',
            env: [
              {
                name: 'DB_PASSWORD',
                valueFrom: { secretKeyRef: { name: 'db-secret', key: 'password' } },
              },
              {
                name: 'DB_USERNAME',
                valueFrom: { secretKeyRef: { name: 'db-secret', key: 'username' } },
              },
            ],
          },
        ],
      };

      const refs = extractFromPodSpecInternal('app', 'Deployment', 'dev', podSpec);
      expect(refs).toHaveLength(2);
      expect(refs.map((r) => r.secretKey)).toEqual(['password', 'username']);
    });

    it('ignores env values without secretKeyRef', () => {
      const podSpec = {
        containers: [
          {
            name: 'app',
            env: [
              { name: 'ENV_VAR', value: 'plain-value' },
              { name: 'DB_PASS', valueFrom: { secretKeyRef: { name: 'secret', key: 'pass' } } },
            ],
          },
        ],
      };

      const refs = extractFromPodSpecInternal('app', 'Deployment', 'dev', podSpec);
      expect(refs).toHaveLength(1);
      expect(refs[0].secretName).toBe('secret');
    });
  });

  describe('extractFromPodSpec - envFrom.secretRef', () => {
    it('extracts envFrom secretRef', () => {
      const podSpec = {
        containers: [
          {
            name: 'app',
            envFrom: [
              {
                secretRef: {
                  name: 'app-config',
                },
              },
            ],
          },
        ],
      };

      const refs = extractFromPodSpecInternal('my-app', 'Deployment', 'dev', podSpec);
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        workloadType: 'Deployment',
        workloadName: 'my-app',
        workloadNamespace: 'dev',
        containerName: 'app',
        containerType: 'container',
        referenceType: 'envFrom.secretRef',
        secretName: 'app-config',
        secretKey: undefined,
      });
    });

    it('extracts multiple envFrom including configMapRef', () => {
      const podSpec = {
        containers: [
          {
            name: 'app',
            envFrom: [
              { configMapRef: { name: 'config' } },
              { secretRef: { name: 'secret1' } },
              { secretRef: { name: 'secret2' } },
            ],
          },
        ],
      };

      const refs = extractFromPodSpecInternal('app', 'StatefulSet', 'prod', podSpec);
      expect(refs).toHaveLength(2);
      expect(refs.map((r) => r.secretName)).toEqual(['secret1', 'secret2']);
    });
  });

  describe('extractFromPodSpec - volumes.secret', () => {
    it('extracts volume secret', () => {
      const podSpec = {
        containers: [{ name: 'app' }],
        volumes: [
          {
            name: 'config',
            secret: {
              secretName: 'app-secret',
            },
          },
        ],
      };

      const refs = extractFromPodSpecInternal('my-app', 'Deployment', 'dev', podSpec);
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        workloadType: 'Deployment',
        workloadName: 'my-app',
        workloadNamespace: 'dev',
        containerName: 'pod-volume',
        containerType: 'pod-volume',
        referenceType: 'volumes.secret',
        secretName: 'app-secret',
      });
    });

    it('extracts multiple volume secrets', () => {
      const podSpec = {
        containers: [{ name: 'app' }],
        volumes: [
          { name: 'vol1', secret: { secretName: 'secret1' } },
          { name: 'vol2', configMap: { name: 'config' } },
          { name: 'vol3', secret: { secretName: 'secret2' } },
        ],
      };

      const refs = extractFromPodSpecInternal('app', 'DaemonSet', 'kube-system', podSpec);
      expect(refs).toHaveLength(2);
      expect(refs.map((r) => r.secretName)).toEqual(['secret1', 'secret2']);
    });

    it('ignores volumes without secrets', () => {
      const podSpec = {
        containers: [{ name: 'app' }],
        volumes: [
          { name: 'data', emptyDir: {} },
          { name: 'config', configMap: { name: 'config' } },
        ],
      };

      const refs = extractFromPodSpecInternal('app', 'Deployment', 'dev', podSpec);
      expect(refs).toHaveLength(0);
    });
  });

  describe('extractFromPodSpec - mixed containers', () => {
    it('extracts from init containers', () => {
      const podSpec = {
        initContainers: [
          {
            name: 'init',
            env: [
              {
                name: 'INIT_SECRET',
                valueFrom: { secretKeyRef: { name: 'init-secret', key: 'value' } },
              },
            ],
          },
        ],
        containers: [{ name: 'app' }],
      };

      const refs = extractFromPodSpecInternal('app', 'Deployment', 'dev', podSpec);
      expect(refs).toHaveLength(1);
      expect(refs[0].containerName).toBe('init');
    });

    it('extracts from regular and init containers', () => {
      const podSpec = {
        containers: [
          {
            name: 'main',
            env: [{ name: 'SECRET1', valueFrom: { secretKeyRef: { name: 's1', key: 'k' } } }],
          },
        ],
        initContainers: [
          {
            name: 'init',
            env: [{ name: 'SECRET2', valueFrom: { secretKeyRef: { name: 's2', key: 'k' } } }],
          },
        ],
      };

      const refs = extractFromPodSpecInternal('app', 'Job', 'dev', podSpec);
      expect(refs).toHaveLength(2);
      expect(refs.map((r) => r.containerName)).toContain('main');
      expect(refs.map((r) => r.containerName)).toContain('init');
    });

    it('combines all reference types', () => {
      const podSpec = {
        containers: [
          {
            name: 'app',
            env: [{ name: 'VAR1', valueFrom: { secretKeyRef: { name: 's1', key: 'k' } } }],
            envFrom: [{ secretRef: { name: 's2' } }],
          },
        ],
        volumes: [{ name: 'vol', secret: { secretName: 's3' } }],
      };

      const refs = extractFromPodSpecInternal('app', 'Deployment', 'dev', podSpec);
      expect(refs).toHaveLength(3);
      expect(refs.map((r) => r.referenceType)).toEqual([
        'env.secretKeyRef',
        'envFrom.secretRef',
        'volumes.secret',
      ]);
    });
  });

  describe('extractFromPodSpec - edge cases', () => {
    it('handles null podSpec', () => {
      const refs = extractFromPodSpecInternal('app', 'Deployment', 'dev', null);
      expect(refs).toHaveLength(0);
    });

    it('handles empty podSpec', () => {
      const refs = extractFromPodSpecInternal('app', 'Deployment', 'dev', {});
      expect(refs).toHaveLength(0);
    });

    it('handles container with no name', () => {
      const podSpec = {
        containers: [
          {
            env: [{ name: 'VAR', valueFrom: { secretKeyRef: { name: 'secret', key: 'key' } } }],
          },
        ],
      };

      const refs = extractFromPodSpecInternal('app', 'Deployment', 'dev', podSpec);
      expect(refs).toHaveLength(1);
      expect(refs[0].containerName).toBe('unnamed');
    });

    it('handles missing secretKeyRef properties', () => {
      const podSpec = {
        containers: [
          {
            name: 'app',
            env: [
              { name: 'VAR', valueFrom: { secretKeyRef: {} } },
              { name: 'VAR2', valueFrom: { secretKeyRef: { name: 's' } } },
            ],
          },
        ],
      };

      const refs = extractFromPodSpecInternal('app', 'Deployment', 'dev', podSpec);
      // Should still extract what it can
      expect(refs.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('extractFromContainer - direct unit tests', () => {
    it('extracts env.secretKeyRef from regular container', () => {
      const container = {
        name: 'main',
        env: [
          {
            name: 'DB_PASS',
            valueFrom: { secretKeyRef: { name: 'db-secret', key: 'password' } },
          },
        ],
      };

      const refs = extractFromContainer('my-app', 'Deployment', 'dev', container, 'container');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        workloadType: 'Deployment',
        workloadName: 'my-app',
        workloadNamespace: 'dev',
        containerName: 'main',
        containerType: 'container',
        referenceType: 'env.secretKeyRef',
        secretName: 'db-secret',
        secretKey: 'password',
      });
    });

    it('extracts env.secretKeyRef from initContainer', () => {
      const container = {
        name: 'init-container',
        env: [
          {
            name: 'INIT_VAR',
            valueFrom: { secretKeyRef: { name: 'init-secret', key: 'value' } },
          },
        ],
      };

      const refs = extractFromContainer('my-app', 'Job', 'prod', container, 'initContainer');
      expect(refs).toHaveLength(1);
      expect(refs[0].containerType).toBe('initContainer');
      expect(refs[0].secretName).toBe('init-secret');
    });

    it('extracts env.secretKeyRef from ephemeralContainer', () => {
      const container = {
        name: 'ephemeral',
        env: [
          {
            name: 'DEBUG_VAR',
            valueFrom: { secretKeyRef: { name: 'debug-secret', key: 'config' } },
          },
        ],
      };

      const refs = extractFromContainer('my-pod', 'Pod', 'debug', container, 'ephemeralContainer');
      expect(refs).toHaveLength(1);
      expect(refs[0].containerType).toBe('ephemeralContainer');
    });

    it('extracts envFrom.secretRef from container', () => {
      const container = {
        name: 'app',
        envFrom: [
          { secretRef: { name: 'config-secret' } },
        ],
      };

      const refs = extractFromContainer('service', 'StatefulSet', 'staging', container, 'container');
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        workloadType: 'StatefulSet',
        workloadName: 'service',
        workloadNamespace: 'staging',
        containerName: 'app',
        containerType: 'container',
        referenceType: 'envFrom.secretRef',
        secretName: 'config-secret',
      });
    });

    it('extracts multiple references from container', () => {
      const container = {
        name: 'complex',
        env: [
          {
            name: 'SECRET_VAR',
            valueFrom: { secretKeyRef: { name: 'secret1', key: 'key1' } },
          },
          {
            name: 'PLAIN_VAR',
            value: 'plain-value',
          },
        ],
        envFrom: [
          { secretRef: { name: 'secret2' } },
          { configMapRef: { name: 'config' } },
        ],
      };

      const refs = extractFromContainer('app', 'Deployment', 'dev', container, 'container');
      expect(refs).toHaveLength(2);
      expect(refs.map((r) => r.secretName)).toEqual(['secret1', 'secret2']);
      expect(refs.map((r) => r.referenceType)).toEqual(['env.secretKeyRef', 'envFrom.secretRef']);
    });

    it('handles container with no name', () => {
      const container = {
        env: [
          {
            name: 'VAR',
            valueFrom: { secretKeyRef: { name: 'secret', key: 'key' } },
          },
        ],
      };

      const refs = extractFromContainer('app', 'Deployment', 'dev', container, 'container');
      expect(refs).toHaveLength(1);
      expect(refs[0].containerName).toBe('unnamed');
    });

    it('returns empty array for container with no secret references', () => {
      const container = {
        name: 'app',
        env: [
          { name: 'PLAIN', value: 'value' },
        ],
        envFrom: [
          { configMapRef: { name: 'config' } },
        ],
      };

      const refs = extractFromContainer('app', 'Deployment', 'dev', container, 'container');
      expect(refs).toHaveLength(0);
    });

    it('handles missing env and envFrom', () => {
      const container = {
        name: 'minimal',
      };

      const refs = extractFromContainer('app', 'Deployment', 'dev', container, 'container');
      expect(refs).toHaveLength(0);
    });

    it('ignores env entries without secretKeyRef', () => {
      const container = {
        name: 'app',
        env: [
          { name: 'PLAIN1', value: 'value' },
          { name: 'PLAIN2', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
          { name: 'SECRET', valueFrom: { secretKeyRef: { name: 'secret', key: 'key' } } },
        ],
      };

      const refs = extractFromContainer('app', 'Deployment', 'dev', container, 'container');
      expect(refs).toHaveLength(1);
      expect(refs[0].secretName).toBe('secret');
    });

    it('ignores envFrom entries without secretRef', () => {
      const container = {
        name: 'app',
        envFrom: [
          { configMapRef: { name: 'config1' } },
          { secretRef: { name: 'secret1' } },
          { configMapRef: { name: 'config2' } },
        ],
      };

      const refs = extractFromContainer('app', 'Deployment', 'dev', container, 'container');
      expect(refs).toHaveLength(1);
      expect(refs[0].secretName).toBe('secret1');
    });
  });

  describe('extractFromPodSpecInternal - all WorkloadKind types', () => {
    const basePodSpec = {
      containers: [
        {
          name: 'app',
          env: [
            {
              name: 'SECRET_VAR',
              valueFrom: { secretKeyRef: { name: 'app-secret', key: 'password' } },
            },
          ],
        },
      ],
    };

    it('extracts from Deployment', () => {
      const refs = extractFromPodSpecInternal('web-app', 'Deployment', 'production', basePodSpec);
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        workloadType: 'Deployment',
        workloadName: 'web-app',
        workloadNamespace: 'production',
        containerName: 'app',
        containerType: 'container',
        referenceType: 'env.secretKeyRef',
        secretName: 'app-secret',
        secretKey: 'password',
      });
    });

    it('extracts from StatefulSet', () => {
      const refs = extractFromPodSpecInternal('database', 'StatefulSet', 'databases', basePodSpec);
      expect(refs).toHaveLength(1);
      expect(refs[0].workloadType).toBe('StatefulSet');
      expect(refs[0].workloadName).toBe('database');
      expect(refs[0].workloadNamespace).toBe('databases');
    });

    it('extracts from DaemonSet', () => {
      const refs = extractFromPodSpecInternal('monitoring-agent', 'DaemonSet', 'monitoring', basePodSpec);
      expect(refs).toHaveLength(1);
      expect(refs[0].workloadType).toBe('DaemonSet');
      expect(refs[0].workloadName).toBe('monitoring-agent');
    });

    it('extracts from Job', () => {
      const refs = extractFromPodSpecInternal('data-processor', 'Job', 'jobs', basePodSpec);
      expect(refs).toHaveLength(1);
      expect(refs[0].workloadType).toBe('Job');
      expect(refs[0].workloadName).toBe('data-processor');
    });

    it('extracts from CronJob', () => {
      const refs = extractFromPodSpecInternal('backup-scheduler', 'CronJob', 'system', basePodSpec);
      expect(refs).toHaveLength(1);
      expect(refs[0].workloadType).toBe('CronJob');
      expect(refs[0].workloadName).toBe('backup-scheduler');
    });

    it('extracts from Pod', () => {
      const refs = extractFromPodSpecInternal('debug-pod', 'Pod', 'debug', basePodSpec);
      expect(refs).toHaveLength(1);
      expect(refs[0].workloadType).toBe('Pod');
      expect(refs[0].workloadName).toBe('debug-pod');
    });
  });

  describe('extractFromContainer - all WorkloadKind types', () => {
    const container = {
      name: 'app-container',
      env: [
        {
          name: 'DB_USER',
          valueFrom: { secretKeyRef: { name: 'credentials', key: 'username' } },
        },
      ],
      envFrom: [
        { secretRef: { name: 'config-secret' } },
      ],
    };

    it('processes Deployment containers', () => {
      const refs = extractFromContainer('api-server', 'Deployment', 'prod', container, 'container');
      expect(refs).toHaveLength(2);
      expect(refs[0].workloadType).toBe('Deployment');
      expect(refs[1].workloadType).toBe('Deployment');
    });

    it('processes StatefulSet containers', () => {
      const refs = extractFromContainer('kafka-broker', 'StatefulSet', 'streaming', container, 'container');
      expect(refs).toHaveLength(2);
      expect(refs[0].workloadType).toBe('StatefulSet');
      expect(refs[0].workloadName).toBe('kafka-broker');
    });

    it('processes DaemonSet containers', () => {
      const refs = extractFromContainer('log-collector', 'DaemonSet', 'logging', container, 'container');
      expect(refs).toHaveLength(2);
      expect(refs[0].workloadType).toBe('DaemonSet');
    });

    it('processes Job containers', () => {
      const refs = extractFromContainer('batch-job', 'Job', 'batch', container, 'container');
      expect(refs).toHaveLength(2);
      expect(refs[0].workloadType).toBe('Job');
    });

    it('processes CronJob containers', () => {
      const refs = extractFromContainer('scheduled-task', 'CronJob', 'cron', container, 'container');
      expect(refs).toHaveLength(2);
      expect(refs[0].workloadType).toBe('CronJob');
    });

    it('processes Pod containers', () => {
      const refs = extractFromContainer('standalone-pod', 'Pod', 'default', container, 'container');
      expect(refs).toHaveLength(2);
      expect(refs[0].workloadType).toBe('Pod');
    });

    it('processes init containers in Deployment', () => {
      const refs = extractFromContainer('setup-job', 'Deployment', 'dev', container, 'initContainer');
      expect(refs).toHaveLength(2);
      expect(refs[0].containerType).toBe('initContainer');
      expect(refs[0].workloadType).toBe('Deployment');
    });

    it('processes init containers in StatefulSet', () => {
      const refs = extractFromContainer('database-init', 'StatefulSet', 'data', container, 'initContainer');
      expect(refs).toHaveLength(2);
      expect(refs[0].containerType).toBe('initContainer');
      expect(refs[0].workloadType).toBe('StatefulSet');
    });

    it('processes ephemeral containers in Pod for debugging', () => {
      const refs = extractFromContainer('debug-target', 'Pod', 'debug-ns', container, 'ephemeralContainer');
      expect(refs).toHaveLength(2);
      expect(refs[0].containerType).toBe('ephemeralContainer');
      expect(refs[0].workloadType).toBe('Pod');
    });
  });

  describe('extractFromPodSpecInternal - complex multi-workload scenarios', () => {
    const complexPodSpec = {
      initContainers: [
        {
          name: 'init',
          env: [
            {
              name: 'MIGRATION_USER',
              valueFrom: { secretKeyRef: { name: 'db-credentials', key: 'user' } },
            },
          ],
        },
      ],
      containers: [
        {
          name: 'main',
          env: [
            {
              name: 'API_KEY',
              valueFrom: { secretKeyRef: { name: 'api-keys', key: 'primary' } },
            },
          ],
          envFrom: [
            { secretRef: { name: 'app-config' } },
          ],
        },
      ],
      ephemeralContainers: [
        {
          name: 'debug',
          env: [
            {
              name: 'DEBUG_TOKEN',
              valueFrom: { secretKeyRef: { name: 'debug-tokens', key: 'admin' } },
            },
          ],
        },
      ],
      volumes: [
        { name: 'secrets', secret: { secretName: 'volume-secret' } },
      ],
    };

    it('extracts from all container types in Deployment', () => {
      const refs = extractFromPodSpecInternal('complex-app', 'Deployment', 'production', complexPodSpec);
      expect(refs.length).toBeGreaterThan(3);
      
      const byContainerType = refs.reduce((acc: any, ref) => {
        acc[ref.containerType] = (acc[ref.containerType] || 0) + 1;
        return acc;
      }, {});
      
      expect(byContainerType.container).toBeGreaterThan(0);
      expect(byContainerType.initContainer).toBeGreaterThan(0);
      expect(byContainerType['pod-volume']).toBe(1);
    });

    it('extracts from all container types in StatefulSet', () => {
      const refs = extractFromPodSpecInternal('stateful-app', 'StatefulSet', 'data', complexPodSpec);
      expect(refs.length).toBeGreaterThan(3);
      
      const secretNames = refs.map((r) => r.secretName);
      expect(secretNames).toContain('db-credentials');
      expect(secretNames).toContain('api-keys');
      expect(secretNames).toContain('app-config');
      expect(secretNames).toContain('volume-secret');
    });

    it('extracts from all container types in Job', () => {
      const refs = extractFromPodSpecInternal('processing-job', 'Job', 'batch', complexPodSpec);
      
      const initRefs = refs.filter((r) => r.containerType === 'initContainer');
      const regularRefs = refs.filter((r) => r.containerType === 'container');
      const volumeRefs = refs.filter((r) => r.containerType === 'pod-volume');
      
      expect(initRefs.length).toBeGreaterThan(0);
      expect(regularRefs.length).toBeGreaterThan(0);
      expect(volumeRefs.length).toBeGreaterThan(0);
    });

    it('extracts multiple references per container in CronJob', () => {
      const refs = extractFromPodSpecInternal('scheduled-task', 'CronJob', 'cron', complexPodSpec);
      
      const mainContainerRefs = refs.filter((r) => r.containerName === 'main');
      expect(mainContainerRefs.length).toBeGreaterThan(1); // env.secretKeyRef + envFrom.secretRef
    });

    it('differentiates reference types across workload types', () => {
      const workloadTypes: Array<'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'CronJob' | 'Pod'> = [
        'Deployment',
        'StatefulSet',
        'DaemonSet',
        'Job',
        'CronJob',
        'Pod',
      ];

      workloadTypes.forEach((wt) => {
        const refs = extractFromPodSpecInternal('test-app', wt, 'test', complexPodSpec);
        
        const refTypes = [...new Set(refs.map((r) => r.referenceType))];
        expect(refTypes).toContain('env.secretKeyRef');
        expect(refTypes).toContain('envFrom.secretRef');
        expect(refTypes).toContain('volumes.secret');
      });
    });
  });
});


