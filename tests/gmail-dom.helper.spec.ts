import { GmailDomHelper } from '../src/utils/gmail-dom.helper';
import { FakeDocument } from './fake-dom.helper';

describe('GmailDomHelper', () => {
  it('identifies Gmail compose message bodies while excluding Gemini "Describe your message" prompts', () => {
    const doc = new FakeDocument();
    const dialog = doc.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.className = 'M9';

    const composeBody = doc.createElement('div');
    composeBody.setAttribute('contenteditable', 'true');
    composeBody.setAttribute('role', 'textbox');
    composeBody.setAttribute('aria-label', 'Message Body');
    composeBody.setAttribute('g_editable', 'true');

    const geminiPrompt = doc.createElement('div');
    geminiPrompt.setAttribute('contenteditable', 'true');
    geminiPrompt.setAttribute('role', 'textbox');
    geminiPrompt.setAttribute('aria-label', 'Describe your message');

    const toField = doc.createElement('div');
    toField.setAttribute('contenteditable', 'true');
    toField.setAttribute('role', 'textbox');
    toField.setAttribute('aria-label', 'To recipients');

    dialog.appendChild(composeBody);
    dialog.appendChild(geminiPrompt);
    dialog.appendChild(toField);
    doc.body.appendChild(dialog);

    const found = GmailDomHelper.findComposeBodies(doc as unknown as ParentNode);
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(composeBody);
  });

  it('excludes mention chips inside .gmail_quote or blockquote history', () => {
    const doc = new FakeDocument();
    const composeBody = doc.createElement('div');
    composeBody.setAttribute('g_editable', 'true');
    composeBody.setAttribute('contenteditable', 'true');

    const activeChip = doc.createElement('a');
    activeChip.className = 'gmail_plusreply';
    activeChip.setAttribute('href', 'mailto:active@example.com');
    activeChip.setAttribute('email', 'active@example.com');
    activeChip.setAttribute('contenteditable', 'false');
    activeChip.textContent = '@Active Person';

    const quote = doc.createElement('div');
    quote.className = 'gmail_quote';
    const quotedChip = doc.createElement('a');
    quotedChip.className = 'gmail_plusreply';
    quotedChip.setAttribute('href', 'mailto:quoted@example.com');
    quotedChip.setAttribute('email', 'quoted@example.com');
    quotedChip.setAttribute('contenteditable', 'false');
    quotedChip.textContent = '@Quoted Person';
    quote.appendChild(quotedChip);

    composeBody.appendChild(activeChip);
    composeBody.appendChild(quote);
    doc.body.appendChild(composeBody);

    const chips = GmailDomHelper.findMentionChipsInSubtree(
      composeBody as unknown as Node,
      composeBody as unknown as HTMLElement
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]).toBe(activeChip);
  });

  it('distinguishes open @mention chips from closed autocomplete-selected chips', () => {
    const doc = new FakeDocument();
    const chip = doc.createElement('a');
    chip.className = 'gmail_plusreply';
    chip.id = 'plusReplyChip-0';
    chip.textContent = '@ali';

    expect(GmailDomHelper.isMentionChip(chip as unknown as Node)).toBe(true);
    expect(GmailDomHelper.hasAtTriggerPrefix(chip as unknown as Element)).toBe(true);
    expect(GmailDomHelper.isClosedMentionChip(chip as unknown as Element)).toBe(false);

    // Simulate Gmail PlusMentionChip.setContent() + close()
    chip.textContent = '@Alice Smith';
    chip.setAttribute('href', 'mailto:alice@example.com');
    chip.setAttribute('email', 'alice@example.com');
    chip.setAttribute('contenteditable', 'false');
    chip.setAttribute('tabindex', '-1');

    expect(GmailDomHelper.isClosedMentionChip(chip as unknown as Element)).toBe(true);
  });

  it('resolves Send button clicks to the matching compose body while ignoring "More send options"', () => {
    const doc = new FakeDocument();
    const composeContainer = doc.createElement('div');
    composeContainer.className = 'M9';

    const composeBody = doc.createElement('div');
    composeBody.setAttribute('g_editable', 'true');
    composeBody.setAttribute('contenteditable', 'true');

    const sendButton = doc.createElement('div');
    sendButton.className = 'T-I J-J5-Ji aoO v7 T-I-atl L3';
    sendButton.setAttribute('role', 'button');
    sendButton.setAttribute('data-tooltip', 'Send ‪(⌘Enter)‬');
    const sendLabel = doc.createElement('span');
    sendLabel.textContent = 'Send';
    sendButton.appendChild(sendLabel);

    const dropdownButton = doc.createElement('div');
    dropdownButton.setAttribute('role', 'button');
    dropdownButton.setAttribute('aria-label', 'More send options');

    composeContainer.appendChild(composeBody);
    composeContainer.appendChild(sendButton);
    composeContainer.appendChild(dropdownButton);
    doc.body.appendChild(composeContainer);

    const matchedSend = GmailDomHelper.findSendButtonFromTarget(
      sendLabel as unknown as EventTarget
    );
    expect(matchedSend).toBe(sendButton);
    expect(
      GmailDomHelper.findMessageBodyFromSendButton(matchedSend as unknown as Element)
    ).toBe(composeBody);

    expect(
      GmailDomHelper.findSendButtonFromTarget(dropdownButton as unknown as EventTarget)
    ).toBeNull();
  });

  it('detaches a closed @mention link from PlusMentionPlugin ID tracking while keeping the link in place and firing input', () => {
    const doc = new FakeDocument();
    const composeBody = doc.createElement('div');
    composeBody.setAttribute('g_editable', 'true');
    composeBody.setAttribute('contenteditable', 'true');
    doc.body.appendChild(composeBody);

    const leadingText = doc.createTextNode('Hi ');
    const chip = doc.createElement('a');
    chip.id = 'plusReplyChip-3';
    chip.className = 'gmail_plusreply';
    chip.setAttribute('href', 'mailto:alice@example.com');
    chip.setAttribute('email', 'alice@example.com');
    chip.setAttribute('contenteditable', 'false');
    chip.setAttribute('tabindex', '-1');
    chip.textContent = '@Alice Smith';
    const trailingText = doc.createTextNode(', please take a look.');

    composeBody.appendChild(leadingText);
    composeBody.appendChild(chip);
    composeBody.appendChild(trailingText);

    let inputFiredCount = 0;
    composeBody.addEventListener('input', () => {
      inputFiredCount++;
    });

    let hookLink: unknown = null;
    const replacement = GmailDomHelper.detachMentionChipFromRecipientSync(
      chip as unknown as HTMLAnchorElement,
      composeBody as unknown as HTMLElement,
      (link) => {
        hookLink = link;
      }
    );

    expect(hookLink).toBe(replacement);
    expect(composeBody.childNodes[0]).toBe(leadingText);
    expect(composeBody.childNodes[1]).toBe(replacement);
    expect(composeBody.childNodes[2]).toBe(trailingText);
    expect(replacement.getAttribute('id')).toBeNull();
    expect(replacement.getAttribute('class')).toBe('gmail_plusreply');
    expect(replacement.getAttribute('href')).toBe('mailto:alice@example.com');
    expect(replacement.getAttribute('email')).toBe('alice@example.com');
    expect(replacement.getAttribute('contenteditable')).toBe('false');
    expect(replacement.getAttribute('tabindex')).toBe('-1');
    expect(replacement.textContent).toBe('@Alice Smith');
    expect(inputFiredCount).toBe(1);
  });

  it('removes only newly-added PeopleKit To chips while preserving pre-existing To chips and ignoring <textarea name="to">', () => {
    const doc = new FakeDocument();
    const container = doc.createElement('div');
    container.className = 'M9';
    container.setAttribute('role', 'dialog');

    // Legacy hidden <textarea name="to"> alongside PeopleKit To container
    const legacyTextarea = doc.createElement('textarea');
    legacyTextarea.setAttribute('name', 'to');

    const toField = doc.createElement('div');
    toField.setAttribute('name', 'to');
    toField.setAttribute('aria-label', 'To recipients');

    const makeToChip = (id: string, email: string) => {
      const chip = doc.createElement('div');
      chip.id = id;
      chip.setAttribute('role', 'option');
      chip.setAttribute('data-hovercard-id', email);
      chip.setAttribute('aria-describedby', `${id}-db`);
      const deleteBtn = doc.createElement('div');
      deleteBtn.id = `${id}-db`;
      deleteBtn.setAttribute('aria-label', 'Press delete to remove this chip');
      deleteBtn.addEventListener('click', () => {
        chip.remove();
      });
      chip.appendChild(deleteBtn);
      toField.appendChild(chip);
      return chip;
    };

    const preExistingAlice = makeToChip('pk-existing-alice', 'alice@example.com');
    const preExistingBob = makeToChip('pk-existing-bob', 'bob@example.com');

    const composeBody = doc.createElement('div');
    composeBody.setAttribute('g_editable', 'true');
    composeBody.setAttribute('contenteditable', 'true');

    container.appendChild(legacyTextarea);
    container.appendChild(toField);
    container.appendChild(composeBody);
    doc.body.appendChild(container);

    const snapshot = GmailDomHelper.snapshotToRecipientChips(
      composeBody as unknown as HTMLElement
    );
    expect(snapshot.has(preExistingAlice as unknown as Element)).toBe(true);
    expect(snapshot.has(preExistingBob as unknown as Element)).toBe(true);

    // Pre-existing Alice must NOT be removed if no new Alice chip was added
    const removedExisting = GmailDomHelper.removeNewlyAddedToRecipientChip(
      composeBody as unknown as HTMLElement,
      'ALICE@example.com',
      snapshot
    );
    expect(removedExisting).toBe(false);
    expect(preExistingAlice.isConnected).toBe(true);

    // Newly added Carol chip IS removed while pre-existing Alice & Bob remain
    const newCarol = makeToChip('pk-new-carol', 'carol@example.com');
    const removedCarol = GmailDomHelper.removeNewlyAddedToRecipientChip(
      composeBody as unknown as HTMLElement,
      'Carol@example.com',
      snapshot
    );
    expect(removedCarol).toBe(true);
    expect(newCarol.isConnected).toBe(false);
    expect(preExistingAlice.isConnected).toBe(true);
    expect(preExistingBob.isConnected).toBe(true);
  });
});
