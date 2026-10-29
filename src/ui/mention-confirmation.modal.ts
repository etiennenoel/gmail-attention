import { MentionRecipientInterface } from '../models/mention-recipient.interface';

const SVG_NS = 'http://www.w3.org/2000/svg';
const KEYBOARD_ACTIVATION_GRACE_MS = 160;

export interface PresentModalOptionsInterface {
  /** Whether the modal is being surfaced/highlighted because the user attempted to send. */
  readonly triggeredBySendAttempt?: boolean;
}

/**
 * Renders an accessible, focus-stealing recipient decision modal inside a closed
 * Shadow DOM using a top-layer `<dialog>` element, allowing the user either to
 * keep (`Yes`) or remove (`No`) `@`-mentioned contacts from the `To` recipient list
 * while preserving the `@mention` link in the email body.
 *
 * Security & UX guarantees:
 * - Zero `innerHTML` / `outerHTML` / `insertAdjacentHTML` / native `alert()`.
 * - Closed Shadow DOM prevents host CSS bleed and page-script tampering.
 * - Immediately steals focus from Gmail's compose editor and recaptures focus
 *   if Gmail's editor asynchronously attempts to move the caret back.
 * - Guards against accidental instant dismissal from the `Enter` keystroke
 *   that selected the contact in Gmail's autocomplete menu.
 * - Blocks `Escape` (`cancel` event) so the decision cannot be bypassed accidentally.
 */
export class MentionConfirmationModal {
  private readonly doc: Document;
  private readonly onConfirmCallback: (confirmed: readonly MentionRecipientInterface[]) => void;
  private readonly onDeclineCallback?: (
    declined: readonly MentionRecipientInterface[]
  ) => HTMLElement | null | void;

  private hostElement: HTMLDivElement | null = null;
  private shadowRootRef: ShadowRoot | null = null;
  private dialogElement: HTMLDialogElement | null = null;
  private cardElement: HTMLDivElement | null = null;
  private titleElement: HTMLHeadingElement | null = null;
  private countBadgeElement: HTMLSpanElement | null = null;
  private descriptionContainer: HTMLDivElement | null = null;
  private sendBlockedNoticeElement: HTMLParagraphElement | null = null;
  private declineButton: HTMLButtonElement | null = null;
  private confirmButton: HTMLButtonElement | null = null;

  private activeRecipients: MentionRecipientInterface[] = [];
  private activeModalAction: 'confirm' | 'decline' = 'confirm';
  private savedRange: Range | null = null;
  private openTimerId: ReturnType<typeof setTimeout> | null = null;
  private isPendingOpen = false;
  private isDialogOpen = false;
  private openedAtMs = 0;
  private sawPostOpenActivationKeydown = false;

  private readonly boundFocusInGuard: (event: FocusEvent) => void;
  private readonly boundDocumentKeydownGuard: (event: KeyboardEvent) => void;

  public constructor(
    doc: Document,
    onConfirm: (confirmed: readonly MentionRecipientInterface[]) => void,
    onDecline?: (
      declined: readonly MentionRecipientInterface[]
    ) => HTMLElement | null | void
  ) {
    this.doc = doc;
    this.onConfirmCallback = onConfirm;
    this.onDeclineCallback = onDecline;
    this.boundFocusInGuard = (event: FocusEvent) => this.handleDocumentFocusIn(event);
    this.boundDocumentKeydownGuard = (event: KeyboardEvent) =>
      this.handleDocumentKeydown(event);
  }

  /**
   * Returns true when the modal is currently visible or scheduled to open on the next tick.
   */
  public isActive(): boolean {
    return this.isPendingOpen || this.isDialogOpen;
  }

