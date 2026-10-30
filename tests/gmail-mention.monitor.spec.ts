import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import {
  bootstrapGmailAttention,
  GmailAttentionStatusResponseInterface,
  isVerifiedGmailWindow,
} from '../src/content.entry';
import { GmailMentionMonitor } from '../src/core/gmail-mention.monitor';
import { computePopupViewState } from '../src/popup.entry';
import {
  FakeDocument,
  FakeElement,
  FakeEvent,
  installFakeDomGlobals,
} from './fake-dom.helper';

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function createComposeFixture(doc: FakeDocument): {
  container: FakeElement;
  toField: FakeElement;
  composeBody: FakeElement;
  sendButton: FakeElement;
} {
  const container = doc.createElement('div');
  container.className = 'M9';
  container.setAttribute('role', 'dialog');

  const toField = doc.createElement('div');
  toField.setAttribute('name', 'to');
  toField.setAttribute('aria-label', 'To recipients');

  const composeBody = doc.createElement('div');
  composeBody.setAttribute('contenteditable', 'true');
  composeBody.setAttribute('role', 'textbox');
  composeBody.setAttribute('aria-label', 'Message Body');
  composeBody.setAttribute('g_editable', 'true');

  const sendButton = doc.createElement('div');
  sendButton.className = 'aoO';
  sendButton.setAttribute('role', 'button');
  sendButton.setAttribute('data-tooltip', 'Send');

  container.appendChild(toField);
  container.appendChild(composeBody);
  container.appendChild(sendButton);
  doc.body.appendChild(container);

  return { container, toField, composeBody, sendButton };
}

function appendPeopleKitToChip(
  doc: FakeDocument,
  toField: FakeElement,
  chipId: string,
  email: string
): FakeElement {
  const toChip = doc.createElement('div');
  toChip.id = chipId;
  toChip.setAttribute('role', 'option');
  toChip.setAttribute('data-hovercard-id', email);
  toChip.setAttribute('aria-describedby', `${chipId}-db`);

  const deleteButton = doc.createElement('div');
  deleteButton.id = `${chipId}-db`;
  deleteButton.setAttribute('aria-label', 'Press delete to remove this chip');
  deleteButton.addEventListener('click', () => {
    toChip.remove();
  });

  toChip.appendChild(deleteButton);
  toField.appendChild(toChip);
  return toChip;
}

function getModalHostAndShadow(doc: FakeDocument): {
  host: FakeElement | null;
  dialog: FakeElement | null;
  declineButton: FakeElement | null;
  confirmButton: FakeElement | null;
  description: FakeElement | null;
  sendNotice: FakeElement | null;
} {
  const host = doc.querySelector('div[data-gmail-attention-host="true"]');
  const shadow = host?.testShadowRoot ?? null;
  return {
    host,
    dialog: shadow?.querySelector('dialog') ?? null,
    declineButton: shadow?.querySelector('button.gmn-decline-btn') ?? null,
    confirmButton: shadow?.querySelector('button.gmn-confirm-btn') ?? null,
    description: shadow?.querySelector('#gmn-description') ?? null,
    sendNotice: shadow?.querySelector('.gmn-send-notice') ?? null,
  };
}

