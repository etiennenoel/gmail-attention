import { GmailMentionMonitor } from './core/gmail-mention.monitor';

const GMAIL_ORIGIN = 'https://mail.google.com';
const LOADED_ATTRIBUTE = 'data-gmail-attention-loaded';

export interface GmailAttentionPingMessageInterface {
  readonly type: 'GMAIL_ATTENTION_PING';
}

export interface GmailAttentionStatusResponseInterface {
  readonly active: true;
  readonly composeBodyCount: number;
  readonly unconfirmedCount: number;
}

interface ChromeRuntimeLikeInterface {
  readonly onMessage?: {
    addListener: (
      callback: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: GmailAttentionStatusResponseInterface) => void
      ) => boolean | void
    ) => void;
  };
}

/**
 * Verifies whether `win` is a `https://mail.google.com` document or a same-origin
 * `about:blank` child frame created by `https://mail.google.com`.
 */
export function isVerifiedGmailWindow(win: Window): boolean {
  if (!win.location) {
    return false;
  }

  if (win.location.origin === GMAIL_ORIGIN) {
    return true;
  }

  if (win.location.href === 'about:blank' && win.parent && win.parent !== win) {
    try {
      return win.parent.location?.origin === GMAIL_ORIGIN;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Bootstraps the Gmail `@tention` recipient decision monitor exclusively
 * on verified `https://mail.google.com` documents.
 */
export function bootstrapGmailAttention(
  win: Window = window,
  doc: Document = document
): GmailMentionMonitor | null {
  if (!isVerifiedGmailWindow(win)) {
    return null;
  }

  if (doc.documentElement?.getAttribute(LOADED_ATTRIBUTE) === 'true') {
    return null;
  }

  doc.documentElement?.setAttribute(LOADED_ATTRIBUTE, 'true');

  const monitor = new GmailMentionMonitor(doc);
  monitor.start();

  const isTopFrame = !win.top || win.top === win;
  const globalChrome = (
    globalThis as unknown as { chrome?: { runtime?: ChromeRuntimeLikeInterface } }
  ).chrome;

  if (isTopFrame && globalChrome?.runtime?.onMessage) {
    globalChrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'GMAIL_ATTENTION_PING'
      ) {
        sendResponse({
          active: true,
          composeBodyCount: monitor.getComposeBodyCount(),
          unconfirmedCount: monitor.getUnconfirmedRecipients().length,
        });
        return false;
      }
      return undefined;
    });
  }

  return monitor;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootstrapGmailAttention(window, document);
}
