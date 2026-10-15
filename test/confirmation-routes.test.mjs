/**
 * A Copilot route never drops a reviewed digest. `[agent-output]`
 *
 * `/sf-submit` looped on a Convergence advance: the confirm route was a bare skill that only
 * previewed the same digest again. 35 command families had the same shape. Every engine command
 * that confirms `--confirm sha256:<DIGEST>`, with nothing else left for a person to fill, now
 * carries that digest in its Copilot route; this scan keeps new ones from regressing.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { copilotCommandForCommand } from '../src/copilot-guidance.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const digest = `sha256:${'d'.repeat(64)}`;

function sources(directory) {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    return statSync(file).isDirectory() ? sources(file) : file.endsWith('.mjs') ? [file] : [];
  });
}

/** Every `singularity-flow … --confirm …` template the engine renders, with sample values filled in. */
function confirmTemplates() {
  const found = new Map();
  for (const file of sources(path.join(root, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/`(singularity-flow [^`\n]*--confirm[^`\n]*)`/gu)) {
      const command = match[1]
        .replace(/--confirm(-plan)? (?:sha256:)?\$\{[^}]*\}(?:\$\{[^}]*\})?/gu, `--confirm$1 ${digest}`)
        .replace(/\$\{[^}]*\}/gu, 'W1')
        .trim();
      found.set(command, path.relative(root, file));
    }
  }
  return found;
}

test('every reviewed-digest confirmation route carries its digest, through the exact command', () => {
  const templates = confirmTemplates();
  const checked = [];
  for (const [command, file] of templates) {
    // A template a person still fills (`<reason>`, `<approve|reject>`) routes to the skill that collects it.
    if (!command.includes(digest) || /[<>|]/u.test(command)) continue;
    const guidance = safeCommandGuidance({ command });
    if (!guidance) continue;
    checked.push(command);
    assert.ok(guidance.copilotCommand.includes(digest), `${file}: ${command}\n  routes to ${guidance.copilotCommand}`);
  }
  assert.ok(checked.length >= 25, `only ${checked.length} digest confirmations were found; the scan stopped matching`);
});

test('a confirmation the skill route already carries keeps that route; others run through /sf-confirm', () => {
  assert.equal(copilotCommandForCommand(`singularity-flow story advance --work-id W --confirm ${digest}`, '/sf-submit'),
    `/sf-submit --work-id W --confirm ${digest}`);
  assert.equal(copilotCommandForCommand(`singularity-flow auto resume W --confirm ${digest}`),
    `/sf-auto resume W --confirm ${digest}`);
  assert.equal(copilotCommandForCommand(`singularity-flow phase rollover implementation --confirm ${digest}`, '/sf-recover'),
    `/sf-confirm phase rollover implementation --confirm ${digest}`);
  assert.equal(copilotCommandForCommand(`singularity-flow decision plan W --confirm ${digest}`),
    `/sf-confirm decision plan W --confirm ${digest}`);
  // A Work ID confirmation, a template still to fill, and shell operators keep the skill route.
  assert.equal(copilotCommandForCommand('singularity-flow cancel W --reason x --confirm W', '/sf-cancel'), '/sf-cancel');
  assert.doesNotMatch(copilotCommandForCommand(`singularity-flow upstream-issue decide-amendment U --decision <approve|reject> --confirm ${digest}`), /^\/sf-confirm/u);
  // A reviewed plan id is a digest too.
  assert.equal(copilotCommandForCommand('singularity-flow governance rebuild --confirm-plan grb-0123456789abcdef01234567'),
    '/sf-confirm governance rebuild --confirm-plan grb-0123456789abcdef01234567');
  assert.equal(copilotCommandForCommand(`singularity-flow phase rollover p --confirm ${digest}; rm -rf x`, '/sf-recover'), '/sf-recover');
});

test('/sf-confirm runs only an exact digest confirmation, once, and stops on a stale digest', () => {
  const skill = readFileSync(path.join(root, 'plugin/skills/sflow-confirm/SKILL.md'), 'utf8');
  assert.match(skill, /carrying `--confirm sha256:<DIGEST>` or `--confirm-plan sha256:<DIGEST>`/u);
  assert.match(skill, /Run `singularity-flow \$ARGUMENTS` once/u);
  assert.match(skill, /Never edit the digest, preview again first or retry/u);
  assert.match(skill, /digest is stale: show the fresh review it returns and stop/u);
});
