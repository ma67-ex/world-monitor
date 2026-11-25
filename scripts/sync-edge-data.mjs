#!/usr/bin/env node
// Copies large Edge-only data blobs to public/data/edge/ so Edge Function
// bundles stay under the Vercel Hobby 1 MB limit (see shared/static-data.ts).
// `--check` exits 1 when a copy is missing or stale.
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/data/edge');
const FILES = [
  'shared/population-density-boundaries.json',
];

const check = process.argv.includes('--check');
let stale = 0;
mkdirSync(OUT, { recursive: true });
for (const src of FILES) {
  const from = join(ROOT, src);
  const to = join(OUT, src.split('/').pop());
  if (check) {
    if (!existsSync(to) || !readFileSync(from).equals(readFileSync(to))) {
      console.error(`stale: ${to} — run: node scripts/sync-edge-data.mjs`);
      stale++;
    }
  } else {
    copyFileSync(from, to);
  }
}
process.exit(stale ? 1 : 0);
