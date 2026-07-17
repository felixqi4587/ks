const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULE_PATH = path.join(__dirname, '../public/battle-drawer.js');

function loadCommonApi() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const moduleValue = { exports: {} };
  vm.runInNewContext(source, {
    module: moduleValue,
    exports: moduleValue.exports,
    globalThis: {},
    Object,
    Array,
    Number,
    Math,
    TypeError,
    Error
  }, { filename: MODULE_PATH });
  return moduleValue.exports;
}

function loadBrowserApi() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const context = { Object, Array, Number, Math, TypeError, Error };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: MODULE_PATH });
  return context.BattleDrawer;
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    if (force === undefined) force = !this.values.has(name);
    if (force) this.values.add(name); else this.values.delete(name);
    return force;
  }
}

class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(name, value) { this.values.set(name, String(value)); }
  getPropertyValue(name) { return this.values.get(name) || ''; }
  removeProperty(name) { const old = this.getPropertyValue(name); this.values.delete(name); return old; }
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  listenerCount(type) { return this.listeners.get(type)?.size || 0; }
  emit(type, values = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      pointerId: 1,
      pointerType: 'touch',
      button: 0,
      isPrimary: true,
      clientX: 20,
      clientY: 200,
      timeStamp: 0,
      key: '',
      shiftKey: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...values
    };
    for (const listener of [...(this.listeners.get(type) || [])]) listener(event);
    return event;
  }
}

class FakeElement extends FakeEventTarget {
  constructor(document, options = {}) {
    super();
    this.ownerDocument = document;
    this.style = new FakeStyle();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.inert = false;
    this.disabled = !!options.disabled;
    this.hidden = false;
    this.cssHidden = false;
    this.interactive = !!options.interactive;
    this.rect = options.rect || { top: 0, left: 0, width: 390, height: 800 };
    this.computedTransform = 'none';
    this.captured = [];
    this.released = [];
    this.focusCount = 0;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(child) { child.parentElement = this; this.children.push(child); }
  contains(candidate) {
    return candidate === this || this.children.some(child => child.contains(candidate));
  }
  closest(selector) {
    if (/\[hidden\]|\[inert\]|aria-hidden/.test(selector)) {
      let current = this;
      while (current) {
        if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return current;
        current = current.parentElement;
      }
      return null;
    }
    return this.interactive ? this : null;
  }
  matches() { return this.interactive; }
  querySelectorAll(selector) {
    if (selector === '[data-drawer-focus]') return this.preferredFocus ? [this.preferredFocus] : [];
    return this.focusables || [];
  }
  querySelector() { return this.preferredFocus || null; }
  getBoundingClientRect() { return { ...this.rect }; }
  getClientRects() { return this.cssHidden ? [] : [this.getBoundingClientRect()]; }
  setPointerCapture(pointerId) { this.captured.push(pointerId); }
  releasePointerCapture(pointerId) { this.released.push(pointerId); }
  hasPointerCapture(pointerId) { return this.captured.includes(pointerId) && !this.released.includes(pointerId); }
  focus() { this.focusCount += 1; this.ownerDocument.activeElement = this; }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.activeElement = null;
    this.defaultView = new FakeEventTarget();
    this.defaultView.innerHeight = 800;
    this.defaultView.getComputedStyle = element => ({
      transform: element.computedTransform,
      display: element.cssHidden ? 'none' : 'block',
      visibility: element.cssHidden ? 'hidden' : 'visible'
    });
  }
}