  /**
   * Presents (or updates) the recipient decision modal with all currently unconfirmed
   * `@`-mentioned recipients and steals focus into the modal.
   */
  public present(
    recipients: readonly MentionRecipientInterface[],
    options: PresentModalOptionsInterface = {}
  ): void {
    if (recipients.length === 0) {
      this.closeDialogOnly();
      return;
    }

    this.activeRecipients = [...recipients];
    this.ensureMounted();
    this.renderRecipientsContent(Boolean(options.triggeredBySendAttempt));

    if (this.isDialogOpen) {
      if (options.triggeredBySendAttempt) {
        this.pulseAttention();
      }
      this.focusActiveActionButton();
      return;
    }

    this.captureComposeSelectionBeforeFocusTheft();
    this.isPendingOpen = true;

    if (this.openTimerId !== null) {
      clearTimeout(this.openTimerId);
    }

    // Defer to the next macrotask so the Enter/Click event that selected the
    // contact in Gmail's PeopleKit autocomplete menu completes cleanly first.
    this.openTimerId = setTimeout(() => {
      this.openTimerId = null;
      if (!this.isPendingOpen || this.activeRecipients.length === 0) {
        this.isPendingOpen = false;
        return;
      }
      this.openDialogNow(Boolean(options.triggeredBySendAttempt));
    }, 0);
  }

  /**
   * Dismisses the modal if all tracked unconfirmed chips were deleted from the draft.
   */
  public syncRecipients(recipients: readonly MentionRecipientInterface[]): void {
    if (recipients.length === 0) {
      this.activeRecipients = [];
      this.closeDialogOnly();
      return;
    }

    this.activeRecipients = [...recipients];
    if (this.isDialogOpen || this.isPendingOpen) {
      this.ensureMounted();
      this.renderRecipientsContent(false);
    }
  }

  /**
   * Tears down listeners, timers, and the Shadow DOM host element.
   */
  public destroy(): void {
    this.closeDialogOnly();
    if (this.hostElement && this.hostElement.parentNode) {
      this.hostElement.parentNode.removeChild(this.hostElement);
    }
    this.hostElement = null;
    this.shadowRootRef = null;
    this.dialogElement = null;
    this.cardElement = null;
    this.titleElement = null;
    this.countBadgeElement = null;
    this.descriptionContainer = null;
    this.sendBlockedNoticeElement = null;
    this.declineButton = null;
    this.confirmButton = null;
  }

  private ensureMounted(): void {
    if (this.hostElement && this.hostElement.isConnected && this.dialogElement) {
      return;
    }

    const host = this.doc.createElement('div');
    host.setAttribute('data-gmail-attention-host', 'true');

    const shadow = host.attachShadow({ mode: 'closed' });
    const style = this.doc.createElement('style');
    style.textContent = MentionConfirmationModal.buildStylesheet();

    const dialog = this.doc.createElement('dialog');
    dialog.className = 'gmn-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'gmn-title');
    dialog.setAttribute('aria-describedby', 'gmn-description');

    dialog.addEventListener('cancel', (event: Event) => {
      // Prevent Escape from silently dismissing without an explicit Yes/No decision.
      event.preventDefault();
      this.pulseAttention();
      this.focusActiveActionButton();
    });

    dialog.addEventListener('keydown', (event: KeyboardEvent) => {
      this.handleDialogKeydown(event);
    });

    const card = this.doc.createElement('div');
    card.className = 'gmn-card';

    const header = this.doc.createElement('div');
    header.className = 'gmn-header';

    const iconWrap = this.doc.createElement('div');
    iconWrap.className = 'gmn-icon-wrap';
    iconWrap.setAttribute('aria-hidden', 'true');
    iconWrap.appendChild(this.createRecipientAlertSvg());

    const titleGroup = this.doc.createElement('div');
    titleGroup.className = 'gmn-title-group';

    const title = this.doc.createElement('h2');
    title.id = 'gmn-title';
    title.className = 'gmn-title';

    const countBadge = this.doc.createElement('span');
    countBadge.className = 'gmn-count-pill';
    countBadge.hidden = true;

    titleGroup.appendChild(title);
    titleGroup.appendChild(countBadge);
    header.appendChild(iconWrap);
    header.appendChild(titleGroup);

    const description = this.doc.createElement('div');
    description.id = 'gmn-description';
    description.className = 'gmn-description';

    const sendBlockedNotice = this.doc.createElement('p');
    sendBlockedNotice.className = 'gmn-send-notice';
    sendBlockedNotice.textContent =
      'Sending is paused until you choose whether to keep or remove this recipient.';
    sendBlockedNotice.hidden = true;

    const actions = this.doc.createElement('div');
    actions.className = 'gmn-actions';

    const declineBtn = this.doc.createElement('button');
    declineBtn.type = 'button';
    declineBtn.className = 'gmn-decline-btn';
    declineBtn.addEventListener('focusin', () => {
      this.activeModalAction = 'decline';
    });
    declineBtn.addEventListener('click', (event: MouseEvent) => {
      this.handleActionClick(event, 'decline');
    });

    const confirmBtn = this.doc.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'gmn-confirm-btn';
    confirmBtn.autofocus = true;
    confirmBtn.setAttribute('autofocus', '');
    confirmBtn.addEventListener('focusin', () => {
      this.activeModalAction = 'confirm';
    });
    confirmBtn.addEventListener('click', (event: MouseEvent) => {
      this.handleActionClick(event, 'confirm');
    });

    actions.appendChild(declineBtn);
    actions.appendChild(confirmBtn);

    card.appendChild(header);
    card.appendChild(description);
    card.appendChild(sendBlockedNotice);
    card.appendChild(actions);
    dialog.appendChild(card);

    shadow.appendChild(style);
    shadow.appendChild(dialog);

    const mountTarget = this.doc.body ?? this.doc.documentElement;
    mountTarget.appendChild(host);

    this.hostElement = host;
    this.shadowRootRef = shadow;
    this.dialogElement = dialog;
    this.cardElement = card;
    this.titleElement = title;
    this.countBadgeElement = countBadge;
    this.descriptionContainer = description;
    this.sendBlockedNoticeElement = sendBlockedNotice;
    this.declineButton = declineBtn;
    this.confirmButton = confirmBtn;
  }

