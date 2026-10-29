type ListenerRecord = {
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
};

type ObserverRegistration = {
  callback: MutationCallback;
  target: FakeNode;
  options: MutationObserverInit;
};

/**
 * Lightweight, deterministic DOM + Shadow DOM + `<dialog>` + `MutationObserver`
 * test harness for running Chrome extension content-script unit and integration
 * tests in Node (`jest-environment-node`) without external browser dependencies.
 */
export class FakeEvent {
  public readonly type: string;
  public readonly bubbles: boolean;
  public readonly cancelable: boolean;
  public target: FakeNode | null = null;
  public currentTarget: FakeNode | null = null;
  public defaultPrevented = false;
  public propagationStopped = false;
  public immediatePropagationStopped = false;

  public key = '';
  public ctrlKey = false;
  public metaKey = false;
  public altKey = false;
  public shiftKey = false;
  public repeat = false;
  public detail = 0;
  public data: string | null = null;

  public constructor(
    type: string,
    init: {
      bubbles?: boolean;
      cancelable?: boolean;
      key?: string;
      ctrlKey?: boolean;
      metaKey?: boolean;
      altKey?: boolean;
      shiftKey?: boolean;
      repeat?: boolean;
      detail?: number;
      data?: string | null;
    } = {}
  ) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.cancelable = init.cancelable ?? true;
    this.key = init.key ?? '';
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.altKey = init.altKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.repeat = init.repeat ?? false;
    this.detail = init.detail ?? 0;
    this.data = init.data ?? null;
  }

  public preventDefault(): void {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }

  public stopPropagation(): void {
    this.propagationStopped = true;
  }

  public stopImmediatePropagation(): void {
    this.immediatePropagationStopped = true;
    this.propagationStopped = true;
  }
}

export class FakeNode {
  public readonly nodeType: number;
  public parentNode: FakeNode | null = null;
  public childNodes: FakeNode[] = [];
  public ownerDocument: FakeDocument | null = null;
  private readonly listeners = new Map<string, ListenerRecord[]>();
  protected rawTextValue = '';

