import { getRpcBaseUrl } from '@/services/rpc-client';
import type { Earthquake as ProtoEarthquake, ListEarthquakesResponse } from '@/generated/client/worldmonitor/seismology/v1/service_client';
import { createCircuitBreaker } from '@/utils/circuit-breaker';
import { getHydratedData } from '@/services/bootstrap';
import { SeismologyServiceClient } from '@/services/generated-rpc-clients';

// Proto Earthquake.source / .category (fields 12 / 13) carry USGS vs NRCan
// attribution. Keep the union so dashboard/MCP can narrow 'usgs' | 'nrcan'.
export type Earthquake = ProtoEarthquake & {
  source?: 'usgs' | 'nrcan' | string;
  category?: string;
};

const client = new SeismologyServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
// Shorter than the 10-minute natural poll, so every poll asks the server. A
// longer TTL answered polls from the client cache and, once stale, showed the
// old list while refreshing in the background: a new quake appeared one poll
// late, up to two hours after USGS published it.
const breaker = createCircuitBreaker<ListEarthquakesResponse>({ name: 'Seismology', cacheTtlMs: 5 * 60 * 1000, persistCache: true });

const emptyFallback: ListEarthquakesResponse = { earthquakes: [] };
// The poll waits for a stale refresh, so a stalled request would hold back
// the whole natural-events load. At the deadline the saved list is returned.
const EARTHQUAKE_REQUEST_TIMEOUT_MS = 10_000;

// USGS's public GeoJSON feed sends Access-Control-Allow-Origin: * (verified
// empirically), so the browser can fetch it directly -- no proxy function
// needed, unlike pizzint.watch. 2.5_week.geojson (M2.5+, past 7 days) covers
// the same rough sensitivity/recency band WorldMonitor's own RPC targets.
const USGS_FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson';

interface UsgsFeature {
  id: string;
  properties: { mag: number | null; place: string | null; time: number; url: string };
  geometry: { coordinates: [number, number, number] };
}

function fromUsgs(features: UsgsFeature[]): Earthquake[] {
  return features
    .filter((f) => f.properties.mag != null)
    .map((f) => ({
      id: f.id,
      place: f.properties.place ?? 'Unknown location',
      magnitude: f.properties.mag as number,
      depthKm: f.geometry.coordinates[2],
      location: { latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] },
      occurredAt: f.properties.time,
      sourceUrl: f.properties.url,
      source: 'usgs',
      category: '',
    }));
}

async function fetchFromUsgs(): Promise<Earthquake[] | null> {
  try {
    const resp = await fetch(USGS_FEED_URL, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { features: UsgsFeature[] };
    return fromUsgs(data.features ?? []);
  } catch {
    return null;
  }
}

// USGS's public GeoJSON feed sends Access-Control-Allow-Origin: * (verified
// empirically), so the browser can fetch it directly -- no proxy function
// needed, unlike pizzint.watch. 2.5_week.geojson (M2.5+, past 7 days) covers
// the same rough sensitivity/recency band WorldMonitor's own RPC targets.
const USGS_FEED_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson';

interface UsgsFeature {
  id: string;
  properties: { mag: number | null; place: string | null; time: number; url: string };
  geometry: { coordinates: [number, number, number] };
}

function fromUsgs(features: UsgsFeature[]): Earthquake[] {
  return features
    .filter((f) => f.properties.mag != null)
    .map((f) => ({
      id: f.id,
      place: f.properties.place ?? 'Unknown location',
      magnitude: f.properties.mag as number,
      depthKm: f.geometry.coordinates[2],
      location: { latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] },
      occurredAt: f.properties.time,
      sourceUrl: f.properties.url,
    }));
}

async function fetchFromUsgs(): Promise<Earthquake[] | null> {
  try {
    const resp = await fetch(USGS_FEED_URL, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { features: UsgsFeature[] };
    return fromUsgs(data.features ?? []);
  } catch {
    return null;
  }
}

export async function fetchEarthquakes(): Promise<Earthquake[]> {
  // Direct source first, not hydrated: the SITREP fork has no live backend
  // feeding the bootstrap hydration cache, so a hydrated 'earthquakes' entry
  // is always a stale snapshot (browser-persisted from an earlier session)
  // and must never win over a fresh USGS fetch.
  const direct = await fetchFromUsgs();
  if (direct && direct.length > 0) return direct;

  const hydrated = getHydratedData('earthquakes') as ListEarthquakesResponse | undefined;
  if (hydrated?.earthquakes?.length) {
    breaker.recordSuccess(hydrated);
    return hydrated.earthquakes as Earthquake[];
  }

  const response = await breaker.execute(async () => {
    return client.listEarthquakes(
      { minMagnitude: 0, start: 0, end: 0, pageSize: 0, cursor: '' },
      { signal: AbortSignal.timeout(EARTHQUAKE_REQUEST_TIMEOUT_MS) },
    );
  }, emptyFallback, { shouldCache: (r) => r.earthquakes.length > 0, staleRefreshMode: 'await' });
  return response.earthquakes as Earthquake[];
}
