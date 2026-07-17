const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '../public/virtual-list.js');

function loadApi() {
  assert.ok(fs.existsSync(MODULE_PATH), 'public/virtual-list.js must exist');
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const moduleValue = { exports: {} };
  const context = {
    module: moduleValue,
    exports: moduleValue.exports,
    Object,
    Array,
    String,
    Number,
    Math,
    Map,
    Set,
    TypeError,
    Error
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: MODULE_PATH });
  return moduleValue.exports;
}

class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(name, value) { this.values.set(name, String(value)); }
  getPropertyValue(name) { return this.values.get(name) || ''; }
  removeProperty(name) {
    const previous = this.getPropertyValue(name);
    this.values.delete(name);
    return previous;
  }
}

class FakeElement {
  constructor(document, tagName = 'div') {
    this.ownerDocument = document;
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = new FakeStyle();
    this.listeners = new Map();
    this.clientWidth = 0;
    this.clientHeight = 0;
    this._scrollTop = 0;
    this.naturalHeight = 0;
    this.fontSize = '16px';
    this.paddingLeft = '0px';
    this.paddingRight = '0px';
    this.borderLeftWidth = '0px';
    this.borderRightWidth = '0px';
    this.textContent = '';
    this.tabIndex = -1;
  }
  get offsetHeight() {
    const height = Number.parseFloat(this.style.getPropertyValue('height')) || 0;
    const minHeight = Number.parseFloat(this.style.getPropertyValue('min-height')) || 0;
    return Math.max(this.clientHeight, height, minHeight, this.naturalHeight);
  }
  get scrollHeight() {
    return this.children.reduce((maximum, child) => Math.max(maximum, child.offsetHeight), this.offsetHeight);
  }
  get scrollTop() { return this._scrollTop; }
  set scrollTop(value) {
    const maximum = Math.max(0, this.scrollHeight - this.clientHeight);
    const numeric = Number.isFinite(Number(value)) ? Number(value) : 0;
    this._scrollTop = Math.min(maximum, Math.max(0, numeric));
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'tabindex') this.tabIndex = Number(value);
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'tabindex') this.tabIndex = -1;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(candidate) {
    return candidate === this || this.children.some(child => child.contains(candidate));
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, values = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      key: '',
      relatedTarget: null,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...values
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }
  focus() {
    this.ownerDocument.activeElement = this;
    this.dispatch('focus', { target: this });
  }
  getBoundingClientRect() {
    return {
      width: this.clientWidth || Number.parseFloat(this.style.getPropertyValue('width')) || 0,
      height: this.clientHeight || this.offsetHeight,
      top: 0,
      left: 0
    };
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.defaultView = {
      getComputedStyle(element) {
        return {
          fontSize: element.fontSize,
          paddingLeft: element.paddingLeft,
          paddingRight: element.paddingRight,
          borderLeftWidth: element.borderLeftWidth,
          borderRightWidth: element.borderRightWidth
        };
      }
    };
  }
  createElement(tagName) { return new FakeElement(this, tagName); }
}

class FakeResizeObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.elements = new Set();
    this.disconnected = false;
    FakeResizeObserver.instances.push(this);
  }
  observe(element) { this.elements.add(element); }
  unobserve(element) { this.elements.delete(element); }
  disconnect() { this.disconnected = true; this.elements.clear(); }
  trigger(element) {
    if (this.disconnected) return;
    const targets = element ? [element] : [...this.elements];
    const entries = targets
      .filter(target => this.elements.has(target))
      .map(target => ({ target, contentRect: target.getBoundingClientRect() }));
    if (entries.length) this.callback(entries);
  }
}

