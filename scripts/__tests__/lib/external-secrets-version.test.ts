import { describe, expect, it } from 'vitest';
import { formatSecretVersion } from '../../list-external-secrets.js';

describe('list-external-secrets version formatting', () => {
  it.each([
    ['version-id', 'uuid/version-id'],
    ['uuid/version-id', 'uuid/version-id'],
    ['terraform-20260212133048976200000002', 'uuid/terraform-20260212133048976200000002'],
    ['AWSCURRENT', 'AWSCURRENT'],
    ['AWSPREVIOUS', 'AWSPREVIOUS'],
  ])('formats %s as %s', (version, expected) => {
    expect(formatSecretVersion(version)).toBe(expected);
    expect(formatSecretVersion(expected)).toBe(expected);
  });
});
