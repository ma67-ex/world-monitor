// Read the generated server slice, never shared/news-catalog: a value import
// from it bundles the whole catalog JSON into the digest and MCP functions.
import { SERVER_NEWS_CATALOG } from '../../../../shared/news-catalog.server.generated';
import { hashString } from '../../../_shared/hash';

export interface ServerFeed {
  name: string;
  url: string;
  lang?: string;
  /** Headline language where `lang` (routing) does not say it; see feedHeadlineLanguage. */
  headlineLang?: string;
  fetchInAllLanguages?: boolean;
  strategicDefault?: boolean;
  /**
   * Positive values start earlier in a cold digest build. This is a fetch
   * scheduling hint only; it does not affect ranking, source tier, or UI
   * default selection.
   */
  deadlinePriority?: number;
  /**
   * A deeper feed for the same publisher, fetched with this one in the full
   * variant and cached under its own URL. Only claim search (/verify,
   * verify_claim) reads it; the digest and panels never see its items.
   */
  depthUrl?: string;
  /**
   * The feed republishes a dated snapshot: items carry no date of their own,
   * so an undated item takes the channel's date. Opt-in per feed, because a
   * static page that only dates its channel must still fail the date gate.
   */
  channelDated?: boolean;
  /**
   * Hosts this feed's items link to besides the feed host and its publisher
   * family's domains, for a feed that lists another site's pages (GitHub
   * Trending links to github.com). A host many owners share belongs here, on
   * the one feed, never in a publisher family.
   */
  linkHosts?: string[];
  /**
   * Link path segments that mark items outside this feed's scope (CNN's
   * site-wide news sitemap lists video clips and shopping pages). An item
   * whose link path has one of these segments is dropped before ranking.
   */
  excludePathSegments?: string[];
}

/**
 * The language a feed's headlines are written in. `lang` routes a feed to a
 * digest; an English Google News query returns English headlines whatever it
 * is routed to. `headlineLang` states the language where neither holds: a
 * local-language outlet kept untagged so the English dashboard shows it.
 * scripts/lib/digest-stale-gate.cjs applies the same rule to the catalog
 * (tests/news-alert-pool.test.mts holds the two together).
 */
export function feedHeadlineLanguage(feed: Pick<ServerFeed, 'lang' | 'headlineLang' | 'url'>): string {
  if (feed.headlineLang) return feed.headlineLang;
  return !feed.lang || /^https:\/\/news\.google\.com\/.*[?&]hl=en\b/.test(feed.url) ? 'en' : feed.lang;
}

/** Match the digest language unless the catalog explicitly permits cross-language fetching. */
export function isServerFeedReachableForLanguage(
  feed: Pick<ServerFeed, 'lang' | 'strategicDefault' | 'fetchInAllLanguages'>,
  language: string,
): boolean {
  return !feed.lang || feed.lang === language || !!feed.strategicDefault || !!feed.fetchInAllLanguages;
}

/**
 * Order feeds for a time-boxed digest build.
 *
 * `deadlinePriority` feeds go first, highest first (an explicit "fetch this
 * before anything else" hint) — unchanged from before.
 *
 * Everything else (the vast majority: every feed defaults to priority 0) used
 * to fall back to declaration order, i.e. straight through `VARIANT_FEEDS` one
 * category at a time. With ~240 feeds and a ~10s build deadline
 * (OVERALL_DEADLINE_MS), a cold build routinely runs out of time partway
 * through that list — and because the list is grouped by category, "partway
 * through" always lands at the same place: africa/latam/asia/energy/
 * thinktanks/crisis/layoffs sit last in `VARIANT_FEEDS.full` and got zero
 * feeds attempted on every single cold build, cycle after cycle, while
 * politics/us/europe at the front always finished. Not a flaky feed, not bad
 * luck — the ordering guaranteed those categories go empty every time the
 * deadline is tight (#weeks-of-UNAVAILABLE).
 *
 * Fix: round-robin the no-priority feeds across categories — one feed from
 * every category, then a second from every category, and so on — so a
 * deadline cutoff costs each category a few of its later feeds instead of
 * wiping out whole categories wholesale.
 */
export function orderServerFeedEntries<T extends {
  category: string;
  feed: Pick<ServerFeed, 'deadlinePriority'>;
}>(entries: readonly T[]): T[] {
  const prioritized: { entry: T; index: number }[] = [];
  const byCategory = new Map<string, T[]>();

  entries.forEach((entry, index) => {
    if (Number.isFinite(entry.feed.deadlinePriority) && entry.feed.deadlinePriority !== 0) {
      prioritized.push({ entry, index });
      return;
    }
    const bucket = byCategory.get(entry.category);
    if (bucket) bucket.push(entry);
    else byCategory.set(entry.category, [entry]);
  });

  prioritized.sort((a, b) => b.entry.feed.deadlinePriority! - a.entry.feed.deadlinePriority! || a.index - b.index);

  const categoryBuckets = [...byCategory.values()];
  const roundRobin: T[] = [];
  for (let rank = 0; roundRobin.length < entries.length - prioritized.length; rank++) {
    for (const bucket of categoryBuckets) {
      if (rank < bucket.length) roundRobin.push(bucket[rank]!);
    }
  }

  return [...prioritized.map(({ entry }) => entry), ...roundRobin];
}

// Feeds are declared once in shared/news-catalog.json; these are its server
// view, in server order.
export const VARIANT_FEEDS: Record<string, Record<string, ServerFeed[]>> = SERVER_NEWS_CATALOG.variantFeeds;

export const INTEL_SOURCES: ServerFeed[] = SERVER_NEWS_CATALOG.intelSources;

/** Every edition the digest builds. Derived from the catalog layout. */
export const SERVER_EDITIONS: readonly string[] = SERVER_NEWS_CATALOG.editions;

export interface DigestGateProfile {
  /** Categories the last-good gate leaves out of its category count. */
  exemptCategories: string[];
  /**
   * Fingerprint of the feeds this edition's digest fetches. When it differs
   * from the accepted snapshot's, the snapshot was built from a different
   * catalog, so it cannot veto a candidate and its item peak resets.
   */
  catalogFingerprint: string;
}

const gateProfiles = new Map<string, DigestGateProfile>();

export function digestGateProfile(variant: string): DigestGateProfile {
  const cached = gateProfiles.get(variant);
  if (cached) return cached;
  const categories = VARIANT_FEEDS[variant] ?? {};
  const shape = Object.entries(categories).map(([category, feeds]) => [category, feeds.map((f) => f.url)]);
  if (variant === 'full') shape.push(['intel', INTEL_SOURCES.map((f) => f.url)]);
  const profile: DigestGateProfile = {
    exemptCategories: [...(SERVER_NEWS_CATALOG.gateExempt[variant] ?? [])],
    catalogFingerprint: hashString(JSON.stringify(shape)),
  };
  gateProfiles.set(variant, profile);
  return profile;
}
