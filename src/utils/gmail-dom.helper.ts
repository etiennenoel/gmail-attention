import { MentionRecipientInterface } from '../models/mention-recipient.interface';
import { PiiMaskingHelper } from './pii-masking.helper';

const EXPLICIT_COMPOSE_BODY_SELECTOR =
  'div[g_editable="true"], body[g_editable="true"], div[aria-label="Message Body"], div[aria-label="Message body"], div.Am.Al.editable[contenteditable="true"]';

const FALLBACK_TEXTBOX_SELECTOR = 'div[contenteditable="true"][role="textbox"]';

const COMPOSE_CONTAINER_SELECTOR = 'div[role="dialog"], .M9, .AD, div.aoI';

const SEND_BUTTON_SELECTOR =
  'div[data-tooltip^="Send"], div.aoO[role="button"], div[role="button"].aoO, div.aoO, [role="button"][aria-label^="Send"]';

const TO_RECIPIENT_FIELD_SELECTOR =
  'div[name="to"], div[aria-label="To recipients"]';

const RECIPIENT_CHIP_SELECTOR =
  'div[role="option"][data-hovercard-id], [data-hovercard-id]';

const EXCLUDED_ARIA_LABEL_PREFIXES = [
  'describe your message',
  'help me write',
  'to',
  'cc',
  'bcc',
  'subject',
  'search',
];

let fallbackChipCounter = 0;

/**
 * DOM queries and predicates tailored to Gmail's Pinto compose editor and
 * `PlusMentionPlugin` (`a.gmail_plusreply`) lifecycle.
 */
export class GmailDomHelper {
  /**
   * Determines whether an element is a Gmail compose message body editor
   * (excluding auxiliary inputs such as Gemini "Describe your message" or recipient fields).
   */
  public static isComposeBody(element: Element | null): element is HTMLElement {
    if (!element) {
      return false;
    }
    const tagName = element.tagName.toUpperCase();
    if (tagName !== 'DIV' && !(tagName === 'BODY' && element.getAttribute('g_editable') === 'true')) {
      return false;
    }

    if (GmailDomHelper.isExcludedAuxiliaryInput(element)) {
      return false;
    }

    const contentEditableAttr = element.getAttribute('contenteditable');
    const isEditable =
      contentEditableAttr === 'true' ||
      contentEditableAttr === '' ||
      (element as HTMLElement).isContentEditable === true ||
      element.getAttribute('g_editable') === 'true';
    if (!isEditable) {
      return false;
    }

    if (element.getAttribute('g_editable') === 'true') {
      return true;
    }

    const ariaLabel = (element.getAttribute('aria-label') ?? '').trim().toLowerCase();
    if (ariaLabel === 'message body') {
      return true;
    }

    if (
      element.classList.contains('Am') &&
      element.classList.contains('Al') &&
      element.classList.contains('editable')
    ) {
      return true;
    }

    if (element.getAttribute('role') === 'textbox') {
      const container = element.closest(COMPOSE_CONTAINER_SELECTOR);
      if (container) {
        return true;
      }
    }

    return false;
  }