function createHarness(options = {}) {
  const api = loadCommonApi();
  const document = new FakeDocument();
  const root = new FakeElement(document);
  root.id = 'managerDrawer';
  const handle = new FakeElement(document, { rect: { top: 0, left: 0, width: 390, height: 56 } });
  const list = new FakeElement(document);
  const background = new FakeElement(document);
  const first = new FakeElement(document);
  const last = new FakeElement(document);
  const outside = new FakeElement(document);
  root.append(handle);
  root.append(list);
  root.focusables = [handle, first, last];
  root.preferredFocus = first;
  document.activeElement = outside;
  if (typeof options.beforeCreate === 'function') {
    options.beforeCreate({ document, root, handle, list, background, first, last, outside });
  }
  const changes = [];
  const reducedMotion = { matches: !!options.reducedMotion };
  const drawer = api.create({
    root,
    handle,
    background,
    reducedMotion,
    onStateChange(state) {
      changes.push(state);
      if (typeof options.onStateChange === 'function') options.onStateChange(state);
    }
  });
  return { api, document, root, handle, list, background, first, last, outside, changes, drawer };
}

function drawerY(root) {
  return Number.parseFloat(root.style.getPropertyValue('--battle-drawer-y'));
}

function pointer(target, type, y, timeStamp, extra = {}) {
  const receiver = type === 'pointerdown' ? target : target.ownerDocument;
  return receiver.emit(type, { target, clientY: y, timeStamp, ...extra });
}

test('BattleDrawer exposes one frozen UMD API with no product-specific dependencies', () => {
  const common = loadCommonApi();
  const browser = loadBrowserApi();
  assert.deepEqual(Object.keys(common), ['create']);
  assert.equal(typeof common.create, 'function');
  assert.equal(typeof browser.create, 'function');
  assert.equal(Object.isFrozen(common), true);
});

test('programmatic APIs cover closed, command, and manage without duplicate transitions', () => {
  const h = createHarness();
  assert.equal(h.drawer.state(), 'closed');
  assert.equal(drawerY(h.root), 800);
  assert.equal(h.root.dataset.drawerState, 'closed');
  assert.equal(h.root.inert, true, 'closed content is removed from sequential focus and accessibility');
  assert.equal(h.root.hasAttribute('inert'), true);

  h.drawer.openCommand();
  assert.equal(h.drawer.state(), 'command');
  assert.equal(drawerY(h.root), 456, '43dvh command detent is 344px on an 800px viewport');
  assert.equal(h.root.inert, false);
  assert.equal(h.root.hasAttribute('inert'), false);
  assert.equal(h.background.inert, false, 'command keeps the live tactical page interactive');

  h.drawer.openCommand();
  assert.deepEqual(h.changes, ['command'], 'idempotent calls do not repaint state');

  h.drawer.openManage();
  assert.equal(h.drawer.state(), 'manage');
  assert.equal(drawerY(h.root), 0);
  assert.equal(h.background.inert, true);
  assert.equal(h.background.hasAttribute('inert'), true);
  assert.equal(h.root.getAttribute('aria-modal'), 'true');
  assert.equal(h.first.focusCount, 1);

  h.drawer.backToCommand();
  assert.equal(h.drawer.state(), 'command');
  assert.equal(h.background.inert, false);
  assert.equal(h.outside.focusCount, 1, 'leaving modal manage restores the prior focus');

  h.drawer.close();
  assert.equal(h.drawer.state(), 'closed');
  assert.equal(drawerY(h.root), 800);
  assert.equal(h.root.inert, true);
  assert.deepEqual(h.changes, ['command', 'manage', 'command', 'closed']);
});

test('vertical drag waits for 10px intent then follows the original grab point 1:1', () => {
  const h = createHarness();
  h.drawer.openCommand();
  h.root.classList.remove('is-settling');
  pointer(h.handle, 'pointerdown', 600, 0);
  const beforeIntent = pointer(h.handle, 'pointermove', 591, 20);
  assert.equal(drawerY(h.root), 456);
  assert.deepEqual(h.handle.captured, [], 'intent tracking does not claim pointer capture early');
  assert.equal(beforeIntent.defaultPrevented, false);

  const afterIntent = pointer(h.handle, 'pointermove', 580, 40);
  assert.equal(drawerY(h.root), 436, 'the full 20px delta is retained after intent recognition');
  assert.deepEqual(h.handle.captured, [1]);
  assert.equal(afterIntent.defaultPrevented, true);

  pointer(h.handle, 'pointermove', 540, 80);
  assert.equal(drawerY(h.root), 396, 'subsequent pointer travel remains exactly 1:1');
});

