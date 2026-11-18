/**
 * The Node a code step's tests run on, when the evidence names it [owner, 2026-11-13; 2026-11-18].
 *
 * A Node that does not suit the tests was a person's choice on the decision list: pin an installed one in `.nvmrc`
 * (node-pin.mjs). When the evidence already answers it, SFlow takes that answer before the tests run, at the version's
 * opening and again before its gate: it writes `.nvmrc` with that version and records it as settled with its evidence,
 * which also lists the file as a supporting change of the plan (plan-amendments.mjs). The evidence is one of:
 *   - the module's own package.json asks for a range exactly one installed major accepts (`source`);
 *   - the Node here is known to break what the tests use (Node 25 and later puts its own localStorage in front of Vitest's
 *     DOM environment) and an earlier Node is installed (`clash`);
 *   - an earlier Story of the same repository pinned that Node, and it is installed (`earlier`, node-pin-history.mjs);
 *   - SFlow's own check found the tests pass on it, on this same code (`tried`).
 * On Story new-ash-graph the same Node question, with Node 22 the only fit, was asked three times and cost an hour.
 * The decisions card shows it with an undo, which removes the file again when it still holds what SFlow wrote
 * (settled-decisions.mjs) and puts the choice back on the decision list. A version file already there, several earlier
 * pins that differ, or nothing that names one, stay the person's choice.
 */
import { lstat, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NODE_PIN_CLASS, NODE_PIN_FILE } from './node-pin-names.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { commitSettledDecision, nodePinBasis, nodeVersionSubject as subjectOf, settleableNodePin } from './settled-decisions.mjs';

// From the CLI source, out of the VS Code bundles: only a settlement or a person's pin reads or keeps the history.
const HISTORY = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'node-pin-history.mjs')).href;
const INSTALLED = { what: (node) => `Node ${node} is installed`, where: 'the Nodes installed on this machine' };

/**
 * The pin an earlier Story of this repository chose, when the offered one has no evidence of its own: every earlier pin
 * names one major, it is installed here and it is not the Node the tests failed on. Otherwise `pin` as it is.
 */
export async function withEarlierPin(root, workflow, pin, { earlier = null, installedOfMajor = null } = {}) {
  if (!pin || nodePinBasis(pin) || pin.replaces) return pin;
  const found = earlier ?? await (await import(HISTORY)).earlierStoryNodePins(root,
    { workId: workflow.workItem?.id ?? null, branch: workflow.workItem?.branch ?? null }).catch(() => []);
  const majors = new Set(found.map((entry) => entry.version));
  if (majors.size !== 1) return pin;
  const [version] = majors;
  if (String(pin.running ?? '').split('.')[0] === version) return pin;
  const node = await (installedOfMajor ?? (await import('./node-pin.mjs')).installedNodeOfMajor)(version).catch(() => null);
  return node ? { ...pin, version, node, earlier: found.filter((entry) => entry.version === version).slice(0, 3) } : pin;
}

/** The settled answer and its evidence, in words a person reads on the decisions card, for a settleable pin. */
export function nodeSettlement(phase, pin) {
  const step = phase.label ?? phase.id;
  const basis = nodePinBasis(pin);
  const running = pin.running ? [{ what: `tests would otherwise run on Node ${pin.running}`, where: 'the Node on PATH' }] : [];
  const pinned = `Pinned Node ${pin.version} in ${NODE_PIN_FILE} for ${step}'s tests`;
  if (basis === 'source') return { answer: `${pinned}: the repository asks for Node ${pin.source.range}, and Node ${pin.node} is the only installed Node it accepts.`,
    evidence: [{ what: `the repository asks for Node ${pin.source.range}`, where: `${pin.source.file} ${pin.source.field}` },
      { what: `Node ${pin.node} is the only installed major it accepts`, where: INSTALLED.where }, ...running] };
  if (basis === 'clash') return { answer: `${pinned}: Node ${pin.running ? `${pin.running} here` : 'here'} breaks tests that use localStorage under Vitest, and Node ${pin.node} is installed.`,
    evidence: [{ what: `Node ${pin.running ?? 'here'} puts its own localStorage in front of the DOM environment's under Vitest`, where: 'the repository\'s Vitest setup and its tests that use localStorage' },
      { what: INSTALLED.what(pin.node), where: INSTALLED.where }, ...running] };
  if (basis === 'earlier') return { answer: `${pinned}: an earlier Story of this repository pinned Node ${pin.version} for its tests, and Node ${pin.node} is installed.`,
    evidence: [...pin.earlier.map((entry) => ({ what: `Story ${entry.workId} pinned Node ${entry.version}`, where: entry.where })),
      { what: INSTALLED.what(pin.node), where: INSTALLED.where }, ...running] };
  return { answer: `${pinned}: SFlow ran them on Node ${pin.node} on this code and they pass.`,
    evidence: [{ what: String(pin.tried.words), where: 'singularity-flow tests node, on this code' }, ...running] };
}

/**
 * Settle the Node of an open code step's tests when the evidence names it: `.nvmrc` and its settled record, or null.
 * Never refuses: when it cannot write or record, nothing is left behind and the choice stays on the list.
 */
export async function settleRepositoryNode(root, config, workflow, phase, { actor, agent = null } = {}) {
  const { storyNodePin } = await import('./node-pin.mjs');
  const offered = await storyNodePin(root, config, workflow, phase).catch(() => null);
  const pin = await withEarlierPin(root, workflow, offered).catch(() => offered);
  if (!pin || !settleableNodePin(workflow, phase, pin)) return null;
  const file = path.join(root, NODE_PIN_FILE);
  if (await lstat(file).then(() => true, () => false)) return null;
  try { await writeFile(file, `${pin.version}\n`, { flag: 'wx' }); }
  catch { return null; }
  try {
    const { answer, evidence } = nodeSettlement(phase, pin);
    const { record } = await commitSettledDecision(root, config, workflow, {
      kind: 'node-version', by: 'sflow', phase: phase.id, subject: subjectOf(phase, pin), answer, evidence,
      effect: { file: NODE_PIN_FILE, version: pin.version, node: pin.node, class: NODE_PIN_CLASS }
    }, { actor, agent });
    // The next Story of this repository reads it as evidence (node-pin-history.mjs).
    await (await import(HISTORY)).keepNodePin(root, { version: pin.version, workId: workflow.workItem.id }).catch(() => {});
    return record;
  } catch {
    await rm(file, { force: true }).catch(() => null);
    return null;
  }
}