  /**
   * Finds all active Gmail compose message body elements within `root`.
   */
  public static findComposeBodies(root: ParentNode): HTMLElement[] {
    const seen = new Set<HTMLElement>();
    const results: HTMLElement[] = [];

    if (GmailDomHelper.isElementNode(root) && GmailDomHelper.isComposeBody(root)) {
      seen.add(root);
      results.push(root);
    }

    const explicitCandidates = root.querySelectorAll(EXPLICIT_COMPOSE_BODY_SELECTOR);
    for (const candidate of Array.from(explicitCandidates)) {
      if (GmailDomHelper.isComposeBody(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        results.push(candidate);
      }
    }

    const fallbackCandidates = root.querySelectorAll(FALLBACK_TEXTBOX_SELECTOR);
    for (const candidate of Array.from(fallbackCandidates)) {
      if (GmailDomHelper.isComposeBody(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        results.push(candidate);
      }
    }

    return results;
  }

  /**
   * Walks up the ancestor chain from `node` to locate its enclosing Gmail compose body.
   */
  public static findEnclosingComposeBody(node: Node | null): HTMLElement | null {
    let current: Node | null = node;
    while (current) {
      if (GmailDomHelper.isElementNode(current) && GmailDomHelper.isComposeBody(current)) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  /**
   * Checks whether `node` resides inside quoted email history (`.gmail_quote`,
   * `.gmail_attr`, or `blockquote`) within `stopAtComposeBody`.
   */
  public static isInsideQuotedContent(
    node: Node | null,
    stopAtComposeBody?: HTMLElement | null
  ): boolean {
    let current: Node | null = node;
    while (current && current !== stopAtComposeBody) {
      if (GmailDomHelper.isElementNode(current)) {
        if (
          current.classList.contains('gmail_quote') ||
          current.classList.contains('gmail_attr') ||
          current.tagName.toUpperCase() === 'BLOCKQUOTE'
        ) {
          return true;
        }
      }
      current = current.parentNode;
    }
    return false;
  }

  /**
   * Resolves a Gmail Send button element if `target` is inside one.
   */
  public static findSendButtonFromTarget(target: EventTarget | null): HTMLElement | null {
    if (!target || typeof (target as Node).nodeType !== 'number') {
      return null;
    }
    const startElement = GmailDomHelper.isElementNode(target as Node)
      ? (target as Element)
      : (target as Node).parentElement;
    if (!startElement) {
      return null;
    }

    const matched = startElement.closest(SEND_BUTTON_SELECTOR);
    if (!matched) {
      return null;
    }

    // Exclude "More send options" dropdown arrow buttons adjacent to Send.
    const ariaLabel = (matched.getAttribute('aria-label') ?? '').toLowerCase();
    if (ariaLabel.includes('more send options') || ariaLabel.includes('schedule send')) {
      return null;
    }

    return matched as HTMLElement;
  }

  /**
   * Finds the compose message body associated with a clicked Gmail Send button.
   */
  public static findMessageBodyFromSendButton(sendButton: Element): HTMLElement | null {
    const composeContainer = sendButton.closest(COMPOSE_CONTAINER_SELECTOR);
    if (composeContainer) {
      const body = GmailDomHelper.pickPrimaryComposeBody(composeContainer);
      if (body) {
        return body;
      }
    }

    let current: Element | null = sendButton.parentElement;
    while (current && current.tagName.toUpperCase() !== 'BODY') {
      if (current.getAttribute('role') === 'region') {
        break;
      }
      const body = GmailDomHelper.pickPrimaryComposeBody(current);
      if (body) {
        return body;
      }
      current = current.parentElement;
    }

    return null;
  }

  /**
   * Checks whether `node` is a Gmail `PlusMentionChip` anchor (`a.gmail_plusreply`).
   */
  public static isMentionChip(node: Node | null): node is HTMLAnchorElement {
    return (
      GmailDomHelper.isElementNode(node) &&
      node.tagName.toUpperCase() === 'A' &&
      node.classList.contains('gmail_plusreply')
    );
  }

  /**
   * Collects all `a.gmail_plusreply` chips on or inside `node`, excluding quoted reply history.
   */
  public static findMentionChipsInSubtree(
    node: Node,
    composeBody?: HTMLElement | null
  ): HTMLAnchorElement[] {
    const chips: HTMLAnchorElement[] = [];
    if (!GmailDomHelper.isElementNode(node)) {
      return chips;
    }

    if (
      GmailDomHelper.isMentionChip(node) &&
      !GmailDomHelper.isInsideQuotedContent(node, composeBody)
    ) {
      chips.push(node);
    }

    const descendants = node.querySelectorAll('a.gmail_plusreply');
    for (const descendant of Array.from(descendants)) {
      if (
        GmailDomHelper.isMentionChip(descendant) &&
        !GmailDomHelper.isInsideQuotedContent(descendant, composeBody)
      ) {
        chips.push(descendant);
      }
    }

    return chips;
  }

  /**
   * Returns true if the mention chip text starts with `@` (ignoring zero-width spaces).
   */
  public static hasAtTriggerPrefix(chipElement: Element): boolean {
    const normalized = (chipElement.textContent ?? '').replace(/^[\s\u00A0\u200B\uFEFF]+/, '');
    return normalized.startsWith('@');
  }

  /**
   * Returns true if the mention chip text starts with `+` (ignoring zero-width spaces).
   */
  public static hasPlusTriggerPrefix(chipElement: Element): boolean {
    const normalized = (chipElement.textContent ?? '').replace(/^[\s\u00A0\u200B\uFEFF]+/, '');
    return normalized.startsWith('+');
  }

  /**
   * Determines whether a `a.gmail_plusreply` chip has been closed after a contact
   * was selected from Gmail's PeopleKit autocomplete menu.
   *
   * Per `PlusMentionChip.setContent()` + `close()`, a selected chip receives:
   * - `email="<addr>"` and `href="mailto:<addr>"`
   * - `contenteditable="false"` (and `tabindex="-1"`)
   */
  public static isClosedMentionChip(chipElement: Element): boolean {
    if (!GmailDomHelper.isMentionChip(chipElement)) {
      return false;
    }

    const email = PiiMaskingHelper.extractValidEmail(
      chipElement.getAttribute('email'),
      chipElement.getAttribute('href')
    );
    if (!email) {
      return false;
    }

    const contentEditable = chipElement.getAttribute('contenteditable');
    const tabIndex = chipElement.getAttribute('tabindex');
    return contentEditable === 'false' || tabIndex === '-1';
  }

  /**
   * Builds a PII-masked `MentionRecipientInterface` from a closed Gmail mention chip.
   */
  public static extractMentionRecipient(
    chipElement: HTMLAnchorElement,
    composeBodyElement: HTMLElement
  ): MentionRecipientInterface | null {
    const rawEmail = PiiMaskingHelper.extractValidEmail(
      chipElement.getAttribute('email'),
      chipElement.getAttribute('href')
    );
    if (!rawEmail) {
      return null;
    }

    const rawText = chipElement.textContent ?? '';
    const { displayLabel, hasDistinctDisplayName } = PiiMaskingHelper.formatDisplayLabel(
      rawText,
      rawEmail
    );
    const maskedEmail = PiiMaskingHelper.maskEmail(rawEmail);

    const rawId = (chipElement.getAttribute('id') ?? '').trim();
    const chipId =
      rawId.length > 0 ? rawId : `gmail-mention-chip-${++fallbackChipCounter}`;

    return {
      chipId,
      displayLabel,
      maskedEmail,
      hasDistinctDisplayName,
      chipElement,
      composeBodyElement,
    };
  }

  /**
   * Locates the enclosing Gmail compose widget container for a compose message body.
   */
  public static findComposeContainer(composeBody: HTMLElement): HTMLElement | null {
    const directContainer = composeBody.closest(COMPOSE_CONTAINER_SELECTOR);
    if (directContainer) {
      return directContainer as HTMLElement;
    }

    let current: HTMLElement | null = composeBody.parentElement;
    while (current && current.tagName.toUpperCase() !== 'BODY') {
      if (current.getAttribute('role') === 'main') {
        break;
      }
      if (current.querySelector(TO_RECIPIENT_FIELD_SELECTOR)) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  }

  /**
   * Locates the Gmail `To` recipient bar (`div[name="to"]` / `aria-label="To recipients"`)
   * associated with `composeBody`.
   */
  public static findToRecipientField(composeBody: HTMLElement): HTMLElement | null {
    const container = GmailDomHelper.findComposeContainer(composeBody);
    if (!container) {
      return null;
    }
    const toField = container.querySelector(TO_RECIPIENT_FIELD_SELECTOR);
    return toField ? (toField as HTMLElement) : null;
  }

  /**
   * Captures the set of PeopleKit recipient chip elements currently present in the
   * compose container so pre-existing thread recipients are never removed if the
   * user declines a subsequent `@`-mention addition.
   */
  public static snapshotToRecipientChips(composeBody: HTMLElement): Set<Element> {
    const scope =
      GmailDomHelper.findComposeContainer(composeBody) ??
      GmailDomHelper.findToRecipientField(composeBody);
    const snapshot = new Set<Element>();
    if (!scope) {
      return snapshot;
    }

    for (const chip of GmailDomHelper.findRecipientChipsInScope(scope, composeBody)) {
      snapshot.add(chip);
    }
    return snapshot;
  }

  /**
   * Preserves the `@Name` `mailto:` link in the compose body while detaching it from
   * Gmail's `PlusMentionPlugin.elementIdToChip` tracking (by replacing the anchor with
   * an ID-free clone and dispatching an `input` event on `composeBody` so Gmail's
   * `ComposePlusMentionHelper` drops the address from `plusMentionedEmails`).
   */
  public static detachMentionChipFromRecipientSync(
    chipElement: HTMLAnchorElement,
    composeBody: HTMLElement,
    onBeforeInsert?: (replacementLink: HTMLAnchorElement) => void
  ): HTMLAnchorElement {
    const doc = chipElement.ownerDocument;
    if (!doc || !chipElement.parentNode) {
      chipElement.removeAttribute('id');
      return chipElement;
    }

    const replacementLink = doc.createElement('a');
    for (const attrName of ['class', 'href', 'email', 'contenteditable', 'tabindex']) {
      const val = chipElement.getAttribute(attrName);
      if (val !== null) {
        replacementLink.setAttribute(attrName, val);
      }
    }
    replacementLink.textContent = chipElement.textContent ?? '';

    if (onBeforeInsert) {
      onBeforeInsert(replacementLink);
    }

    chipElement.parentNode.replaceChild(replacementLink, chipElement);

    if (composeBody.isConnected) {
      const EventCtor = doc.defaultView?.Event ?? (typeof Event !== 'undefined' ? Event : null);
      if (EventCtor) {
        composeBody.dispatchEvent(new EventCtor('input', { bubbles: true, cancelable: false }));
      }
    }

    return replacementLink;
  }

  /**
   * Removes any newly-added PeopleKit recipient chip matching `rawEmail` from the
   * compose draft's `To` recipient list (skipping chips present in `preExistingToChips`).
   * Returns `true` if at least one newly-added `To` chip was found and removed.
   */
  public static removeNewlyAddedToRecipientChip(
    composeBody: HTMLElement,
    rawEmail: string,
    preExistingToChips?: ReadonlySet<Element>
  ): boolean {
    const normalizedTarget = rawEmail.trim().toLowerCase();
    if (normalizedTarget.length === 0) {
      return false;
    }

    const scopes: Element[] = [];
    const toField = GmailDomHelper.findToRecipientField(composeBody);
    if (toField) {
      scopes.push(toField);
    }
    const container = GmailDomHelper.findComposeContainer(composeBody);
    if (container && container !== toField) {
      scopes.push(container);
    }
    if (scopes.length === 0) {
      return false;
    }

    let removedAny = false;

    for (const scope of scopes) {
      const candidateChips = GmailDomHelper.findRecipientChipsInScope(scope, composeBody);

      for (const chip of candidateChips) {
        if (preExistingToChips?.has(chip)) {
          continue;
        }

        const chipEmail = (
          chip.getAttribute('data-hovercard-id') ??
          chip.getAttribute('email') ??
          ''
        )
          .trim()
          .toLowerCase();

        if (chipEmail !== normalizedTarget) {
          continue;
        }

        const deleteButton = GmailDomHelper.findDeleteButtonInRecipientChip(chip);
        if (!deleteButton) {
          continue;
        }

        if (typeof (deleteButton as HTMLElement).click === 'function') {
          (deleteButton as HTMLElement).click();
          removedAny = true;
        } else {
          const MouseEventCtor =
            chip.ownerDocument?.defaultView?.MouseEvent ??
            (typeof MouseEvent !== 'undefined' ? MouseEvent : null);
          if (MouseEventCtor) {
            deleteButton.dispatchEvent(
              new MouseEventCtor('click', { bubbles: true, cancelable: true })
            );
            removedAny = true;
          }
        }
      }

      if (removedAny) {
        break;
      }
    }

    return removedAny;
  }

  private static findRecipientChipsInScope(
    scope: Element,
    composeBody: HTMLElement
  ): Element[] {
    const rawMatches = Array.from(scope.querySelectorAll(RECIPIENT_CHIP_SELECTOR));
    const uniqueChips: Element[] = [];
    const seen = new Set<Element>();

    for (const match of rawMatches) {
      if (composeBody.contains(match)) {
        continue;
      }
      const rootChip =
        match.getAttribute('role') === 'option'
          ? match
          : (match.closest('div[role="option"][data-hovercard-id]') ?? match);

      if (!seen.has(rootChip) && !composeBody.contains(rootChip)) {
        seen.add(rootChip);
        uniqueChips.push(rootChip);
      }
    }

    return uniqueChips;
  }

  private static findDeleteButtonInRecipientChip(chip: Element): Element | null {
    const descendants = Array.from(chip.querySelectorAll('*'));
    const describedById = (chip.getAttribute('aria-describedby') ?? '').trim();
    if (describedById.length > 0) {
      const byDescribedBy = descendants.find(
        (el) => (el.getAttribute('id') ?? '') === describedById
      );
      if (byDescribedBy) {
        return byDescribedBy;
      }
    }

    const chipId = (chip.getAttribute('id') ?? '').trim();
    if (chipId.length > 0) {
      const expectedDeleteId = `${chipId}-db`;
      const byChipIdSuffix = descendants.find(
        (el) => (el.getAttribute('id') ?? '') === expectedDeleteId
      );
      if (byChipIdSuffix) {
        return byChipIdSuffix;
      }
    }

    const bySuffixOrLabel = descendants.find((el) => {
      const id = (el.getAttribute('id') ?? '').trim();
      if (id.endsWith('-db')) {
        return true;
      }
      const ariaLabel = (el.getAttribute('aria-label') ?? '').toLowerCase();
      return ariaLabel.includes('remove') || ariaLabel.includes('delete');
    });

    return bySuffixOrLabel ?? null;
  }

  private static pickPrimaryComposeBody(container: Element): HTMLElement | null {
    const explicit = Array.from(
      container.querySelectorAll(EXPLICIT_COMPOSE_BODY_SELECTOR)
    ).filter((el): el is HTMLElement => GmailDomHelper.isComposeBody(el));
    if (explicit.length > 0) {
      return explicit[explicit.length - 1] ?? null;
    }

    const fallback = Array.from(container.querySelectorAll(FALLBACK_TEXTBOX_SELECTOR)).filter(
      (el): el is HTMLElement => GmailDomHelper.isComposeBody(el)
    );
    if (fallback.length > 0) {
      return fallback[fallback.length - 1] ?? null;
    }

    return null;
  }

  private static isExcludedAuxiliaryInput(element: Element): boolean {
    const ariaLabel = (element.getAttribute('aria-label') ?? '').trim().toLowerCase();
    if (ariaLabel.length === 0) {
      return false;
    }
    if (ariaLabel === 'message body') {
      return false;
    }
    return EXCLUDED_ARIA_LABEL_PREFIXES.some(
      (prefix) =>
        ariaLabel === prefix ||
        ariaLabel.startsWith(`${prefix} `) ||
        ariaLabel.startsWith(`${prefix}:`)
    );
  }

  private static isElementNode(node: Node | ParentNode | null): node is Element {
    return Boolean(node && (node as Node).nodeType === 1);
  }
}
