import {
  isOriginAllowed,
  normalizeCorsOrigin,
  normalizeSubdomainRoots,
} from './allowed-origins';

const matcher = (overrides: Partial<Parameters<typeof isOriginAllowed>[1]> = {}) => ({
  exactOrigins: ['https://vendor.imraaah.com'],
  subdomainRoots: ['imraaah.com'],
  isProduction: true,
  ...overrides,
});

describe('CORS origin policy', () => {
  describe('normalizeSubdomainRoots()', () => {
    it('accepts bare, schemed and dotted roots', () => {
      expect(normalizeSubdomainRoots(' imraaah.com , https://staging.imraaah.com/, .example.cn ')).toEqual([
        'imraaah.com',
        'staging.imraaah.com',
        'example.cn',
      ]);
    });

    it('drops an empty list and the wildcard token', () => {
      expect(normalizeSubdomainRoots(undefined)).toEqual([]);
      expect(normalizeSubdomainRoots('*')).toEqual([]);
    });

    it('normalizes a trailing slash off an origin', () => {
      expect(normalizeCorsOrigin('https://imraaah.com/')).toBe('https://imraaah.com');
    });
  });

  describe('production', () => {
    const options = matcher();

    it('allows the apex and any store subdomain over HTTPS', () => {
      expect(isOriginAllowed('https://imraaah.com', options)).toBe(true);
      expect(isOriginAllowed('https://zainab.imraaah.com', options)).toBe(true);
      expect(isOriginAllowed('https://www.imraaah.com', options)).toBe(true);
      expect(isOriginAllowed('https://a.b.imraaah.com', options)).toBe(true);
    });

    it('allows an exact configured origin', () => {
      expect(isOriginAllowed('https://vendor.imraaah.com', options)).toBe(true);
    });

    it('allows a request with no Origin header', () => {
      expect(isOriginAllowed(undefined, options)).toBe(true);
    });

    it('rejects HTTP for a subdomain root', () => {
      expect(isOriginAllowed('http://zainab.imraaah.com', options)).toBe(false);
    });

    it('rejects a non-default port in production', () => {
      expect(isOriginAllowed('https://zainab.imraaah.com:8443', options)).toBe(false);
    });

    it('never allows suffix spoofing', () => {
      expect(isOriginAllowed('https://imraaah.com.evil.com', options)).toBe(false);
      expect(isOriginAllowed('https://evilimraaah.com', options)).toBe(false);
    });

    it('rejects an unrelated origin', () => {
      expect(isOriginAllowed('https://preview.vercel.app', options)).toBe(false);
      expect(isOriginAllowed('https://notimraaah.com', options)).toBe(false);
    });

    it('does not allow localhost in production', () => {
      expect(isOriginAllowed('http://zainab.localhost:3002', options)).toBe(false);
    });

    it('honours an extra configured root', () => {
      const staging = matcher({ subdomainRoots: ['imraaah.com', 'staging.imraaah.com'] });
      expect(isOriginAllowed('https://zainab.staging.imraaah.com', staging)).toBe(true);
      expect(isOriginAllowed('https://zainab.imraaah.com', staging)).toBe(true);
    });
  });

  describe('development', () => {
    const options = matcher({ isProduction: false });

    it('allows a store subdomain on localhost at any port, over HTTP', () => {
      expect(isOriginAllowed('http://zineb-store.localhost:3002', options)).toBe(true);
      expect(isOriginAllowed('http://zineb-store.localhost:4000', options)).toBe(true);
      expect(isOriginAllowed('http://127.0.0.1:3002', options)).toBe(true);
    });

    it('allows the imraaah root over HTTP in development', () => {
      expect(isOriginAllowed('http://zainab.imraaah.com', options)).toBe(true);
    });

    it('still rejects unrelated origins', () => {
      expect(isOriginAllowed('http://zineb-store.example.com:3002', options)).toBe(false);
    });
  });
});
