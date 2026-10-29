/**
 * Represents a contact added via Gmail's '@'-mention autocomplete chip
 * inside a compose message body.
 */
export interface MentionRecipientInterface {
  /** Stable identifier for the chip element (from Gmail's id or generated fallback). */
  readonly chipId: string;
  /** Safe display label for UI rendering (never contains an unmasked email address). */
  readonly displayLabel: string;
  /** Masked email address for UI rendering (e.g., "a***e@example.com"). */
  readonly maskedEmail: string;
  /** Whether the displayLabel is distinct from the maskedEmail (so UI avoids redundant text). */
  readonly hasDistinctDisplayName: boolean;
  /** Reference to the closed `a.gmail_plusreply` chip element in the compose DOM. */
  readonly chipElement: HTMLAnchorElement;
  /** Reference to the enclosing Gmail compose message body element. */
  readonly composeBodyElement: HTMLElement;
}