test('horizontal intent, interactive header controls, and scrolling-list gestures never drag the drawer', () => {
  const h = createHarness();
  h.drawer.openCommand();
  h.root.classList.remove('is-settling');

  pointer(h.handle, 'pointerdown', 600, 0, { clientX: 20 });
  pointer(h.handle, 'pointermove', 588, 20, { clientX: 60 });
  assert.equal(drawerY(h.root), 456, 'horizontal intent is left to the page');
  pointer(h.handle, 'pointercancel', 588, 21, { clientX: 60 });

  const button = new FakeElement(h.document, { interactive: true });
  h.handle.emit('pointerdown', { target: button, clientY: 600 });
  pointer(h.handle, 'pointermove', 500, 20);
  assert.equal(drawerY(h.root), 456, 'buttons inside the header retain native activation');

  pointer(h.list, 'pointerdown', 600, 0);
  pointer(h.list, 'pointermove', 300, 20);
  pointer(h.list, 'pointerup', 300, 30);
  assert.equal(drawerY(h.root), 456, 'the scrolling roster has no drawer listeners');
});

test('release chooses detents from projected position and release velocity', () => {
  const position = createHarness();
  position.drawer.openCommand();
  position.root.classList.remove('is-settling');
  pointer(position.handle, 'pointerdown', 600, 0);
  pointer(position.handle, 'pointermove', 250, 300);
  pointer(position.handle, 'pointerup', 250, 310);
  assert.equal(position.drawer.state(), 'manage', 'position near the top settles to manage');

  const velocity = createHarness();
  velocity.drawer.openCommand();
  velocity.root.classList.remove('is-settling');
  pointer(velocity.handle, 'pointerdown', 600, 0);
  pointer(velocity.handle, 'pointermove', 588, 100);
  pointer(velocity.handle, 'pointermove', 530, 105);
  pointer(velocity.handle, 'pointerup', 530, 106);
  assert.equal(velocity.drawer.state(), 'manage', 'an upward flick projects to the next detent');

  const downward = createHarness();
  downward.drawer.openCommand();
  downward.root.classList.remove('is-settling');
  pointer(downward.handle, 'pointerdown', 300, 0);
  pointer(downward.handle, 'pointermove', 312, 100);
  pointer(downward.handle, 'pointermove', 390, 105);
  pointer(downward.handle, 'pointerup', 390, 106);
  assert.equal(downward.drawer.state(), 'closed', 'a downward flick projects to closed');
});

test('release velocity expires while the pointer rests before pointerup', () => {
  const h = createHarness();
  h.drawer.openCommand();
  h.root.classList.remove('is-settling');
  pointer(h.handle, 'pointerdown', 600, 0);
  pointer(h.handle, 'pointermove', 588, 100);
  pointer(h.handle, 'pointermove', 530, 105);
  pointer(h.handle, 'pointerup', 530, 605);
  assert.equal(h.drawer.state(), 'command', 'a 500ms pause settles from position, not stale flick speed');
});

test('rubber band is soft and bounded beyond the manage and closed detents', () => {
  const h = createHarness();
  h.drawer.openManage();
  h.root.classList.remove('is-settling');
  pointer(h.handle, 'pointerdown', 200, 0);
  pointer(h.handle, 'pointermove', -800, 20);
  assert.ok(drawerY(h.root) < 0);
  assert.ok(drawerY(h.root) > -57, `top overshoot stays bounded: ${drawerY(h.root)}`);
  pointer(h.handle, 'pointercancel', -800, 30);

  h.drawer.close();
  h.root.classList.remove('is-settling');
  pointer(h.handle, 'pointerdown', 100, 40);
  pointer(h.handle, 'pointermove', 1100, 60);
  assert.ok(drawerY(h.root) > 800);
  assert.ok(drawerY(h.root) < 857, `bottom overshoot stays bounded: ${drawerY(h.root)}`);
});