  public constructor(nodeType: number, ownerDocument: FakeDocument | null) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
  }

  public get parentElement(): FakeElement | null {
    return this.parentNode && this.parentNode.nodeType === 1
      ? (this.parentNode as FakeElement)
      : null;
  }

  public get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  public get nextSibling(): FakeNode | null {
    if (!this.parentNode) {
      return null;
    }
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null;
  }

  public get isConnected(): boolean {
    let cur: FakeNode | null = this;
    while (cur) {
      if (cur === this.ownerDocument || cur === this.ownerDocument?.documentElement) {
        return true;
      }
      if (cur instanceof FakeShadowRoot && cur.host.isConnected) {
        return true;
      }
      cur = cur.parentNode;
    }
    return false;
  }

  public get textContent(): string {
    if (this.nodeType === 3) {
      return this.rawTextValue;
    }
    return this.childNodes.map((c) => c.textContent).join('');
  }

  public set textContent(value: string) {
    if (this.nodeType === 3) {
      this.rawTextValue = value;
      return;
    }
    const removed = [...this.childNodes];
    for (const child of removed) {
      child.parentNode = null;
    }
    this.childNodes = [];
    const added: FakeNode[] = [];
    if (value.length > 0 && this.ownerDocument) {
      const textNode = this.ownerDocument.createTextNode(value);
      textNode.parentNode = this;
      this.childNodes.push(textNode);
      added.push(textNode);
    }
    this.ownerDocument?.recordMutation({
      type: 'childList',
      target: this,
      addedNodes: added,
      removedNodes: removed,
      attributeName: null,
    });
  }

  public appendChild<T extends FakeNode>(child: T): T {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    this.ownerDocument?.recordMutation({
      type: 'childList',
      target: this,
      addedNodes: [child],
      removedNodes: [],
      attributeName: null,
    });
    return child;
  }

  public removeChild<T extends FakeNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx === -1) {
      throw new Error('Node to be removed is not a child of this node');
    }
    this.childNodes.splice(idx, 1);
    child.parentNode = null;
    this.ownerDocument?.recordMutation({
      type: 'childList',
      target: this,
      addedNodes: [],
      removedNodes: [child],
      attributeName: null,
    });
    return child;
  }

  public replaceChild<T extends FakeNode>(newChild: FakeNode, oldChild: T): T {
    if (!this.childNodes.includes(oldChild)) {
      throw new Error('Node to be replaced is not a child of this node');
    }
    if (newChild === oldChild) {
      return oldChild;
    }
    if (newChild.parentNode) {
      newChild.parentNode.removeChild(newChild);
    }
    const targetIdx = this.childNodes.indexOf(oldChild);
    this.childNodes.splice(targetIdx, 1, newChild);
    oldChild.parentNode = null;
    newChild.parentNode = this;
    this.ownerDocument?.recordMutation({
      type: 'childList',
      target: this,
      addedNodes: [newChild],
      removedNodes: [oldChild],
      attributeName: null,
    });
    return oldChild;
  }

  public replaceChildren(...nodes: FakeNode[]): void {
    const removed = [...this.childNodes];
    for (const r of removed) {
      r.parentNode = null;
    }
    this.childNodes = [];
    for (const n of nodes) {
      if (n.parentNode) {
        n.parentNode.removeChild(n);
      }
      n.parentNode = this;
      this.childNodes.push(n);
    }
    this.ownerDocument?.recordMutation({
      type: 'childList',
      target: this,
      addedNodes: nodes,
      removedNodes: removed,
      attributeName: null,
    });
  }

  public contains(other: FakeNode | null): boolean {
    let cur: FakeNode | null = other;
    while (cur) {
      if (cur === this) {
        return true;
      }
      cur = cur.parentNode;
    }
    return false;
  }

  public addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const list = this.listeners.get(type) ?? [];
    if (!list.some((item) => item.listener === listener && item.capture === capture)) {
      list.push({ listener, capture });
      this.listeners.set(type, list);
    }
  }

  public removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const list = this.listeners.get(type);
    if (!list) {
      return;
    }
    this.listeners.set(
      type,
      list.filter((item) => !(item.listener === listener && item.capture === capture))
    );
  }

  public dispatchEvent(rawEvent: FakeEvent | Event): boolean {
    const event =
      rawEvent instanceof FakeEvent
        ? rawEvent
        : new FakeEvent(rawEvent.type, {
            bubbles: rawEvent.bubbles,
            cancelable: rawEvent.cancelable,
          });
    // Build propagation path (crossing ShadowRoot -> host with retargeting at document boundary)
    const path: FakeNode[] = [];
    let cur: FakeNode | null = this;
    while (cur) {
      path.push(cur);
      if (cur instanceof FakeShadowRoot) {
        cur = cur.host;
      } else {
        cur = cur.parentNode;
      }
    }
    if (this.ownerDocument && path[path.length - 1] !== this.ownerDocument) {
      path.push(this.ownerDocument);
    }

    const computeRetargeted = (observerNode: FakeNode): FakeNode => {
      // If `this` is inside a ShadowRoot and `observerNode` is outside that ShadowRoot,
      // retarget `event.target` to the ShadowRoot's host (matching browser Shadow DOM spec).
      let check: FakeNode | null = this;
      while (check) {
        if (check instanceof FakeShadowRoot && !check.contains(observerNode)) {
          return check.host;
        }
        check = check.parentNode;
      }
      return this;
    };

    // Capture phase (top -> down, excluding target)
    for (let i = path.length - 1; i > 0; i--) {
      if (event.propagationStopped) {
        break;
      }
      const node = path[i]!;
      event.target = computeRetargeted(node);
      node.invokeListeners(event, true);
    }

    // Target phase
    if (!event.propagationStopped) {
      event.target = this;
      this.invokeListeners(event, true);
      if (!event.immediatePropagationStopped) {
        this.invokeListeners(event, false);
      }
    }

    // Bubble phase
    if (event.bubbles) {
      for (let i = 1; i < path.length; i++) {
        if (event.propagationStopped) {
          break;
        }
        const node = path[i]!;
        event.target = computeRetargeted(node);
        node.invokeListeners(event, false);
      }
    }

    event.target = computeRetargeted(this.ownerDocument ?? this);
    return !event.defaultPrevented;
  }

  private invokeListeners(event: FakeEvent, capturePhase: boolean): void {
    const list = [...(this.listeners.get(event.type) ?? [])];
    event.currentTarget = this;
    for (const entry of list) {
      if (entry.capture !== capturePhase) {
        continue;
      }
      if (typeof entry.listener === 'function') {
        entry.listener.call(this, event as unknown as Event);
      } else {
        entry.listener.handleEvent(event as unknown as Event);
      }
      if (event.immediatePropagationStopped) {
        break;
      }
    }
  }
}

