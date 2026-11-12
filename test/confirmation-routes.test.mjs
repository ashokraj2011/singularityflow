/**
 * A Copilot route never drops a reviewed digest. `[agent-output]`
 *
 * `/sf-submit` looped on a Convergence advance: the confirm route was a bare skill that only
 * previewed the same digest again. 35 command families had the same shape. Every engine command
 * that confirms `--confirm sha256:<DIGEST>`, with nothing else left for a person to fill, now
 * carries that digest in its Copilot route; this scan keeps new ones from regressing. A route a person types
 * carries it as a short code (`/sf-confirm K7Q2-M8DX`, confirm-code.mjs) that stands for exactly that command.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { copilotCommandForCommand } from '../src/copilot-guidance.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { ownTerminalStep } from '../src/command-skills.mjs';
import { confirmCode, confirmCommandText, resolveConfirmCode } from '../src/confirm-code.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const digest = `sha256:${'d'.repeat(64)}`;

/** The `/sf-confirm` route a person types for `command`: its code, which this machine resolves to that exact command. */
function confirmRouteOf(command) {
  const route = `/sf-confirm ${confirmCode(command)}`;
  assert.equal(resolveConfirmCode(confirmCode(command))?.command, confirmCommandText(command), `${route} stands for ${command}`);
  return route;
}

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
    // Only a command no skill carries out has no route at all, so it drops no digest: a person's own
    // terminal step (an amendment's decision, setting a waiting commit aside).
    if (guidance.copilotCommand === null) {
      assert.ok(ownTerminalStep(command), `${file}: ${command} has no Copilot route`);
      continue;
    }
    checked.push(command);
    const code = guidance.copilotCommand.match(/^\/sf-confirm ([0-9A-Z]{4}-[0-9A-Z]{4})$/u)?.[1];
    assert.ok(guidance.copilotCommand.includes(digest) || resolveConfirmCode(code)?.command === confirmCommandText(command),
      `${file}: ${command}\n  routes to ${guidance.copilotCommand}`);
  }
  assert.ok(checked.length >= 25, `only ${checked.length} digest confirmations were found; the scan stopped matching`);
});

test('a confirmation the skill route already carries keeps that route; others run through /sf-confirm', () => {
  assert.equal(copilotCommandForCommand(`singularity-flow story advance --work-id W --confirm ${digest}`, '/sf-submit'),
    `/sf-submit --work-id W --confirm ${digest}`);
  assert.equal(copilotCommandForCommand(`singularity-flow auto resume W --confirm ${digest}`),
    `/sf-auto resume W --confirm ${digest}`);
  assert.equal(copilotCommandForCommand(`singularity-flow phase rollover implementation --confirm ${digest}`, '/sf-recover'),
    confirmRouteOf(`singularity-flow phase rollover implementation --confirm ${digest}`));
  assert.equal(copilotCommandForCommand(`singularity-flow decision plan W --confirm ${digest}`),
    confirmRouteOf(`singularity-flow decision plan W --confirm ${digest}`));
  // What a person reads names no digest: the route is eight characters, the same for --json or not.
  assert.match(copilotCommandForCommand(`singularity-flow decision plan W --confirm ${digest} --json`), /^\/sf-confirm [0-9A-Z]{4}-[0-9A-Z]{4}$/u);
  assert.equal(copilotCommandForCommand(`singularity-flow decision plan W --confirm ${digest} --json`), confirmRouteOf(`singularity-flow decision plan W --confirm ${digest}`));
  // A Work ID confirmation, a template still to fill, and shell operators keep the skill route.
  assert.equal(copilotCommandForCommand('singularity-flow cancel W --reason x --confirm W', '/sf-cancel'), '/sf-cancel');
  // A person's own terminal step has no route at all: /sf-decide refused it and pointed back to itself.
  assert.equal(copilotCommandForCommand(`singularity-flow upstream-issue decide-amendment U --decision <approve|reject> --confirm ${digest}`), null);
  assert.equal(copilotCommandForCommand(`singularity-flow story target-origin W --url https://staging.example.test --reason x --confirm ${digest}`), null);
  // A reviewed plan id is a digest too.
  assert.equal(copilotCommandForCommand('singularity-flow governance rebuild --confirm-plan grb-0123456789abcdef01234567'),
    confirmRouteOf('singularity-flow governance rebuild --confirm-plan grb-0123456789abcdef01234567'));
  assert.equal(copilotCommandForCommand(`singularity-flow phase rollover p --confirm ${digest}; rm -rf x`, '/sf-recover'), '/sf-recover');
});

test('/sf-confirm runs only the confirmation the person typed, by its code, once, and stops when it is unknown or stale', () => {
  const skill = readFileSync(path.join(root, 'plugin/skills/sflow-confirm/SKILL.md'), 'utf8');
  assert.match(skill, /Require `\$ARGUMENTS` to be one code like `K7Q2-M8DX`, or one SFlow command as an older route gave it/u);
  assert.match(skill, /Run `singularity-flow confirm <CODE> --for-agent --json` \(or `singularity-flow \$ARGUMENTS` for a command\) once/u);
  assert.match(skill, /Never edit it, preview again first or retry/u);
  assert.match(skill, /the code is unknown or the confirmation stale: show the fresh review it returns, or run its next action to show the preview again, and stop/u);
});

test('a route recorded before short codes still validates, and is given as its code', () => {
  const command = `singularity-flow phase rollover implementation --confirm ${digest}`;
  const recorded = safeCommandGuidance({ command, copilotCommand: `/sf-confirm phase rollover implementation --confirm ${digest}` });
  assert.equal(recorded?.copilotCommand, confirmRouteOf(command));
  // Any other supplied route still contradicts the canonical one.
  assert.equal(safeCommandGuidance({ command, copilotCommand: `/sf-confirm phase rollover other --confirm ${digest}` }), null);
});
