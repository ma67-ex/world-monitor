/**
 * Loads large read-only JSON that is served from `public/data/edge/` instead
 * of being bundled, keeping Edge Function bundles under the Vercel Hobby 1 MB
 * limit. `scripts/sync-edge-data.mjs` copies the canonical files there.
 *
 * Edge: fetched from the deployment's own origin. Node (tests, scripts,
 * sidecar): read from disk. Results are cached per file for the isolate.
 */

const cache = new Map<string, Promise<unknown>>();

function envOrigin(): string {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  const explicit = env?.WORLDMONITOR_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const host = env?.VERCEL_PROJECT_PRODUCTION_URL || env?.VERCEL_URL;
  return host ? `https://${host}` : 'https://www.worldmonitor.app';
}

export function loadStaticJson<T>(file: string, origin?: string): Promise<T> {
  let hit = cache.get(file) as Promise<T> | undefined;
  if (!hit) {
    hit = (async () => {
      if (typeof process !== 'undefined' && process.versions?.node) {
        try {
          // Non-literal specifiers keep node builtins out of Edge bundles.
          const fsSpecifier = 'node:fs/promises';
          const { readFile } = await import(/* @vite-ignore */ fsSpecifier);
          return JSON.parse(await readFile(new URL(`../public/data/edge/${file}`, import.meta.url), 'utf8')) as T;
        } catch {
          // Bundled Node (sidecar): no repo files on disk, use HTTP.
        }
      }
      const res = await fetch(`${origin ?? envOrigin()}/data/edge/${file}`);
      if (!res.ok) throw new Error(`static data ${file}: HTTP ${res.status}`);
      return await res.json() as T;
    })();
    hit.catch(() => cache.delete(file));
    cache.set(file, hit);
  }
  return hit;
}
