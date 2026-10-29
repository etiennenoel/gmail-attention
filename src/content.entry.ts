import { GmailMentionMonitor } from './core/gmail-mention.monitor';

const GMAIL_ORIGIN = 'https://mail.google.com';
const LOADED_ATTRIBUTE = 'data-gmail-attention-loaded';

/**
 * Bootstraps the Gmail `@tention` recipient decision monitor exclusively
 * on verified `https://mail.google.com` documents.
 */
export function bootstrapGmailAttention(
  win: Window = window,
  doc: Document = document
): GmailMentionMonitor | null {
  if (!win.location || win.location.origin !== GMAIL_ORIGIN) {
    return null;
  }

  if (doc.documentElement?.getAttribute(LOADED_ATTRIBUTE) === 'true') {
    return null;
  }

  doc.documentElement?.setAttribute(LOADED_ATTRIBUTE, 'true');

  const monitor = new GmailMentionMonitor(doc);
  monitor.start();
  return monitor;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootstrapGmailAttention(window, document);
}