function items(count, prefix = 'p') {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${String(index).padStart(3, '0')}`,
    label: `Player ${index}`
  }));
}

function makeHarness(options = {}) {
  FakeResizeObserver.instances.length = 0;
  const document = new FakeDocument();
  const container = document.createElement('div');
  container.clientWidth = options.width ?? 390;
  container.clientHeight = options.height ?? 600;
  container.fontSize = options.fontSize || '16px';
  container.paddingLeft = options.paddingLeft || '14px';
  container.paddingRight = options.paddingRight || '14px';
  const rendered = [];
  const activated = [];
  const api = loadApi();
  const createOptions = {
    container,
    ResizeObserver: FakeResizeObserver,
    key: item => item.id,
    renderItem(node, item, index) {
      rendered.push(item.id);
      node.naturalHeight = item.height || 0;
      node.textContent = `${item.label} · ${index}`;
      if (options.renderItem) options.renderItem(node, item, index);
    },
    onActivate(item, index, event) {
      activated.push({ id: item.id, index, type: event.type });
    }
  };
  if (Object.prototype.hasOwnProperty.call(options, 'columns')) createOptions.columns = options.columns;
  const list = api.create(createOptions);
  return { api, document, container, canvas: container.children[0], rendered, activated, list };
}

function optionNodes(harness) {
  return harness.canvas.children.filter(node => node.getAttribute('role') === 'option');
}

function activeNode(harness) {
  const id = harness.container.getAttribute('aria-activedescendant');
  return optionNodes(harness).find(node => node.getAttribute('id') === id) || null;
}

function translate(node) {
  const value = node.style.getPropertyValue('transform');
  const match = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(value);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

test('VirtualList exposes one frozen UMD API and validates required dependencies', () => {
  const api = loadApi();
  assert.deepEqual(Object.keys(api), ['create']);
  assert.equal(Object.isFrozen(api), true);
  assert.throws(() => api.create(), /container/i);
  const document = new FakeDocument();
  assert.throws(() => api.create({ container: document.createElement('div') }), /renderItem/i);
});

test('150 items render a bounded semantic two-column window and never paint off-screen cards', () => {
  const h = makeHarness();
  const roster = items(150);
  h.list.setItems(roster);

  const nodes = optionNodes(h);
  assert.equal(h.container.getAttribute('role'), 'listbox');
  assert.equal(h.container.getAttribute('tabindex'), '0');
  assert.ok(nodes.length <= 36, `typical 150-player DOM remains bounded: ${nodes.length}`);
  assert.ok(h.rendered.length <= 36, `only visible and overscan cards paint: ${h.rendered.length}`);
  assert.equal(h.rendered.includes('p120'), false, 'an off-screen item is not rendered');
  assert.equal(h.canvas.style.getPropertyValue('height'), `${Math.ceil(150 / 2) * 76}px`);

  const first = nodes.find(node => node.textContent.startsWith('Player 0'));
  const second = nodes.find(node => node.textContent.startsWith('Player 1'));
  assert.deepEqual(translate(first), { x: 0, y: 0 });
  assert.equal(translate(second).y, 0, 'the second option shares the first visual row');
  assert.ok(translate(second).x > 0, 'content width >=360px uses two columns');
  assert.equal(first.getAttribute('aria-posinset'), '1');
  assert.equal(first.getAttribute('aria-setsize'), '150');
  assert.equal(first.getAttribute('aria-selected'), 'false');

  const renderCount = h.rendered.length;
  const changed = roster.slice();
  changed[120] = { ...changed[120], label: 'Changed off screen' };
  h.list.setItems(changed);
  assert.equal(h.rendered.slice(renderCount).includes('p120'), false,
    'an off-screen delta does not trigger renderItem');
  assert.equal(h.list.scrollToKey('p120'), true);
  assert.ok(h.rendered.includes('p120'), 'scrolling the key into view renders it');
});

test('content width and text scale choose columns and a non-overlapping density row height', () => {
  const h = makeHarness({ width: 375, fontSize: '16px' });
  h.list.setItems(items(20));
  let nodes = optionNodes(h);
  let first = nodes.find(node => node.textContent.startsWith('Player 0'));
  let second = nodes.find(node => node.textContent.startsWith('Player 1'));
  assert.deepEqual(translate(first), { x: 0, y: 0 });
  assert.deepEqual(translate(second), { x: 0, y: 76 },
    '347px content box stays one column even though the viewport is 375px');

  h.container.clientWidth = 390;
  FakeResizeObserver.instances[0].trigger();
  nodes = optionNodes(h);
  first = nodes.find(node => node.textContent.startsWith('Player 0'));
  second = nodes.find(node => node.textContent.startsWith('Player 1'));
  assert.equal(translate(second).y, 0, '362px content box crosses the two-column threshold');

  h.container.fontSize = '32px';
  FakeResizeObserver.instances[0].trigger();
  nodes = optionNodes(h);
  first = nodes.find(node => node.textContent.startsWith('Player 0'));
  second = nodes.find(node => node.textContent.startsWith('Player 1'));
  assert.equal(first.style.getPropertyValue('min-height'), '126px');
  assert.deepEqual(translate(second), { x: 0, y: 126 },
    '200% text forces one column and the next card starts after the enlarged row');
  assert.equal(h.canvas.style.getPropertyValue('height'), `${20 * 126}px`);
});

test('measured content defines variable row offsets and the taller card wins in two columns', () => {
  const h = makeHarness({ height: 220 });
  h.list.setItems([
    { id: 'p000', label: 'Short left', height: 80 },
    { id: 'p001', label: 'Tall right', height: 150 },
    { id: 'p002', label: 'Next left', height: 90 },
    { id: 'p003', label: 'Next right', height: 84 },
    { id: 'p004', label: 'Last left', height: 200 },
    { id: 'p005', label: 'Last right', height: 76 }
  ]);

  const nodes = optionNodes(h);
  assert.equal(translate(nodes.find(node => node.textContent.startsWith('Next left'))).y, 150,
    'the next row starts after the tallest card in the asymmetric first row');
  assert.equal(translate(nodes.find(node => node.textContent.startsWith('Last left'))).y, 240);
  assert.equal(h.canvas.style.getPropertyValue('height'), '440px');

  const tallRight = nodes.find(node => node.textContent.startsWith('Tall right'));
  tallRight.naturalHeight = 190;
  FakeResizeObserver.instances[0].trigger(tallRight);
  assert.equal(translate(nodes.find(node => node.textContent.startsWith('Next left'))).y, 190,
    'a rendered option resize reflows later rows without overlap');
  assert.equal(h.canvas.style.getPropertyValue('height'), '480px');
});

test('200% text uses measured one-column content above the 126px density minimum', () => {
  const h = makeHarness({ fontSize: '32px', height: 260 });
  h.list.setItems([
    { id: 'p000', label: 'Localized tall card', height: 174 },
    { id: 'p001', label: 'Minimum card', height: 100 },
    { id: 'p002', label: 'Another tall card', height: 148 }
  ]);
  const nodes = optionNodes(h);
  const first = nodes.find(node => node.textContent.startsWith('Localized tall card'));
  const second = nodes.find(node => node.textContent.startsWith('Minimum card'));
  const third = nodes.find(node => node.textContent.startsWith('Another tall card'));
  assert.equal(first.style.getPropertyValue('min-height'), '126px');
  assert.deepEqual(translate(second), { x: 0, y: 174 });
  assert.deepEqual(translate(third), { x: 0, y: 300 });
  assert.equal(h.canvas.style.getPropertyValue('height'), '448px');
});

test('option-only ResizeObserver entries refresh runtime text scale before measuring cards', () => {
  const h = makeHarness({ width: 390, fontSize: '16px', height: 260 });
  h.list.setItems(items(8));
  assert.equal(translate(optionNodes(h)[1]).y, 0);

  h.container.fontSize = '32px';
  FakeResizeObserver.instances[0].trigger(optionNodes(h)[0]);
  const nodes = optionNodes(h);
  assert.deepEqual(translate(nodes.find(node => node.textContent.startsWith('Player 1'))), { x: 0, y: 126 },
    'an option-only resize batch still remeasures 200% text and safety-caps the list to one column');
  assert.equal(nodes[0].style.getPropertyValue('min-height'), '126px');
});

test('custom column policy is honored but invalid values and enlarged text fail closed to one column', () => {
  const policyCalls = [];
  const forcedTwo = makeHarness({ width: 320, columns: (width, context) => {
    policyCalls.push({ width, textScale: context.textScale });
    return 2;
  } });
  forcedTwo.list.setItems(items(4));
  assert.deepEqual(policyCalls[0], { width: 292, textScale: 1 });
  assert.equal(translate(optionNodes(forcedTwo)[1]).y, 0, 'a valid custom policy may opt into two columns');

  forcedTwo.container.fontSize = '24px';
  FakeResizeObserver.instances[0].trigger(forcedTwo.container);
  assert.ok(translate(optionNodes(forcedTwo)[1]).y > 0,
    'custom two-column output is safety-capped to one column above 125% text');

  const forcedOne = makeHarness({ columns: () => 1 });
  forcedOne.list.setItems(items(4));
  assert.equal(translate(optionNodes(forcedOne)[1]).y, 76, 'custom one-column output overrides the wide default');

  const invalid = makeHarness({ columns: () => '2' });
  invalid.list.setItems(items(4));
  assert.equal(translate(optionNodes(invalid)[1]).y, 76, 'a non-numeric custom result fails closed');

  const throws = makeHarness({ columns: () => { throw new Error('bad policy'); } });
  throws.list.setItems(items(4));
  assert.equal(translate(optionNodes(throws)[1]).y, 76, 'a throwing custom policy fails closed');
});

test('setItems and remeasure retain the first visible key, pixel offset, and active descendant', () => {
  const h = makeHarness();
  const roster = items(80);
  h.list.setItems(roster);
  h.container.scrollTop = 10 * 76 + 11;
  h.container.dispatch('scroll');
  h.container.focus();
  const visibleKey = activeNode(h).textContent;
  assert.match(visibleKey, /^Player 20/);

  const next = [{ id: 'new-a', label: 'New A' }, { id: 'new-b', label: 'New B' }, ...roster];
  h.list.setItems(next);
  assert.equal(h.container.scrollTop, 11 * 76 + 11,
    'the same row-start key keeps its exact in-row offset after a prepend delta');
  const activeId = h.container.getAttribute('aria-activedescendant');
  assert.match(activeNode(h).textContent, /^Player 20/);

  h.container.fontSize = '32px';
  FakeResizeObserver.instances[0].trigger();
  assert.equal(h.container.scrollTop, 22 * 126 + 11,
    'canvas geometry grows before the browser-clamped scrollTop restores the same anchor at 2783px');
  assert.equal(h.canvas.style.getPropertyValue('overflow-anchor'), 'none',
    'native overflow anchoring cannot apply a second adjustment after explicit restoration');
  assert.equal(h.container.getAttribute('aria-activedescendant'), activeId,
    'the active descendant id remains stable across reorder and remeasure');

  h.container.scrollTop = 60 * 126;
  h.container.dispatch('scroll');
  assert.ok(activeNode(h), 'the focused active option stays mounted while off-screen');
  h.container.dispatch('focusout', { relatedTarget: null });
  assert.equal(h.container.hasAttribute('aria-activedescendant'), false);
  assert.equal(optionNodes(h).some(node => node.getAttribute('id') === activeId), false,
    'the off-screen active option may recycle only after focus leaves the listbox');
});

test('setItems grows canvas geometry before restoring an anchor beyond the old scroll range', () => {
  const h = makeHarness();
  const roster = items(30);
  h.list.setItems(roster);
  h.container.scrollTop = 7 * 76 + 8;
  assert.equal(h.container.scrollTop, 540, 'the fake browser clamps to the old maximum scroll range');

  const prepended = items(50, 'new-').concat(roster);
  h.list.setItems(prepended);
  assert.equal(h.container.scrollTop, 32 * 76 + 8,
    'the original p014 anchor restores only after the expanded canvas raises the native maximum');
});

test('scrollToKey converges near the tail on first call and cloned items retain per-key measurements', () => {
  const h = makeHarness({ height: 600 });
  const roster = items(150).map(item => ({ ...item, height: 150 }));
  h.list.setItems(roster);

  assert.equal(h.list.scrollToKey('p140', 'start'), true);
  let target = optionNodes(h).find(node => node.textContent.startsWith('Player 140'));
  assert.ok(target, 'the near-tail target is rendered during the first call');
  assert.equal(h.container.scrollTop, translate(target).y,
    'the first call realigns after measured tail rows grow beyond the initially clamped canvas');
  const stableTop = h.container.scrollTop;

  h.list.setItems(roster.map(item => ({ ...item })));
  target = optionNodes(h).find(node => node.textContent.startsWith('Player 140'));
  assert.equal(h.container.scrollTop, stableTop,
    'stable keys keep measured height estimates when projectors clone every item');
  assert.equal(h.container.scrollTop, translate(target).y,
    'the cloned update preserves exact start alignment instead of dropping the anchor');
});

test('focused active option wins over the viewport anchor after reorder and is repaired after removal or async load', () => {
  const h = makeHarness({ height: 228 });
  const roster = items(100);
  h.list.setItems(roster);
  h.container.scrollTop = 10 * 76;
  h.container.dispatch('scroll');
  h.container.focus();
  assert.match(activeNode(h).textContent, /^Player 20\b/);

  h.container.scrollTop = 30 * 76;
  h.container.dispatch('scroll');
  assert.match(activeNode(h).textContent, /^Player 20\b/, 'manual scroll does not silently change keyboard focus');
  const reordered = roster.slice(40).concat(roster.slice(0, 40));
  h.list.setItems(reordered);
  assert.match(activeNode(h).textContent, /^Player 20\b/);
  const activeTop = translate(activeNode(h)).y;
  assert.ok(activeTop >= h.container.scrollTop && activeTop + 76 <= h.container.scrollTop + h.container.clientHeight,
    'surviving focused active option is scrolled into the visible viewport after reorder');

  h.list.setItems(reordered.filter(item => item.id !== 'p020'));
  assert.ok(h.container.hasAttribute('aria-activedescendant'));
  assert.match(activeNode(h).textContent, /^Player 21\b/,
    'removing the active option selects its nearest surviving next neighbor');

  const empty = makeHarness();
  empty.container.focus();
  assert.equal(empty.container.hasAttribute('aria-activedescendant'), false);
  empty.list.setItems(items(4));
  assert.match(activeNode(empty).textContent, /^Player 0\b/,
    'a focused empty list establishes an active descendant when data arrives asynchronously');
});

test('focused active visibility is reconciled after newly measured rows change final geometry', () => {
  const h = makeHarness({ height: 228 });
  const roster = items(50);
  h.list.setItems(roster);
  h.container.focus();
  assert.match(activeNode(h).textContent, /^Player 0\b/);

  h.container.scrollTop = 10 * 76;
  h.container.dispatch('scroll');
  const reordered = roster.slice(1);
  reordered.splice(30, 0, roster[0]);
  reordered[28] = { ...reordered[28], height: 500 };
  h.list.setItems(reordered);

  const active = activeNode(h);
  assert.match(active.textContent, /^Player 0\b/);
  assert.equal(translate(active).y, 15 * 76 + (500 - 76),
    'the newly measured 500px row pushes the active row to its truthful 1564px offset');
  assert.equal(h.container.scrollTop, 1564 + 76 - 228,
    'a final post-measurement reconciliation keeps the focused active row visible');

  h.container.scrollTop = 0;
  h.container.dispatch('scroll');
  assert.equal(h.container.scrollTop, 0,
    'an intentional manual scroll after the transaction is never pulled back to the active option');
  assert.match(activeNode(h).textContent, /^Player 0\b/,
    'the off-screen active descendant remains mounted until focus leaves');
});

test('removed viewport anchors choose the nearest surviving next key, then previous, across bulk filters', () => {
  const h = makeHarness({ height: 60 });
  const roster = items(80);
  h.list.setItems(roster);
  h.container.scrollTop = 10 * 76 + 11;

  h.list.setItems(roster.filter((item, index) => index >= 10 && !(index >= 20 && index < 40)));
  assert.equal(h.container.scrollTop, 5 * 76 + 11,
    'when p020 and many adjacent keys disappear, surviving next p040 keeps the visual offset');
  assert.ok(optionNodes(h).some(node => node.textContent.startsWith('Player 40')));

  h.container.scrollTop = 5 * 76 + 11;
  h.list.setItems(roster.slice(0, 20));
  assert.equal(h.container.scrollTop, 9 * 76 + 11,
    'when no following neighbor survives, previous p019 is the deterministic fallback');
});

test('keyboard navigation, activation, and click use the accessible listbox contract', () => {
  const h = makeHarness({ width: 320, height: 228, paddingLeft: '10px', paddingRight: '10px' });
  h.list.setItems(items(10));
  h.container.focus();
  assert.match(activeNode(h).textContent, /^Player 0/);

  for (const [key, expected] of [
    ['ArrowDown', 1], ['PageDown', 4], ['End', 9], ['Home', 0], ['ArrowUp', 0], ['PageUp', 0]
  ]) {
    const event = h.container.dispatch('keydown', { key });
    assert.equal(event.defaultPrevented, true, `${key} is consumed by the listbox`);
    assert.match(activeNode(h).textContent, new RegExp(`^Player ${expected}\\b`));
  }

  h.container.dispatch('keydown', { key: 'End' });
  h.container.dispatch('keydown', { key: 'Enter' });
  h.container.dispatch('keydown', { key: ' ' });
  assert.deepEqual(h.activated.slice(-2), [
    { id: 'p009', index: 9, type: 'keydown' },
    { id: 'p009', index: 9, type: 'keydown' }
  ]);

  h.list.scrollToKey('p004');
  const fourth = optionNodes(h).find(node => node.textContent.startsWith('Player 4'));
  h.container.dispatch('click', { target: fourth });
  assert.deepEqual(h.activated.at(-1), { id: 'p004', index: 4, type: 'click' });
  assert.match(activeNode(h).textContent, /^Player 4/);
});

test('scrollToKey, empty data, zero-size resize, and destroy are safe and restore the host', () => {
  const document = new FakeDocument();
  const container = document.createElement('div');
  container.clientWidth = 0;
  container.clientHeight = 0;
  container.setAttribute('role', 'region');
  container.setAttribute('tabindex', '5');
  container.setAttribute('aria-activedescendant', 'legacy-active');
  const api = loadApi();
  let renderCount = 0;
  const list = api.create({
    container,
    ResizeObserver: FakeResizeObserver,
    key: item => item.id,
    renderItem(node, item) { renderCount += 1; node.textContent = item.label; }
  });
  assert.equal(Object.isFrozen(list), true);
  assert.deepEqual(Object.keys(list), ['setItems', 'scrollToKey', 'remeasure', 'destroy']);
  list.setItems(items(5));
  assert.ok(renderCount > 0, 'a zero-size host still takes the safe minimum render path');
  assert.equal(list.scrollToKey('missing'), false);
  assert.equal(list.scrollToKey('p004'), true);

  list.setItems([]);
  assert.equal(container.children[0].style.getPropertyValue('height'), '0px');
  assert.equal(container.children[0].children.length, 0);
  assert.doesNotThrow(() => list.remeasure());

  const observer = FakeResizeObserver.instances.at(-1);
  list.destroy();
  assert.equal(observer.disconnected, true);
  assert.equal(container.children.length, 0);
  assert.equal(container.getAttribute('role'), 'region');
  assert.equal(container.getAttribute('tabindex'), '5');
  assert.equal(container.getAttribute('aria-activedescendant'), 'legacy-active');
  assert.doesNotThrow(() => list.destroy(), 'destroy is idempotent');
  assert.equal(list.scrollToKey('p000'), false, 'destroyed instances ignore later work');
});

test('real Chromium preserves a far anchor while density geometry grows and measures asymmetric cards',
  { timeout: 15000 }, async t => {
    let chromium;
    try {
      ({ chromium } = require('playwright'));
    } catch (_) {
      t.skip('Playwright is unavailable');
      return;
    }

    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (_) {
      t.skip('Chromium is unavailable');
      return;
    }

    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(`
        <style>
          * { box-sizing: border-box; }
          html, body { margin: 0; }
          .list { width: 390px; height: 600px; padding: 0 14px; overflow: auto; font-size: 16px; }
          .card { padding: 12px; line-height: 24px; border: 1px solid transparent; }
        </style>
        <div id="anchor" class="list"></div>
        <div id="measured" class="list" style="height:220px"></div>
        <div id="scaled" class="list" style="height:300px;font-size:32px"></div>
        <div id="focused" class="list" style="height:228px"></div>
        <div id="tail" class="list"></div>
      `);
      await page.addScriptTag({ path: MODULE_PATH });
      const result = await page.evaluate(() => {
        const roster = Array.from({ length: 80 }, (_, index) => ({
          id: `p${String(index).padStart(3, '0')}`,
          label: `Player ${index}`
        }));
        const anchorHost = document.getElementById('anchor');
        const anchorList = VirtualList.create({
          container: anchorHost,
          key: item => item.id,
          renderItem(node, item) { node.textContent = item.label; }
        });
        anchorList.setItems(roster);
        anchorHost.scrollTop = 10 * 76 + 11;
        anchorHost.dispatchEvent(new Event('scroll'));
        anchorHost.focus();
        anchorList.setItems([
          { id: 'new-a', label: 'New A' },
          { id: 'new-b', label: 'New B' },
          ...roster
        ]);
        anchorHost.style.fontSize = '32px';
        anchorList.remeasure();
        const anchorActiveText = anchorHost.querySelector(`#${anchorHost.getAttribute('aria-activedescendant')}`)?.textContent;

        const measuredHost = document.getElementById('measured');
        const measuredList = VirtualList.create({
          container: measuredHost,
          key: item => item.id,
          renderItem(node, item) {
            node.className = 'card';
            node.textContent = item.label;
          }
        });
        measuredList.setItems([
          { id: 'a', label: 'short' },
          { id: 'b', label: 'This localized card wraps across enough words to require substantially more than the minimum row height on a narrow column.' },
          { id: 'c', label: 'next row' },
          { id: 'd', label: 'next row peer' }
        ]);
        const options = [...measuredHost.querySelectorAll('[role="option"]')];
        const firstRowHeight = Math.max(options[0].getBoundingClientRect().height,
          options[1].getBoundingClientRect().height);
        const nextRowTop = new DOMMatrixReadOnly(getComputedStyle(options[2]).transform).m42;

        const scaledHost = document.getElementById('scaled');
        const scaledList = VirtualList.create({
          container: scaledHost,
          key: item => item.id,
          renderItem(node, item) {
            node.className = 'card';
            node.textContent = item.label;
          }
        });
        scaledList.setItems([
          { id: 'large-a', label: 'Very long localized player status content that wraps naturally at two hundred percent text.' },
          { id: 'large-b', label: 'Second enlarged card' }
        ]);
        const scaledOptions = [...scaledHost.querySelectorAll('[role="option"]')];
        const scaledFirst = scaledOptions[0].getBoundingClientRect();
        const scaledSecondTransform = new DOMMatrixReadOnly(getComputedStyle(scaledOptions[1]).transform);

        const focusedHost = document.getElementById('focused');
        const focusedRoster = Array.from({ length: 50 }, (_, index) => ({
          id: `focus-${index}`,
          label: `Focus ${index}`
        }));
        const focusedList = VirtualList.create({
          container: focusedHost,
          key: item => item.id,
          renderItem(node, item) {
            node.textContent = item.label;
            node.style.height = item.tall ? '500px' : '76px';
          }
        });
        focusedList.setItems(focusedRoster);
        focusedHost.focus();
        focusedHost.scrollTop = 10 * 76;
        focusedHost.dispatchEvent(new Event('scroll'));
        const focusedReordered = focusedRoster.slice(1);
        focusedReordered.splice(30, 0, focusedRoster[0]);
        focusedReordered[28] = { ...focusedReordered[28], tall: true };
        focusedList.setItems(focusedReordered);
        const focusedActive = focusedHost.querySelector(`#${focusedHost.getAttribute('aria-activedescendant')}`);
        const focusedActiveTop = new DOMMatrixReadOnly(getComputedStyle(focusedActive).transform).m42;
        const focusedScrollTop = focusedHost.scrollTop;
        focusedHost.scrollTop = 0;
        focusedHost.dispatchEvent(new Event('scroll'));

        const tailHost = document.getElementById('tail');
        const tailRoster = Array.from({ length: 150 }, (_, index) => ({
          id: `tail-${index}`,
          label: `Tail ${index}`
        }));
        const tailList = VirtualList.create({
          container: tailHost,
          key: item => item.id,
          renderItem(node, item) {
            node.textContent = item.label;
            node.style.height = '150px';
          }
        });
        tailList.setItems(tailRoster);
        tailList.scrollToKey('tail-140', 'start');
        let tailTarget = [...tailHost.querySelectorAll('[role="option"]')]
          .find(node => node.textContent === 'Tail 140');
        const tailFirstScrollTop = tailHost.scrollTop;
        const tailFirstTargetTop = new DOMMatrixReadOnly(getComputedStyle(tailTarget).transform).m42;
        tailList.setItems(tailRoster.map(item => ({ ...item })));
        tailTarget = [...tailHost.querySelectorAll('[role="option"]')]
          .find(node => node.textContent === 'Tail 140');

        return {
          scrollTop: anchorHost.scrollTop,
          activeText: anchorActiveText,
          overflowAnchor: anchorHost.firstElementChild.style.overflowAnchor,
          firstRowHeight,
          nextRowTop,
          measuredCanvasHeight: measuredHost.firstElementChild.getBoundingClientRect().height,
          scaledFirstHeight: scaledFirst.height,
          scaledSecondX: scaledSecondTransform.m41,
          scaledSecondTop: scaledSecondTransform.m42,
          focusedActiveText: focusedActive.textContent,
          focusedActiveTop,
          focusedScrollTop,
          focusedManualScrollTop: focusedHost.scrollTop,
          tailFirstScrollTop,
          tailFirstTargetTop,
          tailCloneScrollTop: tailHost.scrollTop,
          tailCloneTargetTop: new DOMMatrixReadOnly(getComputedStyle(tailTarget).transform).m42
        };
      });

      assert.equal(result.scrollTop, 22 * 126 + 11);
      assert.equal(result.activeText, 'Player 20');
      assert.equal(result.overflowAnchor, 'none');
      assert.ok(result.firstRowHeight > 76, `localized content grows beyond the minimum: ${result.firstRowHeight}`);
      assert.equal(result.nextRowTop, result.firstRowHeight,
        'the second browser row starts exactly after the measured tallest first-row card');
      assert.ok(result.measuredCanvasHeight >= result.nextRowTop + 76);
      assert.ok(result.scaledFirstHeight >= 126);
      assert.equal(result.scaledSecondX, 0, '200% browser text remains safety-capped to one column');
      assert.equal(result.scaledSecondTop, result.scaledFirstHeight,
        '200% localized content advances by its real measured height');
      assert.equal(result.focusedActiveText, 'Focus 0');
      assert.equal(result.focusedActiveTop, 1564);
      assert.equal(result.focusedScrollTop, 1412,
        'real Chromium reconciles focused active visibility after dynamic geometry settles');
      assert.equal(result.focusedManualScrollTop, 0,
        'real Chromium leaves later intentional manual scrolling untouched');
      assert.equal(result.tailFirstScrollTop, result.tailFirstTargetTop,
        'real Chromium converges a near-tail start alignment in one scrollToKey call');
      assert.equal(result.tailCloneScrollTop, result.tailFirstScrollTop);
      assert.equal(result.tailCloneTargetTop, result.tailCloneScrollTop,
        'real Chromium preserves measured per-key geometry across cloned projections');
    } finally {
      await browser.close();
    }
  });