test('a new grab interrupts the presentation position and can reverse the settle', () => {
  const h = createHarness();
  h.drawer.openCommand();
  assert.equal(h.root.classList.contains('is-settling'), true);
  h.root.computedTransform = 'matrix(1, 0, 0, 1, 0, 620)';

  pointer(h.handle, 'pointerdown', 300, 10);
  assert.equal(h.root.classList.contains('is-settling'), false);
  assert.equal(drawerY(h.root), 620, 'pointerdown adopts the visible presentation value');
  pointer(h.handle, 'pointermove', 360, 30);
  assert.equal(drawerY(h.root), 680, 'reverse travel starts at the interrupted position');
  pointer(h.handle, 'pointerup', 360, 40);
  assert.equal(h.drawer.state(), 'closed');
});

test('viewport resize cancels and rebases an active drag inside the new detents', () => {
  const h = createHarness();
  h.drawer.openCommand();
  h.root.classList.remove('is-settling');
  pointer(h.handle, 'pointerdown', 300, 0);
  pointer(h.handle, 'pointermove', 450, 20);
  assert.ok(drawerY(h.root) > 390);

  h.root.rect.height = 390;
  h.document.defaultView.innerHeight = 390;
  h.document.defaultView.emit('resize');
  assert.equal(h.drawer.state(), 'command');
  assert.equal(drawerY(h.root), 160, 'landscape command always leaves 160px of tactical page');
  assert.equal(h.handle.hasPointerCapture(1), false);

  pointer(h.handle, 'pointerup', 450, 30);
  assert.equal(drawerY(h.root), 160, 'the stale release cannot reapply an old-viewport position');
});

test('landscape command detent reserves a truthful tactical viewport', () => {
  const h = createHarness({
    beforeCreate({ document, root }) {
      root.rect.height = 390;
      document.defaultView.innerHeight = 390;
    }
  });
  h.drawer.openCommand();
  assert.equal(drawerY(h.root), 160);
});

test('unexpected pointer-capture loss cancels the drag and accepts the next gesture', () => {
  const h = createHarness();
  h.drawer.openCommand();
  h.root.classList.remove('is-settling');
  pointer(h.handle, 'pointerdown', 600, 0);
  assert.deepEqual(h.handle.captured, [], 'intent candidate does not explicitly capture');
  pointer(h.handle, 'pointermove', 560, 20);
  assert.deepEqual(h.handle.captured, [1], 'vertical intent acquires capture');
  h.handle.emit('lostpointercapture', { pointerId: 1 });
  assert.equal(drawerY(h.root), 456);
  assert.equal(h.root.classList.contains('is-dragging'), false);

  pointer(h.handle, 'pointerdown', 600, 40, { pointerId: 2 });
  pointer(h.handle, 'pointermove', 300, 60, { pointerId: 2 });
  pointer(h.handle, 'pointerup', 300, 70, { pointerId: 2 });
  assert.equal(h.drawer.state(), 'manage', 'capture loss leaves the next gesture usable');
});

