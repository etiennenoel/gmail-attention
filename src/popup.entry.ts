import { GmailAttentionStatusResponseInterface } from './content.entry';

export interface ChromeTabLikeInterface {
  readonly id?: number;
  readonly url?: string;
}

export interface ChromePopupApiLikeInterface {
  readonly tabs?: {
    query: (
      queryInfo: { active: boolean; currentWindow: boolean },
      callback: (tabs: ChromeTabLikeInterface[]) => void
    ) => void;
    sendMessage: (
      tabId: number,
      message: { type: 'GMAIL_ATTENTION_PING' },
      callback: (response?: GmailAttentionStatusResponseInterface) => void
    ) => void;
    reload: (tabId: number, reloadProperties?: unknown, callback?: () => void) => void;
  };
  readonly permissions?: {
    contains: (
      permissions: { origins: string[] },
      callback: (result: boolean) => void
    ) => void;
  };
  readonly runtime?: {
    readonly lastError?: { readonly message?: string };
  };
}

export interface PopupViewStateInterface {
  readonly pillText: string;
  readonly descriptionText: string;
  readonly showReloadButton: boolean;
  readonly reloadButtonLabel: string;
}

/**
 * Computes the diagnostic status displayed in the toolbar popup so that
 * missing tab reloads or corporate Chrome policy blocks never fail silently.
 */
export function computePopupViewState(options: {
  readonly pingResponse: GmailAttentionStatusResponseInterface | null;
  readonly tabUrl: string | undefined;
  readonly hasGmailHostPermission: boolean;
}): PopupViewStateInterface {
  const { pingResponse, tabUrl, hasGmailHostPermission } = options;

  if (pingResponse?.active) {
    const editorWord =
      pingResponse.composeBodyCount === 1 ? 'compose editor' : 'compose editors';
    return {
      pillText: 'Active',
      descriptionText: `Guarding @mentions on this Gmail tab (${pingResponse.composeBodyCount} ${editorWord} active).`,
      showReloadButton: false,
      reloadButtonLabel: 'Reload Gmail Tab',
    };
  }

  if (!hasGmailHostPermission) {
    return {
      pillText: 'Site Access Off',
      descriptionText:
        'Chrome has not granted site access to mail.google.com. Enable site access in chrome://extensions, or check chrome://policy (ExtensionSettings runtime_blocked_hosts) on managed corporate profiles.',
      showReloadButton: true,
      reloadButtonLabel: 'Reload Tab',
    };
  }

  if (typeof tabUrl === 'string' && tabUrl.startsWith('https://mail.google.com/')) {
    return {
      pillText: 'Needs Reload',
      descriptionText:
        'This Gmail tab was open before Gmail @tention was installed or updated (or corporate Chrome policy runtime_blocked_hosts is blocking extensions on *.google.com). Reload the tab to activate.',
      showReloadButton: true,
      reloadButtonLabel: 'Reload Gmail Tab',
    };
  }

  return {
    pillText: 'Standby',
    descriptionText:
      'Open https://mail.google.com to guard @mentions in Gmail compose bodies. If this tab is already Gmail on a corporate profile, check chrome://policy (ExtensionSettings runtime_blocked_hosts blocks non-allowlisted extensions on *.google.com).',
    showReloadButton: true,
    reloadButtonLabel: 'Reload Tab',
  };
}

export function initPopup(
  doc: Document = document,
  chromeApi?: ChromePopupApiLikeInterface
): void {
  const pillEl = doc.getElementById('status-pill');
  const descEl = doc.getElementById('status-description');
  const actionsEl = doc.getElementById('actions-container');
  const reloadBtn = doc.getElementById('reload-button') as HTMLButtonElement | null;

  if (!pillEl || !descEl || !actionsEl || !reloadBtn) {
    return;
  }

  const resolvedChrome =
    chromeApi ??
    ((globalThis as unknown as { chrome?: ChromePopupApiLikeInterface }).chrome ??
      undefined);

  const renderState = (
    state: PopupViewStateInterface,
    activeTabId?: number
  ): void => {
    pillEl.textContent = state.pillText;
    descEl.textContent = state.descriptionText;
    reloadBtn.textContent = state.reloadButtonLabel;
    actionsEl.hidden = !state.showReloadButton || activeTabId === undefined;

    if (activeTabId !== undefined && resolvedChrome?.tabs) {
      reloadBtn.onclick = () => {
        resolvedChrome.tabs?.reload(activeTabId, undefined, () => {
          if (typeof window !== 'undefined' && typeof window.close === 'function') {
            window.close();
          }
        });
      };
    }
  };

  if (!resolvedChrome?.tabs) {
    renderState(
      computePopupViewState({
        pingResponse: null,
        tabUrl: undefined,
        hasGmailHostPermission: true,
      })
    );
    return;
  }

  const checkHostPermission = (callback: (granted: boolean) => void): void => {
    if (!resolvedChrome.permissions?.contains) {
      callback(true);
      return;
    }
    resolvedChrome.permissions.contains(
      { origins: ['https://mail.google.com/*'] },
      (granted) => {
        void resolvedChrome.runtime?.lastError;
        callback(Boolean(granted));
      }
    );
  };

  checkHostPermission((hasGmailHostPermission) => {
    resolvedChrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
      void resolvedChrome.runtime?.lastError;
      const activeTab = tabs?.[0];
      const tabId = activeTab?.id;
      const tabUrl = activeTab?.url;

      if (tabId === undefined) {
        renderState(
          computePopupViewState({
            pingResponse: null,
            tabUrl,
            hasGmailHostPermission,
          })
        );
        return;
      }

      resolvedChrome.tabs?.sendMessage(
        tabId,
        { type: 'GMAIL_ATTENTION_PING' },
        (response) => {
          const hasError = Boolean(resolvedChrome.runtime?.lastError);
          const validResponse =
            !hasError && response && response.active === true ? response : null;

          renderState(
            computePopupViewState({
              pingResponse: validResponse,
              tabUrl,
              hasGmailHostPermission,
            }),
            tabId
          );
        }
      );
    });
  });
}

if (typeof document !== 'undefined') {
  initPopup(document);
}
