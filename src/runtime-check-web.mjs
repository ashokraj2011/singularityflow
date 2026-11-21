/**
 * The runtime check of a web app (step intents spec §12.3): SFlow opens the running app in its pinned browser, types
 * into each input (part of a value, then the rest) and clicks each control, the way a person tries it, and watches:
 *   - charts, canvases, images and other media that change size while the person types or clicks (a layout jump);
 *   - errors in the browser console and uncaught page errors;
 *   - a control that changes nothing at all, and a page that scrolls sideways at phone width (advice);
 *   - a screenshot at phone, laptop and wide widths.
 * It is SFlow's own work: no model, nothing leaves the laptop (requests to any other host are not sent), and a control
 * whose words say it deletes, pays, sends or signs out is never clicked. Loaded only when a check runs.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const WEB_WIDTHS = Object.freeze([
  Object.freeze({ name: 'phone', width: 390, height: 844 }),
  Object.freeze({ name: 'laptop', width: 1280, height: 800 }),
  Object.freeze({ name: 'wide', width: 1920, height: 1080 })
]);
/** A size change counts as a layout jump above max(pixels, ratio of the size before). */
export const LAYOUT_SHIFT_THRESHOLD = Object.freeze({ pixels: 4, ratio: 0.02 });
const MAXIMUM_INPUTS = 8;
const MAXIMUM_CONTROLS = 12;
const MAXIMUM_CONSOLE = 20;
// Words on a control SFlow never clicks: it may delete, pay, send or sign out, even on a local app.
const RISKY_CONTROL = /\b(?:delete|remove|destroy|erase|purge|drop|reset|clear all|log ?out|sign ?out|pay|buy|purchase|checkout|order now|send|publish|deploy|transfer|unsubscribe)\b/iu;
const INPUTS = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]):not([type=range]):not([type=color]):not([type=date]):not([type=time]):not([type=datetime-local]):not([type=month]):not([type=week]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), [contenteditable="true"]';
const CONTROLS = 'button:not([disabled]), [role=button]:not([aria-disabled=true]), input[type=button]:not([disabled]), input[type=submit]:not([disabled]), a[href^="#"]';

/** What SFlow types into an input of `type`, in two parts: part of a value, then the rest. */
export function sampleText(type) {
  switch (String(type ?? 'text').toLowerCase()) {
    case 'number': return ['12', '345'];
    case 'email': return ['ana@ex', 'ample.test'];
    case 'tel': return ['555', '0100'];
    case 'url': return ['http://ex', 'ample.test'];
    default: return ['Sam', 'ple text 123'];
  }
}

/** Elements whose size should not follow typing or clicking: media, charts and graphs. Runs in the page. */
function measureInPage() {
  const describe = (element) => {
    const name = element.getAttribute('aria-label') || element.getAttribute('title') || element.id || element.getAttribute('name') || '';
    const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/u).slice(0, 2).join('.') : '';
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : classes ? `.${classes}` : ''}${name && !element.id ? ` "${name.slice(0, 40)}"` : ''}`;
  };
  const key = (element) => {
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && parts.length < 12; node = node.parentElement) {
      const parent = node.parentElement;
      const index = parent ? [...parent.children].filter((child) => child.tagName === node.tagName).indexOf(node) : 0;
      parts.unshift(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : `:${index}`}`);
      if (node.id) break;
    }
    return parts.join('>');
  };
  const watched = [...document.querySelectorAll('canvas, svg, img, video, iframe, picture, [role="img"], [data-chart], [class*="chart" i], [class*="graph" i], [class*="plot" i]')]
    .filter((element) => !(element.tagName.toLowerCase() === 'svg' && element.parentElement?.closest('svg')));
  const sizes = [];
  const kept = watched.slice(0, 200);
  for (const element of kept) {
    const box = element.getBoundingClientRect();
    if (box.width * box.height < 48 * 48) continue;
    // The watched elements around this one: a chart's container grows with it, and only the chart is named.
    const around = kept.filter((other) => other !== element && other.contains(element)).map(key);
    sizes.push({ key: key(element), what: describe(element), width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10, around });
  }
  const body = document.body;
  return { url: location.href, sizes, fingerprint: `${body?.innerHTML.length ?? 0}:${(body?.innerText ?? '').length}:${document.querySelectorAll('*').length}`,
    text: (body?.innerText ?? '').slice(0, 20000), overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth) };
}

const changed = (before, after, threshold) => {
  const delta = (left, right) => Math.abs(right - left) > Math.max(threshold.pixels, threshold.ratio * Math.max(left, 1));
  return delta(before.width, after.width) || delta(before.height, after.height);
};

/** The size changes between two measurements of the same elements: `[{ key, what, before, after }]`. */
export function sizeChanges(before, after, threshold = LAYOUT_SHIFT_THRESHOLD) {
  const now = new Map((after?.sizes ?? []).map((entry) => [entry.key, entry]));
  return (before?.sizes ?? []).filter((entry) => now.has(entry.key) && changed(entry, now.get(entry.key), threshold))
    .map((entry) => ({ key: entry.key, what: entry.what, around: entry.around ?? [], before: { width: entry.width, height: entry.height },
      after: { width: now.get(entry.key).width, height: now.get(entry.key).height } }));
}