export class FakeTextNode extends FakeNode {
  public constructor(text: string, ownerDocument: FakeDocument) {
    super(3, ownerDocument);
    this.rawTextValue = text;
  }
}

export class FakeClassList {
  private readonly element: FakeElement;

  public constructor(element: FakeElement) {
    this.element = element;
  }

  private getTokens(): string[] {
    return (this.element.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((t) => t.length > 0);
  }

  public contains(token: string): boolean {
    return this.getTokens().includes(token);
  }

  public add(...tokens: string[]): void {
    const set = new Set(this.getTokens());
    for (const t of tokens) {
      set.add(t);
    }
    this.element.setAttribute('class', Array.from(set).join(' '));
  }

  public remove(...tokens: string[]): void {
    const removeSet = new Set(tokens);
    const next = this.getTokens().filter((t) => !removeSet.has(t));
    this.element.setAttribute('class', next.join(' '));
  }
}

export class FakeShadowRoot extends FakeNode {
  public readonly host: FakeElement;
  public readonly mode: 'open' | 'closed';
  public activeElement: FakeElement | null = null;

  public constructor(host: FakeElement, mode: 'open' | 'closed', doc: FakeDocument) {
    super(11, doc);
    this.host = host;
    this.mode = mode;
  }

  public querySelector(selector: string): FakeElement | null {
    return querySelectorAllWithin(this, selector)[0] ?? null;
  }

  public querySelectorAll(selector: string): FakeElement[] {
    return querySelectorAllWithin(this, selector);
  }
}

export class FakeElement extends FakeNode {
  public readonly tagName: string;
  public readonly classList: FakeClassList;
  public hidden = false;
  public type = '';
  public open = false;
  public offsetWidth = 320;
  /** Test-only handle to inspect closed ShadowRoots during unit tests. */
  public testShadowRoot: FakeShadowRoot | null = null;

  private readonly attributes = new Map<string, string>();

  public constructor(tagName: string, ownerDocument: FakeDocument) {
    super(1, ownerDocument);
    this.tagName = tagName.toUpperCase();
    this.classList = new FakeClassList(this);
  }

  public get id(): string {
    return this.attributes.get('id') ?? '';
  }

  public set id(val: string) {
    this.setAttribute('id', val);
  }

  public get className(): string {
    return this.attributes.get('class') ?? '';
  }