describe('GmailMentionMonitor', () => {
  let doc: FakeDocument;
  let restoreGlobals: () => void;
  let monitor: GmailMentionMonitor;

  beforeEach(() => {
    doc = new FakeDocument();
    restoreGlobals = installFakeDomGlobals(doc);
    monitor = new GmailMentionMonitor(doc as unknown as Document);
  });

  afterEach(() => {
    monitor.stop();
    restoreGlobals();
  });

  it('does NOT notify while typing @query, then steals focus onto Confirm modal once contact is selected', async () => {
    const { composeBody } = createComposeFixture(doc);
    monitor.start();
    composeBody.focus();

    // Step 1: User presses '@' -> Gmail inserts open `a.gmail_plusreply`
    composeBody.dispatchEvent(new FakeEvent('keydown', { key: '@' }));
    const chip = doc.createElement('a');
    chip.className = 'gmail_plusreply';
    chip.id = 'plusReplyChip-0';
    chip.textContent = '@';
    composeBody.appendChild(chip);
    doc.flushMutations();

    // User continues typing '@ali' while autocomplete popup is open
    chip.textContent = '@ali';
    doc.flushMutations();
    await flushMacrotask();

    // Modal must NOT appear yet before autocomplete selection!
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);
    expect(getModalHostAndShadow(doc).dialog).toBeNull();
    expect(doc.activeElement).toBe(composeBody);

    // Step 2: User selects "Alice Smith" from Gmail's '@' autocomplete menu
    chip.textContent = '@Alice Smith';
    chip.setAttribute('href', 'mailto:alice.smith@example.com');
    chip.setAttribute('email', 'alice.smith@example.com');
    chip.setAttribute('contenteditable', 'false');
    chip.setAttribute('tabindex', '-1');
    doc.flushMutations();

    expect(monitor.getUnconfirmedRecipients()).toHaveLength(1);
    await flushMacrotask();

    const { host, dialog, declineButton, confirmButton, description } =
      getModalHostAndShadow(doc);
    expect(host).not.toBeNull();
    expect(dialog?.open).toBe(true);
    expect(declineButton?.textContent).toBe('No, remove from To');
    expect(confirmButton?.textContent).toBe('Yes, keep in To');

    // Focus was stolen from Gmail compose body into the closed Shadow DOM Confirm button
    expect(doc.activeElement).toBe(host);
    expect(host?.testShadowRoot?.activeElement).toBe(confirmButton);

    // Message notifies that person will be added to recipient list & masks email PII
    const renderedText = description?.textContent ?? '';
    expect(renderedText).toContain('Alice Smith');
    expect(renderedText).toContain('a***h@example.com');
    expect(renderedText).not.toContain('alice.smith@example.com');
    expect(renderedText).toContain('To email recipient list');
  });

  it('recaptures focus if Gmail asynchronously tries to focus the compose editor while unconfirmed', async () => {
    const { composeBody } = createComposeFixture(doc);
    monitor.start();
    composeBody.focus();

    const chip = doc.createElement('a');
    chip.className = 'gmail_plusreply';
    chip.textContent = '@bob';
    composeBody.appendChild(chip);
    doc.flushMutations();

    chip.textContent = '@Bob Jones';
    chip.setAttribute('href', 'mailto:bob@example.com');
    chip.setAttribute('email', 'bob@example.com');
    chip.setAttribute('contenteditable', 'false');
    doc.flushMutations();
    await flushMacrotask();

    const { host, confirmButton } = getModalHostAndShadow(doc);
    expect(doc.activeElement).toBe(host);

    // Simulate Gmail's editor calling composeBody.focus() asynchronously
    composeBody.focus();

    // Capture-phase focusin guard immediately steals focus right back to Confirm button
    expect(doc.activeElement).toBe(host);
    expect(host?.testShadowRoot?.activeElement).toBe(confirmButton);
  });

  it('prevents the autocomplete Enter keystroke bounce from prematurely confirming, then confirms and restores focus on deliberate click', async () => {
    const { composeBody } = createComposeFixture(doc);
    monitor.start();
    composeBody.focus();

    const chip = doc.createElement('a');
    chip.className = 'gmail_plusreply';
    chip.textContent = '@carol';
    composeBody.appendChild(chip);
    doc.flushMutations();

    chip.textContent = '@Carol Danvers';
    chip.setAttribute('href', 'mailto:carol@example.com');
    chip.setAttribute('email', 'carol@example.com');
    chip.setAttribute('contenteditable', 'false');
    doc.flushMutations();
    await flushMacrotask();

    const { dialog, confirmButton } = getModalHostAndShadow(doc);
    expect(dialog?.open).toBe(true);

    // Stray synthetic keyboard click (`detail === 0`) without a post-open keydown is ignored
    confirmButton!.dispatchEvent(new FakeEvent('click', { detail: 0 }));
    expect(dialog?.open).toBe(true);
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(1);

    // Escape cancel event is also blocked so confirmation cannot be bypassed
    const cancelEvent = new FakeEvent('cancel', { bubbles: false, cancelable: true });
    dialog!.dispatchEvent(cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(dialog?.open).toBe(true);

    // Deliberate pointer click (`detail === 1`) confirms, closes modal, and restores focus to composeBody
    confirmButton!.dispatchEvent(new FakeEvent('click', { detail: 1 }));
    expect(dialog?.open).toBe(false);
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);
    expect(doc.activeElement).toBe(composeBody);
  });

  it('absorbs immediate Enter keydown bounce (<160ms) and confirms cleanly on Enter keydown after grace window without leaking Enter to compose', async () => {
    const { composeBody } = createComposeFixture(doc);
    monitor.start();
    composeBody.focus();

    let leakedEnterIntoCompose = false;
    composeBody.addEventListener('keydown', (e) => {
      if ((e as unknown as FakeEvent).key === 'Enter') {
        leakedEnterIntoCompose = true;
      }
    });

    const chip = doc.createElement('a');
    chip.className = 'gmail_plusreply';
    chip.textContent = '@grace';
    composeBody.appendChild(chip);
    doc.flushMutations();

    chip.textContent = '@Grace Hopper';
    chip.setAttribute('href', 'mailto:grace@example.com');
    chip.setAttribute('email', 'grace@example.com');
    chip.setAttribute('contenteditable', 'false');
    doc.flushMutations();
    await flushMacrotask();

    const { dialog } = getModalHostAndShadow(doc);
    expect(dialog?.open).toBe(true);

    // Immediate Enter keydown within 160ms grace window is absorbed without dismissing unseen modal
    const earlyEnter = new FakeEvent('keydown', { key: 'Enter' });
    doc.dispatchEvent(earlyEnter);
    expect(earlyEnter.defaultPrevented).toBe(true);
    expect(dialog?.open).toBe(true);
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(1);

    // Wait past 160ms grace window -> Enter keydown confirms modal, prevents default newline leak, and restores focus
    await new Promise((resolve) => setTimeout(resolve, 175));
    const deliberateEnter = new FakeEvent('keydown', { key: 'Enter' });
    doc.dispatchEvent(deliberateEnter);
    expect(deliberateEnter.defaultPrevented).toBe(true);
    expect(leakedEnterIntoCompose).toBe(false);
    expect(dialog?.open).toBe(false);
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);
    expect(doc.activeElement).toBe(composeBody);
  });

  it('blocks Send button clicks and Cmd/Ctrl+Enter shortcuts until confirmed, then allows sending', async () => {
    const { composeBody, sendButton } = createComposeFixture(doc);
    monitor.start();

    let gmailSendTriggeredCount = 0;
    sendButton.addEventListener('click', () => {
      gmailSendTriggeredCount++;
    });
    composeBody.addEventListener('keydown', (e) => {
      const ke = e as unknown as FakeEvent;
      if ((ke.metaKey || ke.ctrlKey) && ke.key === 'Enter') {
        gmailSendTriggeredCount++;
      }
    });

    // Insert & select '@Dave'
    const chip = doc.createElement('a');
    chip.className = 'gmail_plusreply';
    chip.textContent = '@dave';
    composeBody.appendChild(chip);
    doc.flushMutations();

    chip.textContent = '@Dave Grohl';
    chip.setAttribute('href', 'mailto:dave@example.com');
    chip.setAttribute('email', 'dave@example.com');
    chip.setAttribute('contenteditable', 'false');
    doc.flushMutations();
    await flushMacrotask();

    // Attempt 1: Click Gmail's Send button while unconfirmed -> BLOCKED!
    const sendClick = new FakeEvent('click', { detail: 1 });
    sendButton.dispatchEvent(sendClick);
    expect(sendClick.defaultPrevented).toBe(true);
    expect(gmailSendTriggeredCount).toBe(0);
    expect(getModalHostAndShadow(doc).sendNotice?.hidden).toBe(false);

    // Attempt 2: Press Cmd+Enter while unconfirmed -> BLOCKED!
    const cmdEnter = new FakeEvent('keydown', { key: 'Enter', metaKey: true });
    composeBody.dispatchEvent(cmdEnter);
    expect(cmdEnter.defaultPrevented).toBe(true);
    expect(gmailSendTriggeredCount).toBe(0);

    // Confirm in the modal
    const { confirmButton } = getModalHostAndShadow(doc);
    confirmButton!.dispatchEvent(new FakeEvent('click', { detail: 1 }));
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);

    // Attempt 3: Click Send after confirming -> ALLOWED!
    sendButton.dispatchEvent(new FakeEvent('click', { detail: 1 }));
    expect(gmailSendTriggeredCount).toBe(1);

    // Attempt 4: Cmd+Enter after confirming -> ALLOWED!
    composeBody.dispatchEvent(new FakeEvent('keydown', { key: 'Enter', ctrlKey: true }));
    expect(gmailSendTriggeredCount).toBe(2);
  });

  it('auto-clears unconfirmed state and unlocks sending if the user deletes the @mention chip', async () => {
    const { composeBody, sendButton } = createComposeFixture(doc);
    monitor.start();

    let sent = false;
    sendButton.addEventListener('click', () => {
      sent = true;
    });

    const chip = doc.createElement('a');
    chip.className = 'gmail_plusreply';
    chip.textContent = '@eve';
    composeBody.appendChild(chip);
    doc.flushMutations();

    chip.textContent = '@Eve';
    chip.setAttribute('href', 'mailto:eve@example.com');
    chip.setAttribute('email', 'eve@example.com');
    chip.setAttribute('contenteditable', 'false');
    doc.flushMutations();
    await flushMacrotask();

    expect(getModalHostAndShadow(doc).dialog?.open).toBe(true);

    // Chip is removed from compose body
    chip.remove();
    doc.flushMutations();

    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);
    expect(getModalHostAndShadow(doc).dialog?.open).toBe(false);

    sendButton.dispatchEvent(new FakeEvent('click', { detail: 1 }));
    expect(sent).toBe(true);
  });

  it('keeps the @mention link in the body, removes the newly-added To chip, does not re-trigger, and unlocks Send when clicking "No, remove from To"', async () => {
    const { toField, composeBody, sendButton } = createComposeFixture(doc);
    monitor.start();
    composeBody.focus();

    let sendCount = 0;
    sendButton.addEventListener('click', () => {
      sendCount++;
    });

    // User types '@alice' and selects Alice Smith
    composeBody.dispatchEvent(new FakeEvent('keydown', { key: '@' }));
    const chip = doc.createElement('a');
    chip.id = 'plusReplyChip-7';
    chip.className = 'gmail_plusreply';
    chip.textContent = '@ali';
    composeBody.appendChild(chip);
    doc.flushMutations();

    chip.textContent = '@Alice Smith';
    chip.setAttribute('href', 'mailto:alice.smith@example.com');
    chip.setAttribute('email', 'alice.smith@example.com');
    chip.setAttribute('contenteditable', 'false');
    chip.setAttribute('tabindex', '-1');
    const addedToChip = appendPeopleKitToChip(
      doc,
      toField,
      'pk-alice',
      'alice.smith@example.com'
    );
    doc.flushMutations();
    await flushMacrotask();

    const { dialog, declineButton } = getModalHostAndShadow(doc);
    expect(dialog?.open).toBe(true);
    expect(addedToChip.isConnected).toBe(true);

    // User clicks "No, remove from To"
    declineButton!.dispatchEvent(new FakeEvent('click', { detail: 1 }));
    doc.flushMutations();
    await flushMacrotask();

    // 1. Modal closed & no re-trigger on replacement <a> link
    expect(dialog?.open).toBe(false);
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);

    // 2. Newly-added To recipient chip was removed from To bar
    expect(addedToChip.isConnected).toBe(false);
    expect(toField.querySelectorAll('[data-hovercard-id]')).toHaveLength(0);

    // 3. The @Alice Smith link remains in the compose body without its PlusMentionPlugin ID
    const keptLink = composeBody.querySelector('a.gmail_plusreply');
    expect(keptLink).not.toBeNull();
    expect(keptLink?.textContent).toBe('@Alice Smith');
    expect(keptLink?.getAttribute('href')).toBe('mailto:alice.smith@example.com');
    expect(keptLink?.getAttribute('id')).toBeNull();

    // 4. Focus restored to composeBody and Send is unlocked
    expect(doc.activeElement).toBe(composeBody);
    sendButton.dispatchEvent(new FakeEvent('click', { detail: 1 }));
    expect(sendCount).toBe(1);
  });

  it('supports keyboard ArrowLeft / Tab navigation to "No, remove from To" and preserves pre-existing To recipients', async () => {
    const { toField, composeBody } = createComposeFixture(doc);
    // Pre-existing thread recipient in To before user types '@'
    const preExistingChip = appendPeopleKitToChip(
      doc,
      toField,
      'pk-existing',
      'existing@example.com'
    );

    monitor.start();
    composeBody.focus();

    let leakedEnterIntoCompose = false;
    composeBody.addEventListener('keydown', (e) => {
      if ((e as unknown as FakeEvent).key === 'Enter') {
        leakedEnterIntoCompose = true;
      }
    });

    // User mentions both a pre-existing recipient and a brand-new recipient
    composeBody.dispatchEvent(new FakeEvent('keydown', { key: '@' }));
    const existingMention = doc.createElement('a');
    existingMention.id = 'plusReplyChip-1';
    existingMention.className = 'gmail_plusreply';
    existingMention.textContent = '@exi';
    composeBody.appendChild(existingMention);
    doc.flushMutations();

    existingMention.textContent = '@Existing Colleague';
    existingMention.setAttribute('href', 'mailto:existing@example.com');
    existingMention.setAttribute('email', 'existing@example.com');
    existingMention.setAttribute('contenteditable', 'false');
    doc.flushMutations();
    await flushMacrotask();

    const { host, dialog, declineButton, confirmButton } = getModalHostAndShadow(doc);
    expect(dialog?.open).toBe(true);
    expect(host?.testShadowRoot?.activeElement).toBe(confirmButton);

    // Navigate with ArrowLeft -> focuses "No, remove from To"
    doc.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowLeft' }));
    expect(host?.testShadowRoot?.activeElement).toBe(declineButton);

    // Navigate with ArrowRight -> focuses "Yes, keep in To", then Tab -> back to "No, remove from To"
    doc.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowRight' }));
    expect(host?.testShadowRoot?.activeElement).toBe(confirmButton);
    doc.dispatchEvent(new FakeEvent('keydown', { key: 'Tab' }));
    expect(host?.testShadowRoot?.activeElement).toBe(declineButton);

    // If Gmail tries to steal focus back to composeBody, focus recapture preserves declineButton
    composeBody.focus();
    expect(doc.activeElement).toBe(host);
    expect(host?.testShadowRoot?.activeElement).toBe(declineButton);

    // Press Enter after 160ms grace window -> activates "No, remove from To"
    await new Promise((resolve) => setTimeout(resolve, 175));
    const enterEvent = new FakeEvent('keydown', { key: 'Enter' });
    doc.dispatchEvent(enterEvent);
    doc.flushMutations();

    expect(enterEvent.defaultPrevented).toBe(true);
    expect(leakedEnterIntoCompose).toBe(false);
    expect(dialog?.open).toBe(false);

    // Link stays in body AND pre-existing To recipient is NEVER deleted!
    expect(composeBody.querySelector('a.gmail_plusreply')?.textContent).toBe(
      '@Existing Colleague'
    );
    expect(preExistingChip.isConnected).toBe(true);
    expect(doc.activeElement).toBe(composeBody);
  });

  it('removes an asynchronously mounted To recipient chip via the 60ms retry timer if user clicks "No" before Gmail mounts it', async () => {
    const { toField, composeBody } = createComposeFixture(doc);
    monitor.start();
    composeBody.focus();

    composeBody.dispatchEvent(new FakeEvent('keydown', { key: '@' }));
    const chip = doc.createElement('a');
    chip.id = 'plusReplyChip-9';
    chip.className = 'gmail_plusreply';
    chip.textContent = '@lat';
    composeBody.appendChild(chip);
    doc.flushMutations();

    chip.textContent = '@Late Arrival';
    chip.setAttribute('href', 'mailto:late@example.com');
    chip.setAttribute('email', 'late@example.com');
    chip.setAttribute('contenteditable', 'false');
    doc.flushMutations();
    await flushMacrotask();

    const { declineButton } = getModalHostAndShadow(doc);
    // Click "No" BEFORE PeopleKit mounts the To chip
    declineButton!.dispatchEvent(new FakeEvent('click', { detail: 1 }));
    doc.flushMutations();

    // 20ms later, Gmail mounts the To chip asynchronously
    await new Promise((resolve) => setTimeout(resolve, 20));
    const asyncToChip = appendPeopleKitToChip(
      doc,
      toField,
      'pk-late',
      'late@example.com'
    );
    expect(asyncToChip.isConnected).toBe(true);

    // Wait past the 60ms retry window -> async To chip is automatically removed and focus stays on composeBody
    await new Promise((resolve) => setTimeout(resolve, 65));
    expect(asyncToChip.isConnected).toBe(false);
    expect(composeBody.querySelector('a.gmail_plusreply')?.textContent).toBe(
      '@Late Arrival'
    );
    expect(doc.activeElement).toBe(composeBody);
  });

  it('ignores pre-existing draft mentions, async-hydrated saved drafts, quoted replies, +mentions, cancelled @, and Backspace contenteditable toggles', async () => {
    // 1. Pre-existing compose body with an already-closed @mention before monitor starts
    const { composeBody } = createComposeFixture(doc);
    const existingDraftChip = doc.createElement('a');
    existingDraftChip.className = 'gmail_plusreply';
    existingDraftChip.textContent = '@Existing Draft Person';
    existingDraftChip.setAttribute('href', 'mailto:existing@example.com');
    existingDraftChip.setAttribute('email', 'existing@example.com');
    existingDraftChip.setAttribute('contenteditable', 'false');
    composeBody.appendChild(existingDraftChip);

    monitor.start();
    await flushMacrotask();
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);

    // 2. Async-hydrated saved draft (closed chip inserted directly without '@' keystroke or open chip)
    const hydratedChip = doc.createElement('a');
    hydratedChip.className = 'gmail_plusreply';
    hydratedChip.textContent = '@Hydrated Person';
    hydratedChip.setAttribute('href', 'mailto:hydrated@example.com');
    hydratedChip.setAttribute('email', 'hydrated@example.com');
    hydratedChip.setAttribute('contenteditable', 'false');
    composeBody.appendChild(hydratedChip);
    doc.flushMutations();
    await flushMacrotask();
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);

    // 3. Quoted reply history (.gmail_quote)
    const quote = doc.createElement('div');
    quote.className = 'gmail_quote';
    const quotedChip = doc.createElement('a');
    quotedChip.className = 'gmail_plusreply';
    quotedChip.textContent = '@Quoted Person';
    quotedChip.setAttribute('href', 'mailto:quoted@example.com');
    quotedChip.setAttribute('email', 'quoted@example.com');
    quotedChip.setAttribute('contenteditable', 'false');
    quote.appendChild(quotedChip);
    composeBody.appendChild(quote);
    doc.flushMutations();
    await flushMacrotask();
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);

    // 4. '+' mention (PlusMentionPlugin triggered with '+' instead of '@')
    composeBody.dispatchEvent(new FakeEvent('keydown', { key: '+' }));
    const plusChip = doc.createElement('a');
    plusChip.className = 'gmail_plusreply';
    plusChip.textContent = '+plus';
    composeBody.appendChild(plusChip);
    doc.flushMutations();
    plusChip.textContent = '+Plus Person';
    plusChip.setAttribute('href', 'mailto:plus@example.com');
    plusChip.setAttribute('email', 'plus@example.com');
    plusChip.setAttribute('contenteditable', 'false');
    doc.flushMutations();
    await flushMacrotask();
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);

    // 5. Cancelled '@' mention (chip stripped back to plain text node)
    composeBody.dispatchEvent(new FakeEvent('keydown', { key: '@' }));
    const cancelledChip = doc.createElement('a');
    cancelledChip.className = 'gmail_plusreply';
    cancelledChip.textContent = '@';
    composeBody.appendChild(cancelledChip);
    doc.flushMutations();
    cancelledChip.remove();
    composeBody.appendChild(doc.createTextNode('@ '));
    doc.flushMutations();
    await flushMacrotask();
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);

    // 6. Gmail ComposePlusMentionHelper toggling contenteditable on Backspace for already-processed chip
    existingDraftChip.setAttribute('contenteditable', 'true');
    doc.flushMutations();
    existingDraftChip.setAttribute('contenteditable', 'false');
    doc.flushMutations();
    await flushMacrotask();
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);
  });

  it('executes the compiled dist/content.js IIFE bundle cleanly on https://mail.google.com and ignores non-Gmail origins', async () => {
    const bundlePath = path.resolve(__dirname, '../dist/content.js');
    expect(fs.existsSync(bundlePath)).toBe(true);
    const bundleSource = fs.readFileSync(bundlePath, 'utf8');

    // Non-Gmail origin must not attach marker attribute
    const nonGmailDoc = new FakeDocument();
    vm.runInNewContext(bundleSource, {
      window: { location: { origin: 'https://docs.google.com' } },
      document: nonGmailDoc,
      MutationObserver: (globalThis as Record<string, unknown>)['MutationObserver'],
      setTimeout,
      clearTimeout,
      requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    });
    expect(
      nonGmailDoc.documentElement.getAttribute('data-gmail-attention-loaded')
    ).toBeNull();

    // Gmail origin attaches marker attribute and monitors @mentions end-to-end
    const gmailDoc = new FakeDocument();
    const restoreGmailGlobals = installFakeDomGlobals(gmailDoc);
    try {
      const { composeBody } = createComposeFixture(gmailDoc);
      vm.runInNewContext(bundleSource, {
        window: { location: { origin: 'https://mail.google.com' } },
        document: gmailDoc,
        MutationObserver: (globalThis as Record<string, unknown>)['MutationObserver'],
        setTimeout,
        clearTimeout,
        requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
      });

      expect(
        gmailDoc.documentElement.getAttribute('data-gmail-attention-loaded')
      ).toBe('true');

      const chip = gmailDoc.createElement('a');
      chip.className = 'gmail_plusreply';
      chip.textContent = '@frank';
      composeBody.appendChild(chip);
      gmailDoc.flushMutations();

      chip.textContent = '@Frank Ocean';
      chip.setAttribute('href', 'mailto:frank@example.com');
      chip.setAttribute('email', 'frank@example.com');
      chip.setAttribute('contenteditable', 'false');
      gmailDoc.flushMutations();
      await flushMacrotask();

      const { dialog, host } = getModalHostAndShadow(gmailDoc);
      expect(dialog?.open).toBe(true);
      expect(gmailDoc.activeElement).toBe(host);
    } finally {
      restoreGmailGlobals();
    }
  });

  it('seeds compose bodies when Gmail sets g_editable="true" via attribute mutation and handles AltGr @ keystrokes', async () => {
    monitor.start();

    // Gmail first mounts the editor div without g_editable/contenteditable, containing a draft chip
    const delayedEditor = doc.createElement('div');
    delayedEditor.className = 'Am Al editable';
    delayedEditor.setAttribute('aria-label', 'Message Body');
    const draftChip = doc.createElement('a');
    draftChip.className = 'gmail_plusreply';
    draftChip.textContent = '@Pre-existing Draft';
    draftChip.setAttribute('href', 'mailto:draft@example.com');
    draftChip.setAttribute('email', 'draft@example.com');
    draftChip.setAttribute('contenteditable', 'false');
    delayedEditor.appendChild(draftChip);
    doc.body.appendChild(delayedEditor);
    doc.flushMutations();

    // BaseEditorWidget.makeFieldEditable sets g_editable="true" and contenteditable="true" via attribute mutations
    delayedEditor.setAttribute('g_editable', 'true');
    delayedEditor.setAttribute('contenteditable', 'true');
    doc.flushMutations();
    await flushMacrotask();

    // Draft chip was seeded on attribute mutation and must not trigger a false positive
    expect(monitor.getUnconfirmedRecipients()).toHaveLength(0);
    expect(monitor.getComposeBodyCount()).toBe(1);

    // User types '@' via AltGr (ctrlKey: true, altKey: true) on an international keyboard
    delayedEditor.dispatchEvent(
      new FakeEvent('keydown', { key: '@', ctrlKey: true, altKey: true })
    );
    const closedChip = doc.createElement('a');
    closedChip.className = 'gmail_plusreply';
    closedChip.textContent = '@Intl User';
    closedChip.setAttribute('href', 'mailto:intl@example.com');
    closedChip.setAttribute('email', 'intl@example.com');
    closedChip.setAttribute('contenteditable', 'false');
    delayedEditor.appendChild(closedChip);
    doc.flushMutations();
    await flushMacrotask();

    expect(monitor.getUnconfirmedRecipients()).toHaveLength(1);
    expect(monitor.getUnconfirmedRecipients()[0]?.displayLabel).toBe('Intl User');
  });

  it('supports about:blank child frames, responds to GMAIL_ATTENTION_PING, and computes diagnostic popup states', () => {
    const parentWin = {
      location: { origin: 'https://mail.google.com', href: 'https://mail.google.com/mail/u/0/' },
    } as unknown as Window;
    const childBlankWin = {
      location: { origin: 'null', href: 'about:blank' },
      parent: parentWin,
      top: parentWin,
    } as unknown as Window;

    expect(isVerifiedGmailWindow(parentWin)).toBe(true);
    expect(isVerifiedGmailWindow(childBlankWin)).toBe(true);

    // Register GMAIL_ATTENTION_PING listener in top frame
    let registeredListener:
      | ((
          msg: unknown,
          sender: unknown,
          sendResponse: (res: GmailAttentionStatusResponseInterface) => void
        ) => void)
      | null = null;
    (globalThis as Record<string, unknown>)['chrome'] = {
      runtime: {
        onMessage: {
          addListener: (cb: typeof registeredListener) => {
            registeredListener = cb;
          },
        },
      },
    };

    try {
      createComposeFixture(doc);
      const topWin = {
        location: { origin: 'https://mail.google.com' },
      } as unknown as Window;
      (topWin as unknown as { top: Window }).top = topWin;

      const booted = bootstrapGmailAttention(topWin, doc as unknown as Document);
      expect(booted).not.toBeNull();
      expect(registeredListener).not.toBeNull();

      let pingResult: GmailAttentionStatusResponseInterface | null = null;
      registeredListener!(
        { type: 'GMAIL_ATTENTION_PING' },
        {},
        (res) => {
          pingResult = res;
        }
      );
      expect(pingResult).toEqual({
        active: true,
        composeBodyCount: 1,
        unconfirmedCount: 0,
      });
      booted?.stop();
    } finally {
      delete (globalThis as Record<string, unknown>)['chrome'];
    }

    // Verify popup diagnostic states
    expect(
      computePopupViewState({
        pingResponse: { active: true, composeBodyCount: 2, unconfirmedCount: 0 },
        tabUrl: 'https://mail.google.com/mail/u/0/#inbox',
        hasGmailHostPermission: true,
      }).pillText
    ).toBe('Active');

    expect(
      computePopupViewState({
        pingResponse: null,
        tabUrl: 'https://mail.google.com/mail/u/0/#inbox',
        hasGmailHostPermission: true,
      }).pillText
    ).toBe('Needs Reload');

    expect(
      computePopupViewState({
        pingResponse: null,
        tabUrl: undefined,
        hasGmailHostPermission: false,
      }).pillText
    ).toBe('Site Access Off');

    expect(
      computePopupViewState({
        pingResponse: null,
        tabUrl: 'https://github.com/etiennenoel/gmail-attention',
        hasGmailHostPermission: true,
      }).pillText
    ).toBe('Standby');
  });
});
