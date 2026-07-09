/**
 * Sport banners: every game gets a header image. When the host doesn't supply
 * their own, we default to a stock banner for the game's sport.
 *
 * The bytes are static placeholders committed under `public/sports/` and served
 * at `/sports/...` (see `main.ts`); regenerate the SVG defaults with
 * `npm run banners:generate`. Only the relative URL is stored on the game row
 * (`photo_url`), the same way avatars store a path. The resolver reads what's
 * actually on disk and prefers a real `.jpg`/`.png` over the placeholder
 * `.svg`, so dropping in `soccer.jpg` takes effect without touching code (a
 * restart refreshes the listing).
 *
 * Sport matching is lenient (matching the front-end): the value is normalized
 * to a slug, common variants are aliased, and anything unrecognized falls back
 * to a generic default banner rather than being rejected.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** URL prefix the banners are served under (kept in sync with `main.ts`). */
export const SPORTS_URL_PREFIX = '/sports';
/** On-disk directory holding the committed banner files. */
export const SPORTS_DIR = join(process.cwd(), 'public', 'sports');
/** Base name of the fallback banner used for unrecognized sports. */
export const DEFAULT_BANNER_SLUG = 'default';
/**
 * Accepted banner extensions, in resolution priority: a real photo wins over
 * the shipped SVG placeholder, so a `soccer.jpg` is used without having to
 * delete `soccer.svg`.
 */
export const BANNER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.svg'] as const;

/** Canonical sports (slug → display name). Banners are keyed by the slug. */
export const SPORT_CATALOG: Record<string, string> = {
  soccer: 'Soccer',
  football: 'Football',
  basketball: 'Basketball',
  baseball: 'Baseball',
  tennis: 'Tennis',
  golf: 'Golf',
  hockey: 'Hockey',
  volleyball: 'Volleyball',
  rugby: 'Rugby',
  cricket: 'Cricket',
  boxing: 'Boxing',
  swimming: 'Swimming',
  running: 'Running',
  cycling: 'Cycling',
  skiing: 'Skiing',
  snowboard: 'Snowboard',
  surfing: 'Surfing',
  'table-tennis': 'Table Tennis',
  badminton: 'Badminton',
  bowling: 'Bowling',
  darts: 'Darts',
  esports: 'Esports',
  motorsport: 'Motorsport',
  spikeball: 'Spikeball',
};

/** Common variant spellings mapped onto a canonical slug. */
const SPORT_ALIASES: Record<string, string> = {
  tabletennis: 'table-tennis',
  pingpong: 'table-tennis',
  esport: 'esports',
  gaming: 'esports',
  motorsports: 'motorsport',
  racing: 'motorsport',
  snowboarding: 'snowboard',
  cycle: 'cycling',
  biking: 'cycling',
  bike: 'cycling',
  swim: 'swimming',
  run: 'running',
  jog: 'running',
  jogging: 'running',
  footy: 'soccer',
};

/**
 * Reduce a free-text sport to a canonical slug: lowercased, spaces/underscores
 * to hyphens, with a few common variants aliased. Returns the input slug
 * unchanged when it isn't recognized (callers decide how to handle that).
 */
export function normalizeSport(sport: string): string {
  const slug = (sport ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (slug in SPORT_CATALOG) return slug;
  const collapsed = slug.replace(/-/g, '');
  return SPORT_ALIASES[slug] ?? SPORT_ALIASES[collapsed] ?? slug;
}

/**
 * Pick the best banner filename for a slug from a set of available files,
 * honoring BANNER_EXTENSIONS priority (real photo over SVG placeholder). Pure:
 * the caller supplies the directory listing.
 */
export function pickBannerFile(
  slug: string,
  available: Iterable<string>,
): string | null {
  const set = available instanceof Set ? available : new Set(available);
  for (const ext of BANNER_EXTENSIONS) {
    const name = `${slug}${ext}`;
    if (set.has(name)) return name;
  }
  return null;
}

// The banner directory is read once and cached — banners are deploy-time
// assets, so a restart is enough to pick up newly added files.
let bannerDirCache: Set<string> | null = null;

function sportsDirFiles(): Set<string> {
  if (!bannerDirCache) {
    try {
      bannerDirCache = new Set(readdirSync(SPORTS_DIR));
    } catch {
      bannerDirCache = new Set(); // dir missing — fall through to the default
    }
  }
  return bannerDirCache;
}

/** Test hook: drop the cached directory listing so the next call re-reads. */
export function resetBannerCache(): void {
  bannerDirCache = null;
}

/** Resolve a slug to the URL of the best file present, or null if none. */
function bannerPath(slug: string): string | null {
  const file = pickBannerFile(slug, sportsDirFiles());
  return file ? `${SPORTS_URL_PREFIX}/${file}` : null;
}

/** The fallback banner path (whichever extension `default.*` exists as). */
export function defaultBanner(): string {
  return (
    bannerPath(DEFAULT_BANNER_SLUG) ??
    `${SPORTS_URL_PREFIX}/${DEFAULT_BANNER_SLUG}.svg`
  );
}

/**
 * The stock banner path for a sport, resolved to the actual file on disk
 * (preferring a real .jpg/.png over the .svg placeholder), or the default
 * banner when the sport is unrecognized or has no file.
 */
export function bannerForSport(sport: string): string {
  const slug = normalizeSport(sport);
  if (slug in SPORT_CATALOG) {
    return bannerPath(slug) ?? defaultBanner();
  }
  return defaultBanner();
}

/**
 * Whether a `photo_url` is one of our stock banners (or empty) rather than a
 * host-supplied image — used to decide if the banner should follow a sport
 * change on edit without clobbering a custom picture.
 */
export function isStockBanner(url?: string | null): boolean {
  return !url || url.startsWith(`${SPORTS_URL_PREFIX}/`);
}