  public set className(val: string) {
    this.setAttribute('class', val);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  public hasAttribute(name: string): boolean {
    return this.attributes.has(name.toLowerCase());
  }

  public setAttribute(name: string, value: string): void {
    const key = name.toLowerCase();
    this.attributes.set(key, String(value));
    if (key === 'open') {
      this.open = true;
    }
    this.ownerDocument?.recordMutation({
      type: 'attributes',
      target: this,
      addedNodes: [],
      removedNodes: [],
      attributeName: key,
    });
  }

  public removeAttribute(name: string): void {
    const key = name.toLowerCase();
    this.attributes.delete(key);
    if (key === 'open') {
      this.open = false;
    }
    this.ownerDocument?.recordMutation({
      type: 'attributes',
      target: this,
      addedNodes: [],
      removedNodes: [],
      attributeName: key,
    });
  }

  public attachShadow(init: { mode: 'open' | 'closed' }): FakeShadowRoot {
    const shadow = new FakeShadowRoot(this, init.mode, this.ownerDocument!);
    this.testShadowRoot = shadow;
    return shadow;
  }

  public showModal(): void {
    this.open = true;
    this.setAttribute('open', '');
    const autofocusEl = this.querySelector('[autofocus]');
    const firstButton = this.querySelector('button');
    (autofocusEl ?? firstButton)?.focus();
  }

  public close(): void {
    this.open = false;
    this.removeAttribute('open');
  }

  public focus(): void {
    if (!this.ownerDocument) {
      return;
    }
    // Check if inside a ShadowRoot
    let cur: FakeNode | null = this.parentNode;
    let enclosingShadow: FakeShadowRoot | null = null;
    while (cur) {
      if (cur instanceof FakeShadowRoot) {
        enclosingShadow = cur;
        break;
      }
      cur = cur.parentNode;
    }

    if (enclosingShadow) {
      enclosingShadow.activeElement = this;
      this.ownerDocument.activeElement = enclosingShadow.host;
    } else {
      for (const sr of this.ownerDocument.allShadowRoots) {
        sr.activeElement = null;
      }
      this.ownerDocument.activeElement = this;
    }

    this.dispatchEvent(new FakeEvent('focusin', { bubbles: true, cancelable: false }));
  }

  public blur(): void {
    if (!this.ownerDocument) {
      return;
    }
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }

  public click(): void {
    this.dispatchEvent(
      new FakeEvent('click', { bubbles: true, cancelable: true, detail: 1 })
    );
  }

  public remove(): void {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  public matches(selector: string): boolean {
    return matchesSelectorList(this, selector);
  }

  public closest(selector: string): FakeElement | null {
    let cur: FakeElement | null = this;
    while (cur) {
      if (matchesSelectorList(cur, selector)) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  public querySelector(selector: string): FakeElement | null {
    return querySelectorAllWithin(this, selector)[0] ?? null;
  }

  public querySelectorAll(selector: string): FakeElement[] {
    return querySelectorAllWithin(this, selector);
  }
}

export class FakeDocument extends FakeNode {
  public readonly documentElement: FakeElement;
  public readonly body: FakeElement;
  public activeElement: FakeElement | null = null;
  public defaultView: unknown = null;
  public readonly allShadowRoots: FakeShadowRoot[] = [];

  private readonly observers = new Set<ObserverRegistration>();
  private queuedRecords = new Map<
    ObserverRegistration,
    Array<{
      type: 'childList' | 'attributes';
      target: FakeNode;
      addedNodes: FakeNode[];
      removedNodes: FakeNode[];
      attributeName: string | null;
    }>
  >();

  public constructor() {
    super(9, null);
    this.ownerDocument = this;
    this.documentElement = new FakeElement('html', this);
    this.documentElement.parentNode = this;
    this.childNodes.push(this.documentElement);

    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.defaultView = {
      Event: FakeEvent,
      MouseEvent: FakeEvent,
    };
  }

  public createElement(tagName: string): FakeElement {
    const el = new FakeElement(tagName, this);
    const origAttach = el.attachShadow.bind(el);
    el.attachShadow = (init: { mode: 'open' | 'closed' }) => {
      const sr = origAttach(init);
      this.allShadowRoots.push(sr);
      return sr;
    };
    return el;
  }

  public createElementNS(_ns: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  public createTextNode(text: string): FakeTextNode {
    return new FakeTextNode(text, this);
  }

  public createRange(): {
    startContainer: FakeNode | null;
    endContainer: FakeNode | null;
    commonAncestorContainer: FakeNode | null;
    setStart: (node: FakeNode, offset: number) => void;
    setStartAfter: (node: FakeNode) => void;
    collapse: () => void;
    cloneRange: () => unknown;
  } {
    const rangeObj = {
      startContainer: null as FakeNode | null,
      endContainer: null as FakeNode | null,
      commonAncestorContainer: null as FakeNode | null,
      setStart(node: FakeNode) {
        this.startContainer = node;
        this.endContainer = node;
        this.commonAncestorContainer = node;
      },
      setStartAfter(node: FakeNode) {
        this.startContainer = node.parentNode ?? node;
        this.endContainer = node.parentNode ?? node;
        this.commonAncestorContainer = node.parentNode ?? node;
      },
      collapse() {
        // no-op
      },
      cloneRange() {
        return { ...this };
      },
    };
    return rangeObj;
  }

  public querySelector(selector: string): FakeElement | null {
    return querySelectorAllWithin(this.documentElement, selector)[0] ?? null;
  }

  public querySelectorAll(selector: string): FakeElement[] {
    return querySelectorAllWithin(this.documentElement, selector);
  }

  public registerObserver(reg: ObserverRegistration): void {
    this.observers.add(reg);
  }

  public unregisterObserver(reg: ObserverRegistration): void {
    this.observers.delete(reg);
    this.queuedRecords.delete(reg);
  }

  public recordMutation(record: {
    type: 'childList' | 'attributes';
    target: FakeNode;
    addedNodes: FakeNode[];
    removedNodes: FakeNode[];
    attributeName: string | null;
  }): void {
    for (const reg of this.observers) {
      const inScope =
        reg.target === record.target ||
        (Boolean(reg.options.subtree) && reg.target.contains(record.target));
      if (!inScope) {
        continue;
      }
      if (record.type === 'childList' && !reg.options.childList) {
        continue;
      }
      if (record.type === 'attributes') {
        if (!reg.options.attributes) {
          continue;
        }
        if (
          reg.options.attributeFilter &&
          record.attributeName &&
          !reg.options.attributeFilter.includes(record.attributeName)
        ) {
          continue;
        }
      }
      const list = this.queuedRecords.get(reg) ?? [];
      list.push(record);
      this.queuedRecords.set(reg, list);
    }
  }

  /**
   * Flushes all queued `MutationObserver` records synchronously in tests.
   */
  public flushMutations(): void {
    const snapshot = Array.from(this.queuedRecords.entries());
    this.queuedRecords.clear();
    for (const [reg, records] of snapshot) {
      if (records.length > 0 && this.observers.has(reg)) {
        reg.callback(
          records as unknown as MutationRecord[],
          reg as unknown as MutationObserver
        );
      }
    }
  }
}

function querySelectorAllWithin(root: FakeNode, selectorList: string): FakeElement[] {
  const results: FakeElement[] = [];
  const visit = (node: FakeNode): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === 1) {
        const el = child as FakeElement;
        if (matchesSelectorList(el, selectorList)) {
          results.push(el);
        }
        visit(el);
      }
    }
  };
  visit(root);
  return results;
}

function matchesSelectorList(element: FakeElement, selectorList: string): boolean {
  const selectors = splitTopLevelCommas(selectorList);
  return selectors.some((sel) => matchesCompoundSelector(element, sel.trim()));
}

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && ch === '[') {
      depth++;
    } else if (!inQuotes && ch === ']') {
      depth--;
    } else if (!inQuotes && depth === 0 && ch === ',') {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function matchesCompoundSelector(element: FakeElement, selector: string): boolean {
  if (!selector) {
    return false;
  }

  let cursor = selector;
  const attrChecks: Array<{ name: string; op: '=' | '^=' | null; val: string }> = [];

  cursor = cursor.replace(
    /\[\s*([a-zA-Z0-9_-]+)(?:\s*(\^?=)\s*"([^"]*)")?\s*\]/g,
    (_m, name: string, op: '=' | '^=' | undefined, val: string | undefined) => {
      attrChecks.push({ name: name.toLowerCase(), op: op ?? null, val: val ?? '' });
      return '';
    }
  );

  let idCheck: string | null = null;
  cursor = cursor.replace(/#([a-zA-Z0-9_-]+)/g, (_m, idVal: string) => {
    idCheck = idVal;
    return '';
  });

  const classes: string[] = [];
  cursor = cursor.replace(/\.([a-zA-Z0-9_-]+)/g, (_m, cls: string) => {
    classes.push(cls);
    return '';
  });

  const tag = cursor.trim();
  if (tag.length > 0 && tag !== '*' && element.tagName !== tag.toUpperCase()) {
    return false;
  }

  if (idCheck !== null && element.id !== idCheck) {
    return false;
  }

  for (const cls of classes) {
    if (!element.classList.contains(cls)) {
      return false;
    }
  }

  for (const attr of attrChecks) {
    const actual = element.getAttribute(attr.name);
    if (attr.op === null) {
      if (actual === null) {
        return false;
      }
    } else if (attr.op === '=') {
      if (actual !== attr.val) {
        return false;
      }
    } else if (attr.op === '^=') {
      if (actual === null || !actual.startsWith(attr.val)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Installs a `MutationObserver` shim tied to `doc` onto `globalThis` for tests
 * and returns a restore callback.
 */
export function installFakeDomGlobals(doc: FakeDocument): () => void {
  const g = globalThis as Record<string, unknown>;
  const prevMutationObserver = g['MutationObserver'];
  const prevRequestAnimationFrame = g['requestAnimationFrame'];

  class FakeMutationObserver {
    private readonly callback: MutationCallback;
    private registration: ObserverRegistration | null = null;

    public constructor(callback: MutationCallback) {
      this.callback = callback;
    }

    public observe(target: Node, options?: MutationObserverInit): void {
      this.disconnect();
      this.registration = {
        callback: this.callback,
        target: target as unknown as FakeNode,
        options: options ?? {},
      };
      doc.registerObserver(this.registration);
    }

    public disconnect(): void {
      if (this.registration) {
        doc.unregisterObserver(this.registration);
        this.registration = null;
      }
    }

    public takeRecords(): MutationRecord[] {
      return [];
    }
  }

  g['MutationObserver'] = FakeMutationObserver;
  g['requestAnimationFrame'] = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0);

  return () => {
    g['MutationObserver'] = prevMutationObserver;
    g['requestAnimationFrame'] = prevRequestAnimationFrame;
  };
}
