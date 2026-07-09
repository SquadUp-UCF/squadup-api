/**
 * Generate the stock sport banner placeholders committed under `public/sports/`.
 *
 * Each sport gets a distinct, deterministic-colored SVG with its name; there's
 * also a neutral green `default.svg` for unrecognized sports. These are
 * intentionally simple placeholders — replace any file with a real licensed
 * photo of the same name and the app picks it up with no code change.
 *
 * Run with: `npm run banners:generate`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPORT_CATALOG, SPORTS_DIR } from '../src/games/sport-banners';

/** Stable hue in [0,360) derived from the slug, so colors never shuffle. */
function hueFor(slug: string): number {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** A 1200×400 banner: diagonal gradient, soft blobs, name + wordmark. */
function bannerSvg(name: string, c1: string, c2: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 400" width="1200" height="400" role="img" aria-label="${name}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/>
      <stop offset="1" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="400" fill="url(#bg)"/>
  <circle cx="1010" cy="110" r="250" fill="#ffffff" opacity="0.06"/>
  <circle cx="170" cy="380" r="190" fill="#000000" opacity="0.06"/>
  <text x="72" y="218" font-family="'Segoe UI', system-ui, Arial, sans-serif" font-size="98" font-weight="800" fill="#ffffff">${name}</text>
  <text x="76" y="276" font-family="'Segoe UI', system-ui, Arial, sans-serif" font-size="26" font-weight="700" letter-spacing="8" fill="#ffffff" opacity="0.72">SQUAD-UP</text>
</svg>
`;
}

function main(): void {
  mkdirSync(SPORTS_DIR, { recursive: true });

  for (const [slug, name] of Object.entries(SPORT_CATALOG)) {
    const h = hueFor(slug);
    const svg = bannerSvg(name, `hsl(${h}, 62%, 44%)`, `hsl(${(h + 28) % 360}, 66%, 26%)`);
    writeFileSync(join(SPORTS_DIR, `${slug}.svg`), svg);
  }

  // Brand-green fallback used when a sport has no dedicated banner.
  writeFileSync(
    join(SPORTS_DIR, 'default.svg'),
    bannerSvg('SquadUp', '#1b7a32', '#0d4a1e'),
  );

  const count = Object.keys(SPORT_CATALOG).length + 1;
  console.log(`Wrote ${count} banners to ${SPORTS_DIR}`);
}

main();
