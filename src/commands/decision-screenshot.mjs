/**
 * `decision screenshot`: a person brings up the screen a visual criterion is about and SFlow captures it, for a
 * sign-off whose plan names no screenshot file [owner, 2026-11-18]. See src/visual-sign-off-capture.mjs.
 *
 *   singularity-flow decision screenshot [WORK-ID] --criterion CLAUSE --slot SLOT [--replace] [--wait SECONDS] [--json]
 *
 * SFlow builds what the step published, opens it in its own browser with a bar naming the criterion and the screen the
 * plan says it shows, and waits for the person to click "Capture this screen". It records nothing: the person then looks
 * at the screenshot and signs it off (`decision witness`, or the Decide card). A person's own step: the Decide card's
 * "Take the screenshot" runs it, as does their terminal; the Copilot guard refuses it in a chat turn
 * (OWN_TERMINAL_STEPS), since it waits for the person at the browser.
 */
import { repoRoot } from '../git.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

export async function decisionScreenshotCommand(positionals, options) {
  const root = repoRoot();
  const workId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  const clauseId = String(optionString(options, 'criterion') ?? '').toUpperCase();
  const slot = optionString(options, 'slot') ?? '';
  if (!clauseId || !slot) {
    throw new SingularityFlowError('Name the criterion and its visual slot: --criterion CLAUSE --slot SLOT, as the sign-off on the Decide card names them.',
      { code: 'VISUAL_SIGN_OFF_INVALID', details: { nextAction: { command: `singularity-flow decisions${workId ? ` ${workId}` : ''}`, label: 'The decision list names each sign-off with its criterion and slot.' } } });
  }
  const wait = Number(optionString(options, 'wait') ?? 600);
  const json = optionBoolean(options, 'json');
  if (!json) console.log(`Building what was published and opening it in SFlow's browser. Bring up the screen ${clauseId} is about, then click "Capture this screen" on SFlow's bar.`);
  const { visualSignOffCapture } = await import('../verification/witness-records.mjs');
  const result = await (await visualSignOffCapture()).takeSignOffCapture(root, { workId, clauseId, slot, again: optionBoolean(options, 'replace'),
    wait: Number.isInteger(wait) && wait >= 10 ? Math.min(wait, 3600) : 600 });
  if (!json) {
    console.log(result.reused ? `${result.file} is already this change's screenshot for ${clauseId}; --replace takes another.`
      : `Saved ${result.file}. Look at it and sign it off on the Decide card, or with singularity-flow decision witness.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.screenshot', classification: 'mutation' },
    subject: { kind: 'story', id: workId ?? null },
    outcome: succeeded('decision.screenshot.succeeded', { file: result.file }),
    effects: effects({ stateChanged: false, filesChanged: !result.reused, publicationCreated: false }),
    data: { file: result.file, reused: result.reused, criterion: clauseId, slot, ...(result.screen ? { screen: result.screen } : {}), ...(result.build ? { build: result.build } : {}) }
  }), { json });
}
