#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { verify } from './verify.js';

export async function main(): Promise<void> {
  verify('crc32', process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}