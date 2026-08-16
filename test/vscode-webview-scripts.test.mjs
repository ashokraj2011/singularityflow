/**
 * Every browser script a panel injects is valid JavaScript. `[UXH:REQ-134]`
 *
 * This exists because of a defect that nothing else here could see. `capability-page.ts` built a
 * chunk of HTML as a single-quoted JavaScript string and interpolated an icon into it; the icons are
 * multi-line SVG, and a raw newline inside a single-quoted string is a syntax error. The page still
 * rendered perfectly — the markup is produced by a different function — so the screen looked right
 * and every control on it was dead, because a syntax error takes the whole script rather than the
 * statement that caused it. "Add a capability does nothing" and "clicking a capability does nothing"
 * were one bug wearing two faces.
 *
 * Type checking cannot catch it: to `tsc` these are ordinary template literals, and their contents
 * are just text. The markup tests cannot catch it either, because the markup was never wrong. The
 * only thing that catches it is asking a JavaScript parser, which is all this does.
 *
 * `new Function` parses without executing — there is no webview here, and running the body would
 * only prove that `document` is undefined.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'apps', 'vscode', 'src', 'views');

/** Every exported string whose name says it is a script, paired with where it came from. */
async function injectedScripts() {
  const found = [];
  for (const entry of (await readdir(views)).filter((name) => name.endsWith('.ts')).sort()) {
    let module;
    // A view that cannot be imported on its own is not this test's subject; the extension test
    // covers loading, and swallowing that here keeps one failure from being reported as many.
    try {
      module = await import(path.join(views, entry));
    } catch {
      continue;
    }
    for (const [name, value] of Object.entries(module)) {
      if (typeof value === 'string' && /SCRIPT/i.test(name)) found.push({ entry, name, value });
    }
  }
  return found;
}

test('every script a panel injects into a webview parses', async () => {
  const scripts = await injectedScripts();
  // Without this the test passes loudest when it is finding nothing at all — a renamed export or a
  // moved directory would turn it into a green check over zero coverage.
  assert.ok(scripts.length >= 12, `expected the panel scripts, found ${scripts.length}`);

  const broken = [];
  for (const { entry, name, value } of scripts) {
    try {
      new Function(value);
    } catch (error) {
      broken.push(`${entry} :: ${name} — ${error.message}`);
    }
  }
  assert.deepEqual(broken, [], `panel scripts that do not parse:\n  ${broken.join('\n  ')}`);
});

test('no injected script closes the tag it is written into', async () => {
  /**
   * The sibling failure, and it survives a parser. A script is inlined between `<script>` tags, so
   * a `</script>` anywhere in its text ends the element early — the rest of the script becomes page
   * content, and the same silence follows. Valid JavaScript, dead page.
   */
  for (const { entry, name, value } of await injectedScripts()) {
    assert.doesNotMatch(value, /<\/script/i, `${entry} :: ${name} would close its own script tag`);
  }
});
