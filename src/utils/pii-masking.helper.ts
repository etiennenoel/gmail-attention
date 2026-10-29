const MAX_EMAIL_LENGTH = 320;
const MAX_DISPLAY_LABEL_LENGTH = 120;
const EMAIL_SHAPE_REGEX = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const LOCAL_DOMAIN_EMAIL_REGEX = /^[^\s@<>]+@[^\s@<>]+$/;

/**
 * Sanitizes and masks contact PII extracted from Gmail mention chips so full
 * email addresses are never surfaced in extension UI labels or logs.
 */
export class PiiMaskingHelper {
  /**
   * Extracts and validates an email address from a Gmail mention chip's
   * `email` attribute or `mailto:` `href` attribute.
   */
  public static extractValidEmail(
    emailAttribute: string | null,
    hrefAttribute: string | null
  ): string | null {
    const candidateFromAttr = emailAttribute?.trim() ?? '';
    if (PiiMaskingHelper.isValidEmailShape(candidateFromAttr)) {
      return candidateFromAttr;
    }

    const rawHref = hrefAttribute?.trim() ?? '';
    if (rawHref.toLowerCase().startsWith('mailto:')) {
      const withoutScheme = rawHref.slice('mailto:'.length);
      const addressPart = withoutScheme.split('?')[0]?.trim() ?? '';
      let decoded = addressPart;
      try {
        decoded = decodeURIComponent(addressPart).trim();
      } catch {
        decoded = addressPart;
      }
      if (PiiMaskingHelper.isValidEmailShape(decoded)) {
        return decoded;
      }
    }

    return null;
  }

  /**
   * Checks whether a string conforms to a safe, bounded email address shape.
   */
  public static isValidEmailShape(candidate: string): boolean {
    if (
      candidate.length === 0 ||
      candidate.length > MAX_EMAIL_LENGTH ||
      /[\u0000-\u001F\u007F]/.test(candidate)
    ) {
      return false;
    }
    return (
      EMAIL_SHAPE_REGEX.test(candidate) ||
      LOCAL_DOMAIN_EMAIL_REGEX.test(candidate)
    );
  }

  /**
   * Masks an email address for safe UI display (e.g., `alice@example.com` -> `a***e@example.com`).
   */
  public static maskEmail(rawEmail: string): string {
    const trimmed = rawEmail.trim();
    const atIndex = trimmed.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === trimmed.length - 1) {
      if (trimmed.length <= 2) {
        return '***';
      }
      return `${trimmed.charAt(0)}***${trimmed.charAt(trimmed.length - 1)}`;
    }

    const localPart = trimmed.slice(0, atIndex);
    const domainPart = trimmed.slice(atIndex + 1);

    let maskedLocal: string;
    if (localPart.length === 1) {
      maskedLocal = '*';
    } else if (localPart.length === 2) {
      maskedLocal = `${localPart.charAt(0)}*`;
    } else if (localPart.length === 3) {
      maskedLocal = `${localPart.charAt(0)}*${localPart.charAt(2)}`;
    } else {
      maskedLocal = `${localPart.charAt(0)}***${localPart.charAt(localPart.length - 1)}`;
    }

    return `${maskedLocal}@${domainPart}`;
  }

  /**
   * Produces a clean, PII-safe display label from a chip's text content.
   * If the chip text itself is an email address (when a contact has no display
   * name), returns the masked email rather than exposing the full address.
   */
  public static formatDisplayLabel(
    rawChipText: string,
    rawEmail: string
  ): { displayLabel: string; hasDistinctDisplayName: boolean } {
    const maskedEmail = PiiMaskingHelper.maskEmail(rawEmail);
    const stripped = rawChipText
      .replace(/^[\s\u00A0\u200B\uFEFF+@]+/, '')
      .replace(/[\s\u00A0\u200B\uFEFF]+/g, ' ')
      .trim()
      .slice(0, MAX_DISPLAY_LABEL_LENGTH);

    if (
      stripped.length === 0 ||
      stripped.includes('@') ||
      stripped.toLowerCase() === rawEmail.trim().toLowerCase()
    ) {
      return {
        displayLabel: maskedEmail,
        hasDistinctDisplayName: false,
      };
    }

    return {
      displayLabel: stripped,
      hasDistinctDisplayName: true,
    };
  }
}
