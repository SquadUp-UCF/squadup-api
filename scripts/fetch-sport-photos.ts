/**
 * Fetch a real stock photo for each sport from Pexels and crop it to a uniform
 * banner (1200×400) under `public/sports/<slug>.jpg`.
 *
 * Pexels' license allows downloading, modifying, and redistributing photos
 * (including committing them here) with no attribution required. The extension-
 * aware resolver prefers these `.jpg`s over the `.svg` placeholders, so the SVGs
 * stay as a fallback and nothing else needs to change.
 *
 * Setup: create a free key at https://www.pexels.com/api/ and put it in `.env`
 *   PEXELS_API_KEY=xxxxxxxx
 * Then run: `npm run banners:fetch`
 *
 * Re-run any time to refresh; pass slugs to limit it, e.g.
 *   npm run banners:fetch -- soccer tennis
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { SPORT_CATALOG, SPORTS_DIR } from '../src/games/sport-banners';

const BANNER_W = 1200;
const BANNER_H = 400;
const JPEG_QUALITY = 82;
/** How many options to pull per sport in `--candidates` mode. */
const CANDIDATE_COUNT = 6;
/** Scratch dir for candidate options (gitignored; removed after `--pick`). */
const CANDIDATES_DIR = join(SPORTS_DIR, '_candidates');

/** Search terms tuned per sport (falls back to the display name). */
const QUERIES: Record<string, string> = {
  soccer: 'soccer match',
  football: 'american football game',
  basketball: 'basketball player dunk court',
  baseball: 'baseball game',
  tennis: 'tennis player court',
  golf: 'golf course player',
  hockey: 'ice hockey players match',
  volleyball: 'volleyball game',
  rugby: 'rugby players ball tackle',
  cricket: 'cricket batsman playing match',
  boxing: 'boxing ring',
  swimming: 'swimming pool race',
  running: 'running race track',
  cycling: 'road cycling race',
  skiing: 'alpine skiing',
  snowboard: 'snowboarding',
  surfing: 'surfing wave',
  'table-tennis': 'table tennis',
  badminton: 'badminton player',
  bowling: 'bowling alley',
  darts: 'darts board',
  esports: 'esports gaming arena',
  motorsport: 'motorsport racing car',
  spikeball: 'roundnet spikeball players',
};

/** Read a single key out of `.env` without pulling in a dotenv dependency. */
function envKey(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(join(process.cwd(), '.env'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  } catch {
    return undefined;
  }
}

function sips(args: string[]): void {
  execFileSync('sips', args, { stdio: 'ignore' });
}

function dimsOf(file: string): { w: number; h: number } {
  const out = execFileSync('sips', [
    '-g',
    'pixelWidth',
    '-g',
    'pixelHeight',
    file,
  ]).toString();
  return {
    w: Number(out.match(/pixelWidth:\s*(\d+)/)?.[1]),
    h: Number(out.match(/pixelHeight:\s*(\d+)/)?.[1]),
  };
}

/** Center "cover" crop to exactly BANNER_W×BANNER_H (scale to fill, then trim). */
export function coverCrop(src: string, out: string): void {
  const { w, h } = dimsOf(src);
  const scaled = `${src}.scaled.jpg`;
  // Scale so the limiting side reaches the target, leaving the other ≥ target.
  if (w / h > BANNER_W / BANNER_H) {
    sips(['--resampleHeight', String(BANNER_H), src, '--out', scaled]);
  } else {
    sips(['--resampleWidth', String(BANNER_W), src, '--out', scaled]);
  }
  sips([
    '-s',
    'format',
    'jpeg',
    '-s',
    'formatOptions',
    String(JPEG_QUALITY),
    '--cropToHeightWidth',
    String(BANNER_H),
    String(BANNER_W),
    scaled,
    '--out',
    out,
  ]);
  rmSync(scaled, { force: true });
}

async function pexelsSources(
  query: string,
  key: string,
  count: number,
): Promise<string[]> {
  const url =
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}` +
    `&orientation=landscape&size=large&per_page=${count}`;
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) throw new Error(`Pexels ${res.status} ${res.statusText}`);
  const data = (await res.json()) as {
    photos?: { src?: { large2x?: string; original?: string; landscape?: string } }[];
  };
  return (data.photos ?? [])
    .map((p) => p.src?.large2x ?? p.src?.original ?? p.src?.landscape)
    .filter((u): u is string => Boolean(u));
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) throw new Error(`not an image (${type})`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Download a URL and crop it into `dest`, cleaning up the raw download. */
async function downloadCropped(url: string, dest: string): Promise<void> {
  const tmp = `${dest}.download`;
  try {
    await download(url, tmp);
    coverCrop(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Default mode: fetch the top result for each slug and crop it into place. */
async function fetchTop(slugs: string[], key: string): Promise<void> {
  const failed: string[] = [];
  for (const slug of slugs) {
    const query = QUERIES[slug] ?? SPORT_CATALOG[slug];
    try {
      const [url] = await pexelsSources(query, key, 1);
      if (!url) throw new Error('no results');
      await downloadCropped(url, join(SPORTS_DIR, `${slug}.jpg`));
      console.log(`✓ ${slug}  (“${query}”)`);
    } catch (err) {
      failed.push(slug);
      console.warn(`✗ ${slug}: ${(err as Error).message} — keeping existing`);
    }
    await new Promise((r) => setTimeout(r, 300)); // be polite to the API
  }
  console.log(
    `\nDone: ${slugs.length - failed.length}/${slugs.length} saved to ${SPORTS_DIR}` +
      (failed.length ? `\nFailed: ${failed.join(', ')}` : ''),
  );
}

/** `--candidates` mode: pull several options per slug and build a review sheet. */
async function fetchCandidates(slugs: string[], key: string): Promise<void> {
  mkdirSync(CANDIDATES_DIR, { recursive: true });
  const counts: Record<string, number> = {};
  for (const slug of slugs) {
    const query = QUERIES[slug] ?? SPORT_CATALOG[slug];
    const urls = await pexelsSources(query, key, CANDIDATE_COUNT);
    let i = 0;
    for (const url of urls) {
      try {
        await downloadCropped(url, join(CANDIDATES_DIR, `${slug}-${i}.jpg`));
        i++;
      } catch {
        /* skip a bad candidate */
      }
    }
    counts[slug] = i;
    console.log(`• ${slug}: ${i} candidates  (“${query}”)`);
    await new Promise((r) => setTimeout(r, 300));
  }

  writeCandidateSheet(counts);
  const picks = slugs.map((s) => `${s}=N`).join(' ');
  console.log(`\nReview:  ${join(CANDIDATES_DIR, 'index.html')}`);
  console.log(`Then:    npm run banners:fetch -- --pick ${picks}`);
}

/** `--pick slug=index …` mode: promote chosen candidates, then clean up. */
function pickCandidates(pairs: string[]): void {
  for (const pair of pairs) {
    const [slug, idx] = pair.split('=');
    const src = join(CANDIDATES_DIR, `${slug}-${idx}.jpg`);
    if (!(slug in SPORT_CATALOG) || idx === undefined || !existsSync(src)) {
      console.warn(`✗ ${pair}: no such candidate`);
      continue;
    }
    copyFileSync(src, join(SPORTS_DIR, `${slug}.jpg`));
    console.log(`✓ ${slug} ← candidate #${idx}`);
  }
  rmSync(CANDIDATES_DIR, { recursive: true, force: true });
  console.log('Cleaned up candidates.');
}

