import { PiiMaskingHelper } from '../src/utils/pii-masking.helper';

describe('PiiMaskingHelper', () => {
  describe('extractValidEmail', () => {
    it('extracts a valid address from the email attribute first', () => {
      expect(
        PiiMaskingHelper.extractValidEmail('alice@example.com', 'mailto:fallback@example.com')
      ).toBe('alice@example.com');
    });

    it('extracts and URL-decodes a mailto href with query parameters when email attr is absent', () => {
      expect(
        PiiMaskingHelper.extractValidEmail(
          null,
          'mailto:alice%2Btag%40example.com?subject=Hello'
        )
      ).toBe('alice+tag@example.com');
    });

    it('returns null for empty, non-mailto, or malformed addresses', () => {
      expect(PiiMaskingHelper.extractValidEmail(null, null)).toBeNull();
      expect(PiiMaskingHelper.extractValidEmail('', 'https://mail.google.com')).toBeNull();
      expect(PiiMaskingHelper.extractValidEmail('not-an-email', 'mailto:')).toBeNull();
      expect(PiiMaskingHelper.extractValidEmail('bad\n@example.com', null)).toBeNull();
    });
  });

  describe('maskEmail', () => {
    it('masks local parts across 1, 2, 3, and 4+ character lengths while preserving domain', () => {
      expect(PiiMaskingHelper.maskEmail('a@example.com')).toBe('*@example.com');
      expect(PiiMaskingHelper.maskEmail('ab@example.com')).toBe('a*@example.com');
      expect(PiiMaskingHelper.maskEmail('abc@example.com')).toBe('a*c@example.com');
      expect(PiiMaskingHelper.maskEmail('etiennenoel@example.com')).toBe('e***l@example.com');
    });
  });

  describe('formatDisplayLabel', () => {
    it('strips leading @/+ prefixes and preserves human display names', () => {
      const result = PiiMaskingHelper.formatDisplayLabel(
        '@Alice Smith',
        'alice.smith@example.com'
      );
      expect(result).toEqual({
        displayLabel: 'Alice Smith',
        hasDistinctDisplayName: true,
      });
    });

    it('masks the display label when Gmail falls back to displaying a raw email address', () => {
      const result = PiiMaskingHelper.formatDisplayLabel(
        '@alice@example.com',
        'alice@example.com'
      );
      expect(result).toEqual({
        displayLabel: 'a***e@example.com',
        hasDistinctDisplayName: false,
      });
      expect(result.displayLabel).not.toContain('alice@');
    });
  });
});
