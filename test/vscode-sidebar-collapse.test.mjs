import test from 'node:test';
import assert from 'node:assert/strict';
import { PRIMARY_NAVIGATION, sidebarBody, SIDEBAR_SCRIPT } from '../apps/vscode/src/views/sidebar-page.ts';

const view = overrides => ({ navigation: { workspace: { name: 'Workspace', repository: 'repo' }, next: null },
  freshness: null, loading: false, pending: null, active: 'stories',
  favorites: [{ id: 'my-work', label: 'My Work', icon: 'home' }], ...overrides });

test('the primary menu is an expanded native disclosure by default and can render collapsed', () => {
  const expanded = sidebarBody(view());
  assert.match(expanded, /<details class="main-menu" data-main-menu open>/);
  assert.match(expanded, /<summary data-focus-key="main-menu">Main menu<\/summary>/);
  const collapsed = sidebarBody(view({ menuCollapsed: true }));
  assert.match(collapsed, /<details class="main-menu" data-main-menu>/);
  assert.doesNotMatch(collapsed, /data-main-menu open/);
  const menu = collapsed.split('<details class="main-menu"')[1].split('</details>')[0];
  const remaining = collapsed.slice(collapsed.indexOf('</details>') + '</details>'.length);
  for (const item of PRIMARY_NAVIGATION) assert.ok(menu.includes(`data-action="${item.id}"`));
  assert.match(menu, /data-action="stories" aria-current="page"/);
  assert.match(remaining, /data-state-key="pinned-shortcuts"/);
  assert.match(remaining, /data-action="work-tools"/);
  assert.match(collapsed.split('<main>')[0], /data-action="workspace-switch"/);
  assert.equal((collapsed.match(/data-action="configuration-sync"/g) || []).length, 1);
});

// Run the shipping script, not a second implementation of persistence or dispatch.
function sidebarFixture({ collapsed = false, saved = {} } = {}) {
  let state = structuredClone(saved);
  const posted = [];
  const window = { listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } };
  const document = { activeElement: null, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } };
  const element = (dataset = {}, tagName = 'BUTTON') => ({
    dataset, tagName, listeners: {}, attributes: {}, disabled: false,
    addEventListener(type, listener) { this.listeners[type] = listener; },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    focus() { document.activeElement = this; },
    closest(selector) { return selector === 'button' && this.tagName === 'BUTTON' ? this : null; }
  });
  const main = element(); main.scrollTop = 0;
  const menu = element({}, 'DETAILS'); menu.open = !collapsed;
  const summary = element({ focusKey: 'main-menu' }, 'SUMMARY');
  menu.querySelector = selector => selector === 'summary' ? summary : null;
  const pins = element({ stateKey: 'pinned-shortcuts' }, 'DETAILS'); pins.open = false;
  const story = element({ action: 'stories' });
  story.closest = selector => selector === 'button' ? story : selector === 'details:not([open])' && !menu.open ? menu : null;
  const favorite = element({ action: 'favorite:my-work' });
  const nodes = [story, favorite, summary];
  document.querySelector = selector => selector === 'main' ? main : selector === '[data-main-menu]' ? menu : null;
  document.querySelectorAll = selector => selector === '[data-state-key]' ? [pins]
    : selector === 'nav [data-action],footer [data-action]' ? [story] : nodes;
  const api = { getState: () => state, setState: value => { state = value; }, postMessage: message => posted.push(message) };
  new Function('acquireVsCodeApi', 'window', 'document', SIDEBAR_SCRIPT)(() => api, window, document);
  return { menu, main, pins, summary, story, favorite, document, window, posted, state: () => state,
    toggle(open) { menu.open = open; summary.focus(); menu.listeners.toggle(); },
    click(target) { document.listeners.click({ target }); } };
}

test('collapse and expand persist presentation preferences without invoking a command', () => {
  const f = sidebarFixture({ saved: { scroll: 25, 'pinned-shortcuts': true } });
  assert.equal(f.menu.open, true);
  assert.equal(f.main.scrollTop, 25);
  assert.equal(f.pins.open, true);
  f.toggle(false);
  assert.deepEqual(f.posted.at(-1), { type: 'menu-collapse', collapsed: true });
  assert.equal(f.state().focus, 'main-menu');
  assert.equal(f.state().scroll, 25);
  assert.equal(f.state()['pinned-shortcuts'], true);
  f.toggle(true);
  assert.deepEqual(f.posted.at(-1), { type: 'menu-collapse', collapsed: false });
  f.click(f.summary);
  assert.equal(f.posted.length, 3, 'native summary clicks do not dispatch destination actions');
  f.click(f.favorite);
  assert.deepEqual(f.posted.at(-1), { type: 'action', action: 'favorite:my-work' });
});

test('durable collapsed state wins over stale webview state and hidden focus returns to the toggle', () => {
  const f = sidebarFixture({ collapsed: true, saved: { 'main-menu': true, focus: 'stories', scroll: 10 } });
  assert.equal(f.menu.open, false);
  assert.equal(f.document.activeElement, f.summary);
  assert.deepEqual(f.posted, [{ type: 'navigation-ready' }]);
  f.window.listeners.message({ data: { type: 'active-destination', id: 'stories' } });
  assert.equal(f.story.attributes['aria-current'], 'page');
  assert.equal(f.menu.open, false, 'destination updates do not reopen the menu');
  f.window.listeners.message({ data: { type: 'active-destination', id: null } });
  assert.equal(f.story.attributes['aria-current'], undefined);
  f.window.listeners.blur();
  assert.equal(f.state().focus, null);
});

test('a redraw restores toggle focus and independently remembers pinned shortcuts', () => {
  const before = sidebarFixture();
  before.pins.open = true;
  before.toggle(false);
  const after = sidebarFixture({ collapsed: true, saved: before.state() });
  assert.equal(after.menu.open, false);
  assert.equal(after.pins.open, true);
  assert.equal(after.document.activeElement, after.summary);
  after.toggle(true);
  assert.equal(after.menu.open, true);
  assert.equal(after.pins.open, true);
});
