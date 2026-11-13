/**
 * The Node a code step's tests run on, when the repository names it [owner, 2026-11-13].
 *
 * A Node that does not suit the tests was a person's choice on the decision list: pin an installed one in `.nvmrc`
 * (node-pin.mjs). When the module's own package.json asks for a range that exactly one installed major accepts, the
 * repository has answered already, so SFlow takes that same answer before the tests run: it writes `.nvmrc` with that
 * version and records it as settled with its evidence, which also lists the file as a supporting change of the plan
 * (plan-amendments.mjs). The decisions card shows it with an undo, which removes the file again when it still holds
 * what SFlow wrote (settled-decisions.mjs) and puts the choice back on the decision list. A version file already there, a range several
 * installed Nodes satisfy, or none, stay the person's choice.
 */
import { lstat, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NODE_PIN_CLASS, NODE_PIN_FILE } from './node-pin-names.mjs';
import { commitSettledDecision, nodeVersionSubject as subjectOf, settleableNodePin } from './settled-decisions.mjs';

/**
 * Settle the Node of an open code step's tests when the repository names it: `.nvmrc` and its settled record, or
 * null. Never refuses: when it cannot write or record, nothing is left behind and the choice stays on the list.
 */
export async function settleRepositoryNode(root, config, workflow, phase, { actor, agent = null } = {}) {
  const { storyNodePin } = await import('./node-pin.mjs');
  const pin = await storyNodePin(root, config, workflow, phase).catch(() => null);
  if (!pin || !settleableNodePin(workflow, phase, pin)) return null;
  const file = path.join(root, NODE_PIN_FILE);
  if (await lstat(file).then(() => true, () => false)) return null;
  try { await writeFile(file, `${pin.version}\n`, { flag: 'wx' }); }
  catch { return null; }
  try {
    const { record } = await commitSettledDecision(root, config, workflow, {
      kind: 'node-version', by: 'sflow', phase: phase.id, subject: subjectOf(phase, pin),
      answer: `Pinned Node ${pin.version} in ${NODE_PIN_FILE} for ${phase.label ?? phase.id}'s tests: the repository asks for Node ${pin.source.range}, and Node ${pin.node} is the only installed Node it accepts.`,
      evidence: [
        { what: `the repository asks for Node ${pin.source.range}`, where: `${pin.source.file} ${pin.source.field}` },
        { what: `Node ${pin.node} is the only installed major it accepts`, where: 'the Nodes installed on this machine' },
        ...(pin.running ? [{ what: `tests would otherwise run on Node ${pin.running}`, where: 'the Node on PATH' }] : [])
      ],
      effect: { file: NODE_PIN_FILE, version: pin.version, node: pin.node, class: NODE_PIN_CLASS }
    }, { actor, agent });
    return record;
  } catch {
    await rm(file, { force: true }).catch(() => null);
    return null;
  }
}
