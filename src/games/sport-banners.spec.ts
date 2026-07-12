import { readdirSync } from 'node:fs';
import {
  DEFAULT_BANNER_SLUG,
  SPORTS_DIR,
  SPORT_CATALOG,
  bannerForSport,
  defaultBanner,
  isStockBanner,
  normalizeSport,
  pickBannerFile,
  resetBannerCache,
} from './sport-banners';

// `bannerForSport`/`defaultBanner` resolve against whatever is actually in
// `public/sports`, so the listing is mocked here: the resolution *rules* are
// what these tests are about, and pinning them to the committed assets means
// that dropping in a real photo for a sport (or swapping an extension) breaks
// tests that have nothing to do with the change. Which files ship is asserted
// separately, and extension-agnostically, in `committed banner assets` below.
jest.mock('node:fs', () => ({ readdirSync: jest.fn() }));

const mockReaddir = readdirSync as jest.MockedFunction<typeof readdirSync>;

/** Point the resolver at a synthetic `public/sports` listing. */
function givenBannerFiles(...files: string[]): void {
  mockReaddir.mockReturnValue(files as never);
  resetBannerCache(); // the listing is cached; drop it so the next call re-reads
}

describe('sport-banners', () => {
  beforeEach(() => {
    givenBannerFiles(`${DEFAULT_BANNER_SLUG}.svg`);
  });

  describe('normalizeSport', () => {
    it('lowercases and hyphenates spaces/underscores', () => {
      expect(normalizeSport('Soccer')).toBe('soccer');
      expect(normalizeSport('  TENNIS ')).toBe('tennis');
      expect(normalizeSport('Table Tennis')).toBe('table-tennis');
      expect(normalizeSport('table_tennis')).toBe('table-tennis');
    });

    it('maps common variants onto a canonical slug', () => {
      expect(normalizeSport('tabletennis')).toBe('table-tennis');
      expect(normalizeSport('ping pong')).toBe('table-tennis');
      expect(normalizeSport('Motorsports')).toBe('motorsport');
      expect(normalizeSport('snowboarding')).toBe('snowboard');
    });

    it('returns the slug unchanged when unrecognized', () => {
      expect(normalizeSport('quidditch')).toBe('quidditch');
    });
  });

  describe('bannerForSport', () => {
    it('resolves a sport to its committed banner', () => {
      givenBannerFiles('soccer.svg', 'default.svg');
      expect(bannerForSport('soccer')).toBe('/sports/soccer.svg');
    });

    it('prefers a real photo over the SVG placeholder', () => {
      givenBannerFiles('soccer.svg', 'soccer.jpg', 'default.svg');
      expect(bannerForSport('soccer')).toBe('/sports/soccer.jpg');
    });

    it('matches regardless of casing/spacing', () => {
      givenBannerFiles('basketball.jpg', 'table-tennis.jpg', 'default.svg');
      expect(bannerForSport('Basketball')).toBe('/sports/basketball.jpg');
      expect(bannerForSport('Table Tennis')).toBe('/sports/table-tennis.jpg');
    });

    it('falls back to the default banner for unknown sports', () => {
      expect(bannerForSport('quidditch')).toBe(defaultBanner());
      expect(bannerForSport('')).toBe(defaultBanner());
    });

    it('falls back to the default banner when the sport has no file', () => {
      givenBannerFiles('default.svg'); // catalog sport, but nothing on disk
      expect(bannerForSport('soccer')).toBe('/sports/default.svg');
    });

    it('falls back to the default path when the banner directory is missing', () => {
      mockReaddir.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      resetBannerCache();
      expect(bannerForSport('soccer')).toBe('/sports/default.svg');
    });
  });

  describe('pickBannerFile (extension priority)', () => {
    it('uses the SVG placeholder when it is the only file', () => {
      expect(pickBannerFile('soccer', ['soccer.svg'])).toBe('soccer.svg');
    });

    it('prefers a real photo over the SVG placeholder', () => {
      expect(pickBannerFile('soccer', ['soccer.svg', 'soccer.jpg'])).toBe(
        'soccer.jpg',
      );
      expect(pickBannerFile('soccer', ['soccer.svg', 'soccer.png'])).toBe(
        'soccer.png',
      );
    });

    it('prefers .jpg over .png when both exist', () => {
      expect(pickBannerFile('soccer', ['soccer.png', 'soccer.jpg'])).toBe(
        'soccer.jpg',
      );
    });

    it('ignores files for other slugs and returns null when none match', () => {
      expect(pickBannerFile('soccer', ['tennis.jpg', 'default.svg'])).toBeNull();
    });
  });

  describe('defaultBanner', () => {
    it('resolves to the committed placeholder', () => {
      expect(defaultBanner()).toBe('/sports/default.svg');
    });

    it('prefers a real default photo over the placeholder', () => {
      givenBannerFiles('default.svg', 'default.jpg');
      expect(defaultBanner()).toBe('/sports/default.jpg');
    });
  });

  describe('isStockBanner', () => {
    it('treats stock paths and empty values as stock', () => {
      expect(isStockBanner('/sports/soccer.svg')).toBe(true);
      expect(isStockBanner('/sports/soccer.jpg')).toBe(true);
      expect(isStockBanner(defaultBanner())).toBe(true);
      expect(isStockBanner(undefined)).toBe(true);
      expect(isStockBanner('')).toBe(true);
    });

    it('treats a host-supplied URL as not stock', () => {
      expect(isStockBanner('https://cdn.squadup.app/games/abc.jpg')).toBe(false);
    });
  });

  // Guards the assets themselves rather than the resolver: every sport a host
  // can pick must have a banner committed, or its games fall back to the
  // generic default. Deliberately extension-agnostic — a sport is covered by a
  // .jpg, .png or .svg alike, so replacing a placeholder with a real photo is
  // not a test change.
  describe('committed banner assets', () => {
    const onDisk = new Set(
      jest.requireActual<typeof import('node:fs')>('node:fs').readdirSync(
        SPORTS_DIR,
      ),
    );

    it.each(Object.keys(SPORT_CATALOG))('ships a banner for %s', (slug) => {
      expect(pickBannerFile(slug, onDisk)).not.toBeNull();
    });

    it('ships the fallback default banner', () => {
      expect(pickBannerFile(DEFAULT_BANNER_SLUG, onDisk)).not.toBeNull();
    });
  });
});