const settle = (page, ms = 250) => page.evaluate((wait) => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, wait)))), ms).catch(() => {});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sizeWords = (size) => `${size.width}×${size.height}`;

/**
 * Drive the web app at `url` and return `{ status, missing, ran, findings, screenshots, observed }`. `launch` opens the
 * browser (the pinned review browser by default); one that cannot start makes the check `not-available`, naming its
 * install command. `screenshotDirectory` (absolute) receives one PNG per width. `deadline` is epoch milliseconds.
 */
export async function driveWebApplication(url, { launch = null, screenshotDirectory = null, deadline = Date.now() + 90_000,
  threshold = LAYOUT_SHIFT_THRESHOLD } = {}) {
  let browser;
  try {
    browser = launch ? await launch() : await (await import('./application-review-preview.mjs')).reviewBrowser({ headless: true, timeoutMs: 30_000 });
  } catch (error) {
    return { status: 'not-available', missing: [{ what: 'the pinned browser', why: String(error?.message ?? error).split('\n')[0],
      command: 'singularity-flow app-review browser install' }], ran: [], findings: [], screenshots: [], observed: {} };
  }
  const findings = [];
  const ran = [];
  const consoleErrors = [];
  const blocked = new Set();
  const origin = new URL(url).origin;
  const left = () => Math.max(1_000, deadline - Date.now());
  // What SFlow was doing when an error was logged, so the finding says when it happened.
  let current = 'loading the page';
  try {
    const context = await browser.newContext({ viewport: { width: WEB_WIDTHS[1].width, height: WEB_WIDTHS[1].height }, locale: 'en-US', timezoneId: 'UTC',
      deviceScaleFactor: 1, serviceWorkers: 'block' });
    await context.route('**/*', (route) => {
      const target = new URL(route.request().url());
      if (target.origin === origin || ['data:', 'blob:'].includes(target.protocol)) return route.continue();
      blocked.add(target.origin);
      return route.abort();
    });
    await context.routeWebSocket((target) => new URL(target).origin.replace(/^ws/u, 'http') !== origin, (socket) => { blocked.add(new URL(socket.url()).origin); socket.close(); });
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(10_000, left()));
    page.on('dialog', (dialog) => { dialog.dismiss().catch(() => {}); });
    page.on('console', (message) => {
      if (message.type() !== 'error' || consoleErrors.length >= MAXIMUM_CONSOLE) return;
      const where = message.location()?.url ?? '';
      // A request SFlow did not send to another host is not the app's error.
      if (/Failed to load resource/u.test(message.text()) && where && !where.startsWith(origin)) return;
      consoleErrors.push({ text: message.text().slice(0, 500), at: where ? `${where}:${message.location()?.lineNumber ?? 0}` : null, during: current });
    });
    page.on('pageerror', (error) => { if (consoleErrors.length < MAXIMUM_CONSOLE) consoleErrors.push({ text: String(error?.message ?? error).slice(0, 500), uncaught: true, during: current }); });
    let response;
    try { response = await page.goto(url, { waitUntil: 'load', timeout: Math.min(30_000, left()) }); }
    catch (error) {
      findings.push({ type: 'page-load-failed', class: 'breaks-use', title: `The page at ${url} did not load`, detail: String(error?.message ?? error).split('\n')[0] });
      return { status: 'ran', missing: [], ran: ['load the page'], findings, screenshots: [], observed: { blockedHosts: [...blocked] } };
    }
    await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, left()) }).catch(() => {});
    await settle(page);
    ran.push('load the page');
    if (response && response.status() >= 400) findings.push({ type: 'page-load-failed', class: 'breaks-use', title: `The page answered ${response.status()}`, detail: `GET ${url} returned ${response.status()}.` });
    // Each width, as loaded: a screenshot and whether the page scrolls sideways.
    const screenshots = [];
    for (const size of WEB_WIDTHS) {
      if (Date.now() > deadline) break;
      await page.setViewportSize({ width: size.width, height: size.height });
      await settle(page);
      const seen = await page.evaluate(measureInPage);
      if (seen.overflow > 16) findings.push({ type: 'overflow', class: 'improvement', title: `The page scrolls sideways at ${size.name} width (${size.width}px)`,
        detail: `Its content is ${seen.overflow}px wider than the window.`, evidence: { width: size.width, overflow: seen.overflow } });
      if (screenshotDirectory) {
        const bytes = await page.screenshot({ type: 'png', animations: 'disabled', timeout: Math.min(10_000, left()) }).catch(() => null);
        if (bytes) {
          await mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
          const file = path.join(screenshotDirectory, `${size.name}-${size.width}.png`);
          await writeFile(file, bytes, { mode: 0o600 });
          screenshots.push({ width: size.width, name: size.name, path: file, sha256: sha256(bytes) });
        }
      }
    }
    ran.push(`screenshots at ${WEB_WIDTHS.map((size) => `${size.width}px`).join(', ')}`);
    await page.setViewportSize({ width: WEB_WIDTHS[1].width, height: WEB_WIDTHS[1].height });
    await settle(page);
    const shifts = new Map();
    const shifted = (action, before, after) => {
      for (const change of sizeChanges(before, after, threshold)) {
        const entry = shifts.get(change.key) ?? { ...change, actions: [] };
        entry.actions.push({ action, before: change.before, after: change.after });
        shifts.set(change.key, entry);
      }
    };
    // Typing: part of a value, then the rest, into each input.
    const inputs = await page.locator(INPUTS).all();
    let typed = 0;
    for (const input of inputs.slice(0, MAXIMUM_INPUTS)) {
      if (Date.now() > deadline - 5_000) break;
      if (!await input.isVisible().catch(() => false)) continue;
      const label = await input.evaluate((element) => element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('name')
        || element.id || element.tagName.toLowerCase()).catch(() => 'an input');
      const type = await input.getAttribute('type').catch(() => null);
      const [first, rest] = sampleText(type);
      try {
        const before = await page.evaluate(measureInPage);
        await input.click({ timeout: 3_000 });
        current = `typing "${first}" into ${label}`;
        await page.keyboard.type(first, { delay: 25 });
        await settle(page);
        const middle = await page.evaluate(measureInPage);
        shifted(`typing "${first}" into ${label}`, before, middle);
        current = `typing "${first}${rest}" into ${label}`;
        await page.keyboard.type(rest, { delay: 25 });
        await settle(page);
        shifted(`typing the rest ("${first}${rest}") into ${label}`, middle, await page.evaluate(measureInPage));
        typed += 1;
      } catch { /* An input that cannot be typed into is skipped; the rest are still tried. */ }
    }
    if (typed) ran.push(`typed into ${typed} input${typed === 1 ? '' : 's'}`);
    // Clicking each control once, back on the page after any navigation.
    let clicked = 0;
    const skipped = [];
    const controls = await page.locator(CONTROLS).count();
    for (let index = 0; index < Math.min(controls, MAXIMUM_CONTROLS); index += 1) {
      if (Date.now() > deadline - 5_000) break;
      const control = page.locator(CONTROLS).nth(index);
      if (!await control.isVisible().catch(() => false)) continue;
      const words = (await control.evaluate((element) => `${element.innerText ?? ''} ${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''} ${element.value ?? ''}`).catch(() => '')).trim();
      const label = words.replace(/\s+/gu, ' ').slice(0, 60) || `control ${index + 1}`;
      if (RISKY_CONTROL.test(words)) { skipped.push(label); continue; }
      try {
        const before = await page.evaluate(measureInPage);
        const errors = consoleErrors.length;
        current = `clicking "${label}"`;
        await control.click({ timeout: 3_000, noWaitAfter: true });
        await settle(page, 350);
        const after = await page.evaluate(measureInPage);
        if (after.url !== before.url && new URL(after.url).origin !== origin) {
          await page.goto(url, { waitUntil: 'load', timeout: Math.min(15_000, left()) }).catch(() => {});
        } else {
          shifted(`clicking "${label}"`, before, after);
          if (after.fingerprint === before.fingerprint && after.url === before.url && after.text === before.text && consoleErrors.length === errors) {
            findings.push({ type: 'no-effect', class: 'improvement', title: `Clicking "${label}" changed nothing on the page`,
              detail: 'Nothing on the page, its address or its console changed after the click. It may act elsewhere (a download, the clipboard); otherwise it does nothing.' });
          }
        }
        clicked += 1;
      } catch { /* A control that cannot be clicked is skipped; the rest are still tried. */ }
    }
    if (clicked) ran.push(`clicked ${clicked} control${clicked === 1 ? '' : 's'}`);
    // A container that changed only because a chart inside it did is not named again.
    const containers = new Set([...shifts.values()].flatMap((shift) => shift.around ?? []));
    for (const shift of [...shifts.values()].filter((entry) => !containers.has(entry.key))) {
      const first = shift.actions[0];
      findings.push({ type: 'layout-shift', class: 'breaks-use',
        title: `${shift.what} changes size while the page is used`,
        detail: `${shift.actions.length === 1 ? 'It' : `${shift.actions.length} times, first`} ${first.action}: ${sizeWords(first.before)} became ${sizeWords(first.after)}.`,
        evidence: { element: shift.what, actions: shift.actions.slice(0, 6) } });
    }
    for (const error of consoleErrors) {
      findings.push({ type: error.uncaught ? 'page-error' : 'console-error', class: 'breaks-use',
        title: error.uncaught ? 'An uncaught error in the page' : 'An error in the browser console',
        detail: `${error.text}${error.during ? ` (while ${error.during})` : ''}`, evidence: { text: error.text, at: error.at ?? null, during: error.during ?? null } });
    }
    return { status: 'ran', missing: [], ran, findings, screenshots,
      observed: { url, inputs: typed, controls: clicked, ...(skipped.length ? { notClicked: skipped.slice(0, 10) } : {}), blockedHosts: [...blocked].slice(0, 20) } };
  } finally {
    await browser.close().catch(() => {});
  }
}
