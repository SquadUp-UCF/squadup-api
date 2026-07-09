import {
  SPORT_CATALOG,
  bannerForSport,
  defaultBanner,
  isStockBanner,
  normalizeSport,
  pickBannerFile,
} from './sport-banners';

describe('sport-banners', () => {
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
    it('resolves every catalog sport to its own SVG', () => {
      for (const slug of Object.keys(SPORT_CATALOG)) {
        expect(bannerForSport(slug)).toBe(`/sports/${slug}.svg`);
      }
    });

    it('matches regardless of casing/spacing', () => {
      expect(bannerForSport('Basketball')).toBe('/sports/basketball.svg');
      expect(bannerForSport('Table Tennis')).toBe('/sports/table-tennis.svg');
    });

    it('falls back to the default banner for unknown sports', () => {
      expect(bannerForSport('quidditch')).toBe(defaultBanner());
      expect(bannerForSport('')).toBe(defaultBanner());
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
    it('resolves to the committed default placeholder', () => {
      expect(defaultBanner()).toBe('/sports/default.svg');
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
});