test('keyboard controls expose every detent and modal focus is trapped', () => {
  const h = createHarness();
  assert.equal(h.handle.getAttribute('tabindex'), '0');
  assert.equal(h.handle.getAttribute('role'), 'button');
  assert.equal(h.handle.getAttribute('aria-controls'), 'managerDrawer');
  assert.equal(h.handle.getAttribute('aria-expanded'), 'false');

  let event = h.handle.emit('keydown', { key: 'ArrowUp' });
  assert.equal(h.drawer.state(), 'command');
  assert.equal(event.defaultPrevented, true);
  h.handle.emit('keydown', { key: 'ArrowUp' });
  assert.equal(h.drawer.state(), 'manage');

  h.document.activeElement = h.handle;
  event = h.document.emit('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(h.document.activeElement, h.last);
  assert.equal(event.defaultPrevented, true);
  h.document.activeElement = h.last;
  h.document.emit('keydown', { key: 'Tab' });
  assert.equal(h.document.activeElement, h.handle);

  h.handle.emit('keydown', { key: 'ArrowDown' });
  assert.equal(h.drawer.state(), 'command');
  h.handle.emit('keydown', { key: 'End' });
  assert.equal(h.drawer.state(), 'closed');
  h.handle.emit('keydown', { key: 'Home' });
  assert.equal(h.drawer.state(), 'manage');
  h.handle.emit('keydown', { key: 'Escape' });
  assert.equal(h.drawer.state(), 'command');
});

test('button-role activation keys move through the explicit adjacent detents', () => {
  const h = createHarness();
  let event = h.handle.emit('keydown', { key: ' ' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.drawer.state(), 'command');
  event = h.handle.emit('keydown', { key: 'Enter' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.drawer.state(), 'manage');
  h.handle.emit('keydown', { key: ' ' });
  assert.equal(h.drawer.state(), 'command');
});

test('manage focus excludes hidden, inert, aria-hidden, and zero-layout candidates', () => {
  const h = createHarness();
  const hidden = new FakeElement(h.document); hidden.hidden = true;
  const inert = new FakeElement(h.document); inert.inert = true;
  const ariaHidden = new FakeElement(h.document); ariaHidden.setAttribute('aria-hidden', 'true');
  const noLayout = new FakeElement(h.document); noLayout.cssHidden = true;
  const editable = new FakeElement(h.document);
  h.root.focusables = [h.handle, hidden, inert, ariaHidden, noLayout, h.first, editable, h.last];
  h.root.preferredFocus = inert;

  h.drawer.openCommand();
  h.drawer.openManage();
  assert.equal(h.document.activeElement, h.handle, 'fallback uses the first actually visible control');
  h.document.activeElement = h.last;
  h.document.emit('keydown', { key: 'Tab' });
  assert.equal(h.document.activeElement, h.handle);
  h.document.activeElement = h.handle;
  h.document.emit('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(h.document.activeElement, h.last, 'visible contenteditable participates before the final item');
});

test('closing returns keyboard focus to the control that opened the drawer', () => {
  const h = createHarness();
  h.drawer.openCommand();
  h.handle.focus();
  h.drawer.close();
  assert.equal(h.document.activeElement, h.outside);
  assert.equal(h.outside.focusCount, 1);
});

test('pane swaps focus the revealed Manage target then restore the exact Command trigger', () => {
  let trigger;
  let manageTarget;
  const h = createHarness({
    beforeCreate({ document, root, handle, first, last }) {
      trigger = new FakeElement(document, { interactive: true });
      trigger.focus = function focusVisibleTrigger() {
        if (this.hidden) return;
        this.focusCount += 1;
        this.ownerDocument.activeElement = this;
      };
      root.append(trigger);
      manageTarget = new FakeElement(document, { interactive: true });
      manageTarget.hidden = true;
      root.append(manageTarget);
      root.preferredFocus = manageTarget;
      root.focusables = [handle, first, last, manageTarget];
    },
    onStateChange(state) {
      trigger.hidden = state !== 'command';
      manageTarget.hidden = state !== 'manage';
    }
  });
  h.drawer.openCommand();
  trigger.focus();
  assert.equal(h.document.activeElement, trigger);

  h.drawer.openManage();
  assert.equal(trigger.hidden, true, 'the adapter swaps Command for Manage content');
  assert.equal(manageTarget.hidden, false);
  assert.equal(h.document.activeElement, manageTarget, 'focus waits for the revealed Manage pane');

  h.drawer.backToCommand();
  assert.equal(trigger.hidden, false);
  assert.equal(h.document.activeElement, trigger, 'focus returns after Command content is visible again');
});

test('reduced motion snaps spatially and marks only a short static feedback path', () => {
  const h = createHarness({ reducedMotion: true });
  h.drawer.openCommand();
  assert.equal(h.drawer.state(), 'command');
  assert.equal(h.root.classList.contains('is-settling'), false);
  assert.equal(h.root.dataset.drawerMotion, 'static');
  assert.equal(h.root.style.getPropertyValue('--battle-drawer-duration'), '0ms');
});

test('destroy removes listeners, releases modal state, and preserves pre-existing inert state', () => {
  const h = createHarness();
  h.background.inert = true;
  h.background.setAttribute('inert', '');
  h.drawer.openManage();
  assert.equal(h.handle.listenerCount('pointerdown'), 1);
  assert.equal(h.handle.listenerCount('lostpointercapture'), 1);
  h.drawer.destroy();
  assert.equal(h.handle.listenerCount('pointerdown'), 0);
  assert.equal(h.handle.listenerCount('lostpointercapture'), 0);
  assert.equal(h.document.listenerCount('keydown'), 0);
  assert.equal(h.background.inert, true, 'destroy restores the background state it inherited');
  assert.equal(h.background.hasAttribute('inert'), true);
  const oldState = h.drawer.state();
  h.drawer.close();
  assert.equal(h.drawer.state(), oldState, 'a destroyed controller is inert');
});

test('destroy restores every owned attribute, dataset, inline transform variable, and background state', () => {
  const h = createHarness({
    beforeCreate({ root, handle, background }) {
      root.inert = true;
      root.setAttribute('inert', '');
      root.setAttribute('role', 'complementary');
      root.setAttribute('aria-hidden', 'false');
      root.dataset.drawerState = 'external-root';
      root.dataset.drawerMotion = 'external-motion';
      root.style.setProperty('--battle-drawer-y', '17px');
      root.style.setProperty('--battle-drawer-duration', '22ms');
      handle.setAttribute('role', 'heading');
      handle.setAttribute('tabindex', '7');
      handle.setAttribute('aria-controls', 'external-panel');
      handle.setAttribute('aria-expanded', 'mixed');
      handle.setAttribute('aria-valuetext', 'external-value');
      background.inert = true;
      background.setAttribute('inert', '');
      background.dataset.drawerBackgroundState = 'external-background';
    }
  });
  h.drawer.openCommand();
  pointer(h.handle, 'pointerdown', 600, 0);
  pointer(h.handle, 'pointermove', 520, 20);
  h.drawer.destroy();

  assert.equal(h.root.inert, true);
  assert.equal(h.root.hasAttribute('inert'), true);
  assert.equal(h.root.getAttribute('role'), 'complementary');
  assert.equal(h.root.getAttribute('aria-hidden'), 'false');
  assert.equal(h.root.getAttribute('aria-modal'), null);
  assert.equal(h.root.dataset.drawerState, 'external-root');
  assert.equal(h.root.dataset.drawerMotion, 'external-motion');
  assert.equal(h.root.style.getPropertyValue('--battle-drawer-y'), '17px');
  assert.equal(h.root.style.getPropertyValue('--battle-drawer-duration'), '22ms');
  assert.equal(h.handle.getAttribute('role'), 'heading');
  assert.equal(h.handle.getAttribute('tabindex'), '7');
  assert.equal(h.handle.getAttribute('aria-controls'), 'external-panel');
  assert.equal(h.handle.getAttribute('aria-expanded'), 'mixed');
  assert.equal(h.handle.getAttribute('aria-valuetext'), 'external-value');
  assert.equal(h.background.inert, true);
  assert.equal(h.background.hasAttribute('inert'), true);
  assert.equal(h.background.dataset.drawerBackgroundState, 'external-background');
  assert.equal(h.root.classList.contains('is-dragging'), false);
  assert.equal(h.handle.hasPointerCapture(1), false);
});