  private renderRecipientsContent(showSendBlockedNotice: boolean): void {
    if (
      !this.titleElement ||
      !this.countBadgeElement ||
      !this.descriptionContainer ||
      !this.sendBlockedNoticeElement ||
      !this.declineButton ||
      !this.confirmButton
    ) {
      return;
    }

    const count = this.activeRecipients.length;
    const isPlural = count > 1;

    this.titleElement.textContent = isPlural
      ? 'Add recipients to email list?'
      : 'Add recipient to email list?';

    if (isPlural) {
      this.countBadgeElement.textContent = String(count);
      this.countBadgeElement.hidden = false;
    } else {
      this.countBadgeElement.textContent = '';
      this.countBadgeElement.hidden = true;
    }

    this.descriptionContainer.replaceChildren();

    if (count === 1) {
      const recipient = this.activeRecipients[0]!;
      const paragraph = this.doc.createElement('p');
      paragraph.className = 'gmn-lead';
      paragraph.appendChild(this.doc.createTextNode('You @mentioned '));

      const strongName = this.doc.createElement('strong');
      strongName.textContent = recipient.displayLabel;
      paragraph.appendChild(strongName);

      if (recipient.hasDistinctDisplayName) {
        paragraph.appendChild(
          this.doc.createTextNode(` (${recipient.maskedEmail})`)
        );
      }

      paragraph.appendChild(
        this.doc.createTextNode(
          ' in the email body. Gmail adds @mentioned people to the To email recipient list — keep them in To?'
        )
      );
      this.descriptionContainer.appendChild(paragraph);
    } else {
      const intro = this.doc.createElement('p');
      intro.className = 'gmn-lead';
      intro.textContent =
        'Gmail adds these @mentioned people to the To email recipient list — keep them in To?';

      const list = this.doc.createElement('ul');
      list.className = 'gmn-recipient-list';

      for (const recipient of this.activeRecipients) {
        const item = this.doc.createElement('li');
        const strongName = this.doc.createElement('strong');
        strongName.textContent = recipient.displayLabel;
        item.appendChild(strongName);

        if (recipient.hasDistinctDisplayName) {
          const emailSpan = this.doc.createElement('span');
          emailSpan.className = 'gmn-masked-email';
          emailSpan.textContent = ` (${recipient.maskedEmail})`;
          item.appendChild(emailSpan);
        }
        list.appendChild(item);
      }

      this.descriptionContainer.appendChild(intro);
      this.descriptionContainer.appendChild(list);
    }

    this.sendBlockedNoticeElement.hidden = !showSendBlockedNotice;
    this.declineButton.textContent = 'No, remove from To';
    this.confirmButton.textContent = isPlural ? 'Yes, keep all in To' : 'Yes, keep in To';
  }

