import { MentionRecipientInterface } from '../models/mention-recipient.interface';
import { MentionConfirmationModal } from '../ui/mention-confirmation.modal';
import { GmailDomHelper } from '../utils/gmail-dom.helper';
import { PiiMaskingHelper } from '../utils/pii-masking.helper';

/**
 * Maximum window (ms) during which a raw `@` keystroke in a compose body
 * authorizes a newly closed mention chip if the intermediate open-chip DOM
 * mutation was coalesced in the same frame.
 */
const AT_SESSION_TTL_MS = 30_000;

/**
 * Follow-up delay (ms) to catch an asynchronously rendered PeopleKit `To:` chip
 * if the user clicked "No" before Gmail's `0ms` `delayedUpdate` mounted it.
 */
const ASYNC_TO_CHIP_REMOVAL_RETRY_MS = 60;

/**
 * Monitors Gmail compose editors for `@`-mention autocomplete selections,
 * immediately steals focus with a Yes/No confirmation modal when a contact chip
 * is selected, allows declining recipient addition while keeping the `@mention`
 * link in the body, and blocks sending until all `@`-mentioned recipients have
 * an explicit decision.
 */
export class GmailMentionMonitor {
  private readonly doc: Document;
  private readonly modal: MentionConfirmationModal;

  /** Tracks compose body elements already discovered and pre-seeded. */
  private readonly knownComposeBodies = new WeakSet<HTMLElement>();

  /** Tracks `a.gmail_plusreply` elements observed in their open `@...` typing state. */
  private readonly openAtChips = new WeakSet<HTMLAnchorElement>();

  /**
   * Tracks closed `a.gmail_plusreply` elements already processed (pre-seeded,
   * confirmed, or declined/detached), preventing duplicate notifications.
   */
  private readonly processedClosedChips = new WeakSet<HTMLAnchorElement>();

  /** Timestamp of the most recent `@` typed per compose body. */
  private readonly atSessionByComposeBody = new WeakMap<HTMLElement, number>();

  /** Snapshot of `To:` recipient chip elements present when `@` typing began per compose body. */
  private readonly preMentionToChipsByComposeBody = new WeakMap<
    HTMLElement,
    Set<Element>
  >();

  /** Snapshot of pre-existing `To:` recipient chip elements captured before a mention chip closed. */
  private readonly preExistingToChipsByMentionChip = new WeakMap<
    HTMLAnchorElement,
    Set<Element>
  >();

  /** Currently unconfirmed `@`-mention recipients keyed by their chip DOM element. */
  private readonly unconfirmedByChip = new Map<
    HTMLAnchorElement,
    MentionRecipientInterface
  >();

  /** Active follow-up timers for async `To:` chip removal, cleaned up on `stop()`. */
  private readonly pendingRemovalTimers = new Set<ReturnType<typeof setTimeout>>();

  private observer: MutationObserver | null = null;
  private started = false;

  private readonly boundKeydownHandler: (event: KeyboardEvent) => void;
  private readonly boundInputHandler: (event: Event) => void;
  private readonly boundClickHandler: (event: MouseEvent) => void;

  public constructor(doc: Document) {
    this.doc = doc;
    this.modal = new MentionConfirmationModal(
      doc,
      (confirmed) => {
        this.handleConfirmedRecipients(confirmed);
      },
      (declined) => {
        return this.handleDeclinedRecipients(declined);
      }
    );

    this.boundKeydownHandler = (event: KeyboardEvent) => this.handleCaptureKeydown(event);
    this.boundInputHandler = (event: Event) => this.handleCaptureInput(event);
    this.boundClickHandler = (event: MouseEvent) => this.handleCaptureClick(event);
  }

  /**
   * Starts observing Gmail compose editors and enforcing pre-send confirmation.
   */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    this.seedExistingComposeBodies(this.doc);