/** Contact sheet of the cropped candidates, written next to them. */
function writeCandidateSheet(counts: Record<string, number>): void {
  const sections = Object.entries(counts)
    .map(([slug, count]) => {
      const imgs = Array.from(
        { length: count },
        (_, i) =>
          `<figure><img src="${slug}-${i}.jpg"/><figcaption>${slug} <b>#${i}</b></figcaption></figure>`,
      ).join('');
      return `<h2>${SPORT_CATALOG[slug]} <code>${slug}</code></h2><div class="row">${imgs}</div>`;
    })
    .join('\n');
  const html = `<!doctype html><meta charset="utf8"><title>Banner candidates</title><style>body{font:14px system-ui;background:#111;color:#eee;margin:24px}h1{font-size:18px}h2{font-size:15px;margin:24px 0 4px}img{width:330px;height:110px;object-fit:cover;border-radius:10px;display:block}figure{margin:0}figcaption{margin:6px 0 0;color:#bbb}code{color:#7dd3fc}.row{display:flex;flex-wrap:wrap;gap:16px}</style><h1>Pick one <b>#</b> per sport (shown at the card's crop ratio)</h1>${sections}`;
  writeFileSync(join(CANDIDATES_DIR, 'index.html'), html);
}

async function main(): Promise<void> {
  const key = envKey('PEXELS_API_KEY');
  if (!key) {
    console.error(
      'Missing PEXELS_API_KEY. Get a free key at https://www.pexels.com/api/ ' +
        'and add `PEXELS_API_KEY=...` to .env, then re-run `npm run banners:fetch`.',
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const validSlugs = (xs: string[]) => xs.filter((s) => s in SPORT_CATALOG);

  if (args[0] === '--candidates') {
    const slugs = validSlugs(args.slice(1));
    if (!slugs.length) {
      console.error('Usage: --candidates <slug> [slug…]');
      process.exit(1);
    }
    await fetchCandidates(slugs, key);
    return;
  }

  if (args[0] === '--pick') {
    pickCandidates(args.slice(1));
    return;
  }

  // Default: one photo per sport — all of them, or just the slugs given.
  const slugs = args.length ? validSlugs(args) : Object.keys(SPORT_CATALOG);
  await fetchTop(slugs, key);
}

// Only fetch when run directly, so the crop helpers can be imported/tested.
if (require.main === module) {
  main();
}