  private openDialogNow(showSendBlockedNotice: boolean): void {
    this.ensureMounted();
    if (!this.dialogElement) {
      this.isPendingOpen = false;
      return;
    }

    this.blurExternalActiveElement();

    this.isPendingOpen = false;
    this.isDialogOpen = true;
    this.activeModalAction = 'confirm';
    this.openedAtMs = Date.now();
    this.sawPostOpenActivationKeydown = false;

    if (!this.dialogElement.open) {
      if (typeof this.dialogElement.showModal === 'function') {
        try {
          this.dialogElement.showModal();
        } catch {
          this.dialogElement.setAttribute('open', '');
        }
      } else {
        this.dialogElement.setAttribute('open', '');
      }
    }

    // Explicitly reset to 'confirm' after showModal() so HTML dialog focusing steps
    // on the first button in DOM order never override the default primary action.
    this.activeModalAction = 'confirm';

    this.doc.addEventListener('focusin', this.boundFocusInGuard, true);
    this.doc.addEventListener('keydown', this.boundDocumentKeydownGuard, true);

    if (showSendBlockedNotice) {
      this.pulseAttention();
    }

    this.focusActiveActionButton();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (this.isDialogOpen) {
          this.focusActiveActionButton();
        }
      });
    }
  }

  private handleDialogKeydown(event: KeyboardEvent): void {
    this.processModalKeydown(event, false);
  }

  private handleDocumentKeydown(event: KeyboardEvent): void {
    if (!this.isDialogOpen) {
      return;
    }
    this.processModalKeydown(event, true);
  }

  private processModalKeydown(event: KeyboardEvent, stopImmediate: boolean): void {
    const halt = (): void => {
      event.preventDefault();
      if (stopImmediate) {
        event.stopImmediatePropagation();
      } else {
        event.stopPropagation();
      }
    };

    if (event.key === 'Escape') {
      halt();
      this.pulseAttention();
      this.focusActiveActionButton();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      halt();
      if (this.sendBlockedNoticeElement) {
        this.sendBlockedNoticeElement.hidden = false;
      }
      this.pulseAttention();
      this.focusActiveActionButton();
      return;
    }

    if (event.key === 'Tab') {
      halt();
      this.activeModalAction =
        this.getFocusedModalAction() === 'confirm' ? 'decline' : 'confirm';
      this.focusActiveActionButton();
      return;
    }

    if (
      event.key === 'ArrowLeft' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      halt();
      this.activeModalAction = 'decline';
      this.focusActiveActionButton();
      return;
    }

    if (
      event.key === 'ArrowRight' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      halt();
      this.activeModalAction = 'confirm';
      this.focusActiveActionButton();
      return;
    }

    if (
      (event.key === 'Enter' || event.key === ' ') &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const elapsed = Date.now() - this.openedAtMs;
      if (elapsed < KEYBOARD_ACTIVATION_GRACE_MS || event.repeat) {
        halt();
        return;
      }
      this.sawPostOpenActivationKeydown = true;
      halt();
      if (this.getFocusedModalAction() === 'decline') {
        this.declineActiveRecipients();
      } else {
        this.confirmActiveRecipients();
      }
    }
  }

  private getFocusedModalAction(): 'confirm' | 'decline' {
    const shadowActive = this.shadowRootRef?.activeElement ?? null;
    if (shadowActive === this.declineButton) {
      return 'decline';
    }
    if (shadowActive === this.confirmButton) {
      return 'confirm';
    }
    return this.activeModalAction;
  }

  private handleDocumentFocusIn(event: FocusEvent): void {
    if (!this.isDialogOpen || !this.hostElement) {
      return;
    }

    const target = event.target as Node | null;
    if (target === this.hostElement || (target && this.hostElement.contains(target))) {
      return;
    }

    // Gmail's editor tried to pull focus back; immediately recapture focus in the modal.
    this.focusActiveActionButton();
  }

  private handleActionClick(event: MouseEvent, action: 'confirm' | 'decline'): void {
    if (!this.isDialogOpen) {
      return;
    }

    // Guard against a synthetic keyboard click (`detail === 0`) bouncing from the
    // exact `Enter` keystroke that selected the contact in Gmail's autocomplete popup.
    const isKeyboardSynthesizedClick = event.detail === 0;
    const withinGraceWindow = Date.now() - this.openedAtMs < KEYBOARD_ACTIVATION_GRACE_MS;
    if (
      isKeyboardSynthesizedClick &&
      !this.sawPostOpenActivationKeydown &&
      withinGraceWindow
    ) {
      event.preventDefault();
      return;
    }

    if (action === 'decline') {
      this.declineActiveRecipients();
    } else {
      this.confirmActiveRecipients();
    }
  }

  private confirmActiveRecipients(): void {
    if (!this.isDialogOpen) {
      return;
    }

    const confirmed = [...this.activeRecipients];
    const lastRecipient = confirmed[confirmed.length - 1] ?? null;
    const savedRange = this.savedRange;

    this.activeRecipients = [];
    this.closeDialogOnly();
    this.onConfirmCallback(confirmed);

    if (lastRecipient) {
      this.restoreFocusToCompose(lastRecipient.composeBodyElement, lastRecipient.chipElement, savedRange);
    }
  }

  private declineActiveRecipients(): void {
    if (!this.isDialogOpen) {
      return;
    }

    const declined = [...this.activeRecipients];
    const lastRecipient = declined[declined.length - 1] ?? null;

    this.activeRecipients = [];
    this.closeDialogOnly();
    const replacementAnchor = this.onDeclineCallback?.(declined) ?? null;

    if (lastRecipient) {
      const targetAnchor = replacementAnchor ?? lastRecipient.chipElement;
      this.restoreFocusToCompose(lastRecipient.composeBodyElement, targetAnchor, null);
    }
  }

  private closeDialogOnly(): void {
    if (this.openTimerId !== null) {
      clearTimeout(this.openTimerId);
      this.openTimerId = null;
    }

    this.isPendingOpen = false;
    this.isDialogOpen = false;
    this.sawPostOpenActivationKeydown = false;
    this.savedRange = null;

    this.doc.removeEventListener('focusin', this.boundFocusInGuard, true);
    this.doc.removeEventListener('keydown', this.boundDocumentKeydownGuard, true);

    if (
      this.dialogElement &&
      (this.dialogElement.open || this.dialogElement.hasAttribute('open'))
    ) {
      if (typeof this.dialogElement.close === 'function') {
        try {
          this.dialogElement.close();
        } catch {
          this.dialogElement.removeAttribute('open');
        }
      } else {
        this.dialogElement.removeAttribute('open');
      }
    }
  }

  private focusActiveActionButton(): void {
    const targetButton =
      this.activeModalAction === 'decline' ? this.declineButton : this.confirmButton;
    if (!targetButton) {
      return;
    }
    try {
      targetButton.focus({ preventScroll: true });
    } catch {
      targetButton.focus();
    }
  }

  private blurExternalActiveElement(): void {
    const active = this.doc.activeElement;
    if (
      active &&
      active !== this.hostElement &&
      active !== this.doc.body &&
      typeof (active as HTMLElement).blur === 'function'
    ) {
      try {
        (active as HTMLElement).blur();
      } catch {
        // Ignore blur errors on detached nodes.
      }
    }
  }

  private captureComposeSelectionBeforeFocusTheft(): void {
    this.savedRange = null;
    const view = this.doc.defaultView;
    if (!view || typeof view.getSelection !== 'function') {
      return;
    }
    const selection = view.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    const latestCompose =
      this.activeRecipients[this.activeRecipients.length - 1]?.composeBodyElement ?? null;
    if (latestCompose && latestCompose.contains(range.commonAncestorContainer)) {
      this.savedRange = range.cloneRange();
    }
  }

  private restoreFocusToCompose(
    composeBody: HTMLElement,
    anchorElement: HTMLElement,
    savedRange: Range | null
  ): void {
    if (!composeBody.isConnected) {
      return;
    }

    try {
      composeBody.focus({ preventScroll: true });
    } catch {
      composeBody.focus();
    }

    const view = this.doc.defaultView;
    if (!view || typeof view.getSelection !== 'function') {
      return;
    }
    const selection = view.getSelection();
    if (!selection) {
      return;
    }

    try {
      if (
        savedRange &&
        composeBody.contains(savedRange.startContainer) &&
        composeBody.contains(savedRange.endContainer)
      ) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
        return;
      }

      if (anchorElement.isConnected && composeBody.contains(anchorElement)) {
        const range = this.doc.createRange();
        const nextNode = anchorElement.nextSibling;
        if (nextNode && nextNode.nodeType === 3 && (nextNode.textContent ?? '').length > 0) {
          range.setStart(nextNode, Math.min(1, (nextNode.textContent ?? '').length));
          range.collapse(true);
        } else {
          range.setStartAfter(anchorElement);
          range.collapse(true);
        }
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } catch {
      // Ignore selection restoration failures if host DOM mutated concurrently.
    }
  }

  private pulseAttention(): void {
    if (!this.cardElement) {
      return;
    }
    this.cardElement.classList.remove('gmn-card--pulse');
    // Trigger reflow to restart keyframe animation cleanly.
    void this.cardElement.offsetWidth;
    this.cardElement.classList.add('gmn-card--pulse');
  }

  private createRecipientAlertSvg(): SVGSVGElement {
    const svg = this.doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');

    const userPath = this.doc.createElementNS(SVG_NS, 'path');
    userPath.setAttribute('d', 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2');

    const headCircle = this.doc.createElementNS(SVG_NS, 'circle');
    headCircle.setAttribute('cx', '9');
    headCircle.setAttribute('cy', '7');
    headCircle.setAttribute('r', '4');

    const plusVertical = this.doc.createElementNS(SVG_NS, 'line');
    plusVertical.setAttribute('x1', '19');
    plusVertical.setAttribute('y1', '8');
    plusVertical.setAttribute('x2', '19');
    plusVertical.setAttribute('y2', '14');

    const plusHorizontal = this.doc.createElementNS(SVG_NS, 'line');
    plusHorizontal.setAttribute('x1', '22');
    plusHorizontal.setAttribute('y1', '11');
    plusHorizontal.setAttribute('x2', '16');
    plusHorizontal.setAttribute('y2', '11');

    svg.appendChild(userPath);
    svg.appendChild(headCircle);
    svg.appendChild(plusVertical);
    svg.appendChild(plusHorizontal);
    return svg;
  }

  private static buildStylesheet(): string {
    return `
      :host {
        all: initial;
      }

      .gmn-dialog {
        border: none;
        padding: 0;
        background: transparent;
        max-width: min(448px, calc(100vw - 32px));
        width: 100%;
        overflow: visible;
        margin: auto;
      }

      .gmn-dialog::backdrop {
        background: rgba(15, 23, 42, 0.42);
        backdrop-filter: blur(2px);
      }

      .gmn-card {
        box-sizing: border-box;
        background: #ffffff;
        color: #1f1f1f;
        border: 1px solid rgba(15, 23, 42, 0.12);
        border-radius: 16px;
        padding: 24px;
        box-shadow:
          0 20px 40px -12px rgba(15, 23, 42, 0.28),
          0 4px 12px -2px rgba(15, 23, 42, 0.12);
        font-family: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }

      @media (prefers-color-scheme: dark) {
        .gmn-card {
          background: #1e1f22;
          color: #e3e3e3;
          border-color: rgba(255, 255, 255, 0.14);
          box-shadow:
            0 24px 48px -12px rgba(0, 0, 0, 0.65),
            0 4px 14px -2px rgba(0, 0, 0, 0.4);
        }
      }

      .gmn-card--pulse {
        animation: gmn-shake 220ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
      }

      @keyframes gmn-shake {
        0%, 100% { transform: translateX(0); }
        25% { transform: translateX(-5px); }
        75% { transform: translateX(5px); }
      }

      .gmn-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 14px;
      }

      .gmn-icon-wrap {
        flex-shrink: 0;
        width: 36px;
        height: 36px;
        border-radius: 10px;
        background: #e8f0fe;
        color: #0b57d0;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      @media (prefers-color-scheme: dark) {
        .gmn-icon-wrap {
          background: rgba(168, 199, 250, 0.14);
          color: #a8c7fa;
        }
      }

      .gmn-title-group {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .gmn-title {
        margin: 0;
        font-size: 17px;
        font-weight: 600;
        line-height: 1.35;
        letter-spacing: -0.01em;
      }

      .gmn-count-pill {
        font-size: 12px;
        font-weight: 600;
        line-height: 1;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.08);
        color: inherit;
      }

      @media (prefers-color-scheme: dark) {
        .gmn-count-pill {
          background: rgba(255, 255, 255, 0.12);
        }
      }

      .gmn-description {
        font-size: 14px;
        line-height: 1.55;
        color: #444746;
      }

      @media (prefers-color-scheme: dark) {
        .gmn-description {
          color: #c4c7c5;
        }
      }

      .gmn-lead {
        margin: 0;
      }

      .gmn-lead strong,
      .gmn-recipient-list strong {
        color: #1f1f1f;
        font-weight: 600;
      }

      @media (prefers-color-scheme: dark) {
        .gmn-lead strong,
        .gmn-recipient-list strong {
          color: #f1f3f4;
        }
      }

      .gmn-recipient-list {
        margin: 10px 0 0;
        padding-left: 20px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .gmn-send-notice {
        margin: 14px 0 0;
        font-size: 13px;
        font-weight: 500;
        color: #b3261e;
      }

      @media (prefers-color-scheme: dark) {
        .gmn-send-notice {
          color: #f2b8b5;
        }
      }

      .gmn-actions {
        margin-top: 22px;
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .gmn-decline-btn,
      .gmn-confirm-btn {
        appearance: none;
        border-radius: 999px;
        padding: 10px 18px;
        font-family: inherit;
        font-size: 14px;
        font-weight: 600;
        line-height: 1.2;
        cursor: pointer;
        transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
      }

      .gmn-decline-btn {
        border: 1px solid rgba(15, 23, 42, 0.22);
        background: transparent;
        color: #1f1f1f;
      }

      .gmn-decline-btn:hover {
        background: rgba(15, 23, 42, 0.06);
      }

      .gmn-decline-btn:focus-visible,
      .gmn-decline-btn:focus {
        outline: 2px solid #0b57d0;
        outline-offset: 2px;
      }

      .gmn-confirm-btn {
        border: 1px solid transparent;
        padding: 10px 20px;
        background: #0b57d0;
        color: #ffffff;
      }

      .gmn-confirm-btn:hover {
        background: #0842a0;
      }

      .gmn-confirm-btn:focus-visible,
      .gmn-confirm-btn:focus {
        outline: 2px solid #0b57d0;
        outline-offset: 2px;
      }

      @media (prefers-color-scheme: dark) {
        .gmn-decline-btn {
          border-color: rgba(255, 255, 255, 0.24);
          color: #e3e3e3;
        }

        .gmn-decline-btn:hover {
          background: rgba(255, 255, 255, 0.08);
        }

        .gmn-decline-btn:focus-visible,
        .gmn-decline-btn:focus {
          outline-color: #a8c7fa;
        }

        .gmn-confirm-btn {
          background: #a8c7fa;
          color: #062e6f;
        }

        .gmn-confirm-btn:hover {
          background: #d3e3fd;
        }

        .gmn-confirm-btn:focus-visible,
        .gmn-confirm-btn:focus {
          outline-color: #a8c7fa;
        }
      }
    `;
  }
}