    const observeRoot = this.doc.documentElement ?? this.doc.body;
    if (observeRoot && typeof MutationObserver !== 'undefined') {
      this.observer = new MutationObserver((mutations) => {
        this.handleMutations(mutations);
      });
      this.observer.observe(observeRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'href',
          'email',
          'contenteditable',
          'g_editable',
          'tabindex',
          'class',
        ],
      });
    }

    this.doc.addEventListener('keydown', this.boundKeydownHandler, true);
    this.doc.addEventListener('beforeinput', this.boundInputHandler, true);
    this.doc.addEventListener('input', this.boundInputHandler, true);
    this.doc.addEventListener('click', this.boundClickHandler, true);
  }

  /**
   * Stops all DOM observers, event listeners, timers, and closes/removes the modal.
   */
  public stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    for (const timerId of Array.from(this.pendingRemovalTimers)) {
      clearTimeout(timerId);
    }
    this.pendingRemovalTimers.clear();

    this.doc.removeEventListener('keydown', this.boundKeydownHandler, true);
    this.doc.removeEventListener('beforeinput', this.boundInputHandler, true);
    this.doc.removeEventListener('input', this.boundInputHandler, true);
    this.doc.removeEventListener('click', this.boundClickHandler, true);

    this.unconfirmedByChip.clear();
    this.modal.destroy();
  }

  /**
   * Returns the list of currently live, unconfirmed `@`-mentioned recipients.
   */
  public getUnconfirmedRecipients(): MentionRecipientInterface[] {
    this.pruneDetachedUnconfirmedChips();
    return Array.from(this.unconfirmedByChip.values());
  }

  /**
   * Returns the number of currently mounted Gmail compose bodies in the document.
   */
  public getComposeBodyCount(): number {
    return GmailDomHelper.findComposeBodies(this.doc).length;
  }

  private seedExistingComposeBodies(root: ParentNode): void {
    const composeBodies = GmailDomHelper.findComposeBodies(root);
    for (const composeBody of composeBodies) {
      if (this.knownComposeBodies.has(composeBody)) {
        continue;
      }
      this.knownComposeBodies.add(composeBody);

      // Any already-closed chips present when a compose editor first mounts
      // belong to an existing draft or template and must not trigger false positives.
      const existingChips = GmailDomHelper.findMentionChipsInSubtree(
        composeBody,
        composeBody
      );
      for (const chip of existingChips) {
        if (GmailDomHelper.isClosedMentionChip(chip)) {
          this.processedClosedChips.add(chip);
        } else if (GmailDomHelper.hasAtTriggerPrefix(chip)) {
          this.recordOpenAtChip(chip, composeBody);
        }
      }
    }
  }

  private recordAtSessionStart(composeBody: HTMLElement): void {
    this.knownComposeBodies.add(composeBody);
    this.atSessionByComposeBody.set(composeBody, Date.now());
    this.preMentionToChipsByComposeBody.set(
      composeBody,
      GmailDomHelper.snapshotToRecipientChips(composeBody)
    );
  }

  private recordOpenAtChip(chip: HTMLAnchorElement, composeBody: HTMLElement): void {
    if (!this.openAtChips.has(chip)) {
      const existingSnapshot = this.preMentionToChipsByComposeBody.get(composeBody);
      this.preExistingToChipsByMentionChip.set(
        chip,
        existingSnapshot
          ? new Set(existingSnapshot)
          : GmailDomHelper.snapshotToRecipientChips(composeBody)
      );
    }
    this.openAtChips.add(chip);
  }

  private handleCaptureKeydown(event: KeyboardEvent): void {
    const isSendShortcut =
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key === 'Enter';

    if (isSendShortcut) {
      const targetNode = (event.target as Node | null) ?? this.doc.activeElement;
      const targetComposeBody = GmailDomHelper.findEnclosingComposeBody(targetNode);
      if (this.shouldBlockSendForComposeBody(targetComposeBody)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.modal.present(this.getUnconfirmedRecipients(), {
          triggeredBySendAttempt: true,
        });
        return;
      }
    }

    const hasNonAltGrModifier = (event.ctrlKey || event.metaKey) && !event.altKey;

    if (event.key === '@' && !hasNonAltGrModifier) {
      const targetComposeBody = GmailDomHelper.findEnclosingComposeBody(
        event.target as Node | null
      );
      if (targetComposeBody) {
        this.recordAtSessionStart(targetComposeBody);
      }
    } else if (event.key === '+' && !hasNonAltGrModifier) {
      // Typing '+' starts a plus-mention rather than an '@'-mention; clear any stale '@' session.
      const targetComposeBody = GmailDomHelper.findEnclosingComposeBody(
        event.target as Node | null
      );
      if (targetComposeBody) {
        this.atSessionByComposeBody.delete(targetComposeBody);
        this.preMentionToChipsByComposeBody.delete(targetComposeBody);
      }
    }
  }

  private handleCaptureInput(event: Event): void {
    const inputData = (event as InputEvent).data;
    if (typeof inputData !== 'string' || inputData.length === 0) {
      return;
    }

    if (inputData.includes('@')) {
      const targetComposeBody = GmailDomHelper.findEnclosingComposeBody(
        event.target as Node | null
      );
      if (targetComposeBody) {
        this.recordAtSessionStart(targetComposeBody);
      }
    }
  }

  private handleCaptureClick(event: MouseEvent): void {
    const sendButton = GmailDomHelper.findSendButtonFromTarget(event.target);
    if (!sendButton) {
      return;
    }

    const associatedComposeBody = GmailDomHelper.findMessageBodyFromSendButton(sendButton);
    if (this.shouldBlockSendForComposeBody(associatedComposeBody)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.modal.present(this.getUnconfirmedRecipients(), {
        triggeredBySendAttempt: true,
      });
    }
  }

  private shouldBlockSendForComposeBody(composeBody: HTMLElement | null): boolean {
    this.pruneDetachedUnconfirmedChips();
    if (this.unconfirmedByChip.size === 0) {
      return false;
    }

    if (!composeBody) {
      return true;
    }

    for (const recipient of this.unconfirmedByChip.values()) {
      if (recipient.composeBodyElement === composeBody) {
        return true;
      }
    }

    return false;
  }

  private handleMutations(mutations: readonly MutationRecord[]): void {
    let addedNewUnconfirmed = false;
    let removedTrackedNodes = false;

    const candidateChips = new Set<HTMLAnchorElement>();

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const addedNode of Array.from(mutation.addedNodes)) {
          if (addedNode.nodeType !== 1) {
            continue;
          }
          const addedElement = addedNode as Element;

          // Seed any newly mounted compose editors first before inspecting chips.
          this.seedExistingComposeBodies(addedElement);

          const enclosingBody = GmailDomHelper.findEnclosingComposeBody(addedElement);
          if (enclosingBody) {
            this.knownComposeBodies.add(enclosingBody);
            const chips = GmailDomHelper.findMentionChipsInSubtree(
              addedElement,
              enclosingBody
            );
            for (const chip of chips) {
              candidateChips.add(chip);
            }
          }
        }

        if (mutation.removedNodes.length > 0) {
          removedTrackedNodes = true;
        }

        // Also check `mutation.target` if text or children changed inside an existing `a.gmail_plusreply`.
        if (GmailDomHelper.isMentionChip(mutation.target)) {
          candidateChips.add(mutation.target);
        }
      } else if (mutation.type === 'attributes') {
        if (
          mutation.target.nodeType === 1 &&
          GmailDomHelper.isComposeBody(mutation.target as Element)
        ) {
          this.seedExistingComposeBodies(mutation.target as ParentNode);
        }
        if (GmailDomHelper.isMentionChip(mutation.target)) {
          candidateChips.add(mutation.target);
        }
      }
    }

    for (const chip of candidateChips) {
      if (this.evaluateCandidateChip(chip)) {
        addedNewUnconfirmed = true;
      }
    }

    if (addedNewUnconfirmed) {
      this.pruneDetachedUnconfirmedChips();
      this.modal.present(Array.from(this.unconfirmedByChip.values()));
    } else if (removedTrackedNodes && this.unconfirmedByChip.size > 0) {
      const beforeCount = this.unconfirmedByChip.size;
      this.pruneDetachedUnconfirmedChips();
      if (this.unconfirmedByChip.size !== beforeCount) {
        this.modal.syncRecipients(Array.from(this.unconfirmedByChip.values()));
      }
    }
  }

  /**
   * Evaluates a `a.gmail_plusreply` chip across its open -> closed lifecycle.
   * Returns `true` if the chip newly transitioned to an unconfirmed `@`-mention recipient.
   */
  private evaluateCandidateChip(chip: HTMLAnchorElement): boolean {
    if (!chip.isConnected || this.processedClosedChips.has(chip)) {
      return false;
    }

    const composeBody = GmailDomHelper.findEnclosingComposeBody(chip);
    if (!composeBody || GmailDomHelper.isInsideQuotedContent(chip, composeBody)) {
      return false;
    }

    this.knownComposeBodies.add(composeBody);

    // Explicitly ignore '+' mentions (only '@' mentions should trigger).
    if (GmailDomHelper.hasPlusTriggerPrefix(chip)) {
      return false;
    }

    const isClosed = GmailDomHelper.isClosedMentionChip(chip);
    if (!isClosed) {
      // Open chip while user is typing query after '@' in the autocomplete menu.
      if (
        GmailDomHelper.hasAtTriggerPrefix(chip) ||
        this.hasActiveAtSession(composeBody)
      ) {
        this.recordOpenAtChip(chip, composeBody);
      }
      return false;
    }

    // Chip is closed (contact selected or pre-existing hydrated draft HTML).
    const wasObservedOpenWithAt = this.openAtChips.has(chip);
    const hasRecentAtKeystroke = this.hasActiveAtSession(composeBody);
    const isAtMentionSelection =
      wasObservedOpenWithAt ||
      (hasRecentAtKeystroke &&
        (GmailDomHelper.hasAtTriggerPrefix(chip) ||
          !GmailDomHelper.hasPlusTriggerPrefix(chip)));

    // Mark processed either way so future Gmail Backspace contenteditable toggles never re-trigger.
    this.processedClosedChips.add(chip);

    if (!isAtMentionSelection) {
      return false;
    }

    if (!this.preExistingToChipsByMentionChip.has(chip)) {
      const sessionSnapshot = this.preMentionToChipsByComposeBody.get(composeBody);
      if (sessionSnapshot) {
        this.preExistingToChipsByMentionChip.set(chip, new Set(sessionSnapshot));
      }
    }

    // Consume the active '@' keystroke session for this compose body.
    this.atSessionByComposeBody.delete(composeBody);
    this.preMentionToChipsByComposeBody.delete(composeBody);

    const recipient = GmailDomHelper.extractMentionRecipient(chip, composeBody);
    if (!recipient) {
      return false;
    }

    this.unconfirmedByChip.set(chip, recipient);
    return true;
  }

  private hasActiveAtSession(composeBody: HTMLElement): boolean {
    const startedAt = this.atSessionByComposeBody.get(composeBody);
    if (startedAt === undefined) {
      return false;
    }
    if (Date.now() - startedAt > AT_SESSION_TTL_MS) {
      this.atSessionByComposeBody.delete(composeBody);
      this.preMentionToChipsByComposeBody.delete(composeBody);
      return false;
    }
    return true;
  }

  private handleConfirmedRecipients(confirmed: readonly MentionRecipientInterface[]): void {
    for (const recipient of confirmed) {
      this.unconfirmedByChip.delete(recipient.chipElement);
    }
    this.pruneDetachedUnconfirmedChips();
    if (this.unconfirmedByChip.size > 0) {
      this.modal.present(Array.from(this.unconfirmedByChip.values()));
    }
  }

  /**
   * Handles "No, remove from To": keeps the `@Name` `mailto:` link in the email
   * body (detached from Gmail's `PlusMentionPlugin` recipient sync) while removing
   * the newly-added recipient chip from the `To` recipient list.
   */
  private handleDeclinedRecipients(
    declined: readonly MentionRecipientInterface[]
  ): HTMLElement | null {
    let lastReplacementAnchor: HTMLElement | null = null;

    for (const recipient of declined) {
      const chip = recipient.chipElement;
      const composeBody = recipient.composeBodyElement;
      const preExistingToChips = this.preExistingToChipsByMentionChip.get(chip);

      const rawEmail = PiiMaskingHelper.extractValidEmail(
        chip.getAttribute('email'),
        chip.getAttribute('href')
      );

      this.unconfirmedByChip.delete(chip);

      if (chip.isConnected) {
        lastReplacementAnchor = GmailDomHelper.detachMentionChipFromRecipientSync(
          chip,
          composeBody,
          (replacementLink) => {
            this.processedClosedChips.add(replacementLink);
          }
        );
      }

      if (rawEmail) {
        const removedImmediately = GmailDomHelper.removeNewlyAddedToRecipientChip(
          composeBody,
          rawEmail,
          preExistingToChips
        );

        if (!removedImmediately) {
          const timerId = setTimeout(() => {
            this.pendingRemovalTimers.delete(timerId);
            const removedAsync = GmailDomHelper.removeNewlyAddedToRecipientChip(
              composeBody,
              rawEmail,
              preExistingToChips
            );
            if (removedAsync && composeBody.isConnected && !this.modal.isActive()) {
              try {
                composeBody.focus({ preventScroll: true });
              } catch {
                composeBody.focus();
              }
            }
          }, ASYNC_TO_CHIP_REMOVAL_RETRY_MS);
          this.pendingRemovalTimers.add(timerId);
        }
      }
    }

    this.pruneDetachedUnconfirmedChips();
    if (this.unconfirmedByChip.size > 0) {
      this.modal.present(Array.from(this.unconfirmedByChip.values()));
    }

    return lastReplacementAnchor;
  }

  private pruneDetachedUnconfirmedChips(): void {
    for (const [chip, recipient] of Array.from(this.unconfirmedByChip.entries())) {
      const stillInCompose =
        chip.isConnected &&
        recipient.composeBodyElement.isConnected &&
        recipient.composeBodyElement.contains(chip) &&
        !GmailDomHelper.isInsideQuotedContent(chip, recipient.composeBodyElement);

      if (!stillInCompose) {
        this.unconfirmedByChip.delete(chip);
      }
    }
  }
}
