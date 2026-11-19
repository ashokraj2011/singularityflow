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
 * (settled-decisions.mjs) and puts the choice back on the decision list. Several earlier pins that differ, or nothing
 * that names one, stay the person's choice.
 *
 * Two more answers are SFlow's, never a question [owner, 2026-11-19, "SFlow prepares the code environment"]:
 *   - several installed Nodes would suit (the package's range accepts more than one major, or the tests failed on the
 *     Node here): SFlow runs the tests once on each, newest first (`tests node`, on a throwaway copy, nothing recorded),
 *     and pins the first they pass on (`tried`);
 *   - `.nvmrc` asks for a Node that is not installed here, and another installed one is accepted by the package's range:
 *     this Story's tests run on that one, chosen the same way when there are several, and `.nvmrc` is not changed. The
 *     choice is kept beside the repository's Git data (project-node-version.mjs reads it), recorded as settled with its
 *     evidence, and undone on the decisions card like any other.
 * A person is asked only when no installed Node runs the tests; the check says how to install the one asked for.
 */
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { gitCommonDir } from './git.mjs';
import { NODE_PIN_CLASS, NODE_PIN_FILE } from './node-pin-names.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { NODE_OVERRIDES_FILE } from './project-node-version.mjs';
import { commitSettledDecision, nodePinBasis, nodeVersionSubject as subjectOf, settleableNodePin, settledFor, settlementState } from './settled-decisions.mjs';

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

/** How long one Node's check may take, and how many installed Nodes are tried, before a person is asked instead. */
export const PROBE_SECONDS = 120;
const MAX_PROBES = 3;
const majorOf = (version) => String(version ?? '').replace(/^v/u, '').split('.')[0];
const stderrLine = (line) => process.stderr.write(`${line}\n`);

/**
 * Run the step's tests once on each installed Node in `candidates`, newest first, until they pass on one:
 * `{ status: 'passed', version, node, words }`, `failed` when they pass on none, or `unknown` when a check could not
 * finish (it ran out of time, or found nothing to run). Records nothing; `probe` is `tests node` (commands/tests.mjs).
 */
export async function probeInstalledNodes(root, config, workflow, phase, candidates, { say = stderrLine, probe = null, seconds = PROBE_SECONDS } = {}) {
  // `tests node`, as the decisions card's own check runs it (decision-probes.mjs).
  const tryNode = probe ?? (await import('./commands/tests.mjs')).tryStoryNode;
  const { nodeProbeState, nodeTryWords } = await import('./node-pin.mjs');
  const step = phase.label ?? phase.id;
  const workId = workflow.workItem.id;
  const state = await nodeProbeState(root, config, workflow).catch(() => null);
  let prepared = false;
  for (const node of candidates.slice(0, MAX_PROBES)) {
    const version = majorOf(node);
    // A check already run on this same code is its answer: never run twice.
    const known = state ? await nodeTryWords(root, workId, version, { state }).catch(() => null) : null;
    if (known?.current && known.known) {
      if (known.passed) return { status: 'passed', version, node, words: known.words.replace(/; nothing was recorded as evidence\.$/u, '').replace(/\.$/u, '') };
      continue;
    }
    // The tests import the checkout's dependencies, which a new Story checkout does not have yet.
    if (!prepared) {
      prepared = true;
      await (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'repository-dependency-setup.mjs')).href))
        .prepareRepositoryDependencies(root, { config, say }).catch(() => null);
    }
    say(`Checking which installed Node ${step}'s tests pass on: Node ${node} (up to ${seconds} seconds; nothing is recorded)…`);
    const answer = await tryNode(root, { 'work-id': workId, phase: phase.id, node: version, within: String(seconds) }).catch(() => null);
    const results = answer?.results ?? [];
    if (!results.length || results.some((entry) => entry.status === 'not-run')) return { status: 'unknown' };
    if (results.every((entry) => entry.status === 'passed')) {
      const counts = results.map((entry) => (entry.tests ? `${entry.tests.passed} of ${entry.tests.discovered} passed` : 'passed')).join(', ');
      return { status: 'passed', version, node: answer.node ?? node, words: `It passes on Node ${answer.node ?? node} (${counts}), on a throwaway copy of this checkout` };
    }
  }
  return { status: 'failed' };
}

const overridesFile = (root) => path.join(gitCommonDir(root), ...NODE_OVERRIDES_FILE);

/** Keep this Story's settled Node for its version file, or with `drop` remove it; returns whether the file changed. */
async function writeNodeOverride(root, { workId, file, wanted = null, version = null, branch = null }, { drop = false } = {}) {
  const target = overridesFile(root);
  const kept = await readFile(target, 'utf8').then(JSON.parse, () => null);
  const before = Array.isArray(kept?.overrides) ? kept.overrides : [];
  const overrides = before.filter((entry) => !(entry?.workId === workId && entry?.file === file));
  if (!drop) overrides.push({ file, wanted, version: String(version), workId: String(workId).slice(0, 128), branch, at: new Date().toISOString() });
  if (drop && overrides.length === before.length) return false;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const record = {
    schemaVersion: 1, // schema-transient: machine-local; an unreadable or older file is read as no settlement
    overrides: overrides.slice(-50)
  };
  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return true;
}

/** After a person undoes a Node settled for the Story's tests alone: its kept entry goes, so the version file counts again. */
export async function dropNodeOverride(root, workflow, settled) {
  const override = settled?.effect?.override;
  if (!override?.file || !workflow?.workItem?.id) return false;
  return writeNodeOverride(root, { workId: workflow.workItem.id, file: override.file }, { drop: true });
}

/** The installed Node nearest to what the file asks for: the lowest major at or above it, else the highest below. */
function nearestNode(candidates, wanted) {
  const asked = Number(majorOf(wanted));
  const sorted = [...candidates].sort((left, right) => Number(majorOf(left)) - Number(majorOf(right)));
  return sorted.find((node) => Number(majorOf(node)) >= asked) ?? sorted.at(-1);
}

/**
 * `.nvmrc` asks for a Node not installed here, and `pin.candidates` are the installed ones the package accepts: this
 * Story's tests run on one of them, settled with its evidence and an undo, and the file is not changed. Null when none
 * runs the tests (a person installs the one asked for) or nothing could be recorded.
 */
async function settleNodeOverride(root, config, workflow, phase, pin, { actor, agent, say, probe }) {
  const step = phase.label ?? phase.id;
  const { file, replaces: wanted, candidates, range } = pin;
  const accepted = range ? `${range.file} accepts (${range.range})` : 'installed here';
  const workId = workflow.workItem.id;
  const branch = await import('./git.mjs').then(({ branch: current }) => current(root)).catch(() => workflow.workItem.branch ?? null);
  const states = candidates.map((node) => ({ node, version: majorOf(node) }))
    .map((entry) => ({ ...entry, state: settlementState(workflow, 'node-version', subjectOf(phase, entry)) }));
  // Settled already (on another laptop, whose kept entry is its own): the same answer is kept here too, nothing asked again.
  const standing = states.find((entry) => entry.state === 'settled');
  if (standing) {
    await writeNodeOverride(root, { workId, file, wanted, version: standing.version, branch });
    return settledFor(workflow, 'node-version', subjectOf(phase, standing));
  }
  // A person undid it: theirs to answer.
  if (states.some((entry) => entry.state === 'undone')) return null;
  let chosen = null;
  let reason = null;
  if (candidates.length === 1) {
    chosen = { node: candidates[0], version: majorOf(candidates[0]) };
    reason = { words: `Node ${chosen.node} is the only installed Node ${range ? `${range.file} accepts` : 'here'}`,
      evidence: { what: `Node ${chosen.node} is the only installed Node ${range ? `that ${range.file} accepts (${range.range})` : 'here'}`, where: range ? `${range.file} engines.node` : INSTALLED.where } };
  } else {
    const found = await probeInstalledNodes(root, config, workflow, phase, candidates, { say, probe });
    if (found.status === 'failed') return null;
    if (found.status === 'passed') {
      chosen = found;
      reason = { words: `SFlow ran them on Node ${found.node} on this code and they pass`, evidence: { what: found.words, where: 'singularity-flow tests node, on this code' } };
    } else {
      const node = nearestNode(candidates, wanted);
      chosen = { node, version: majorOf(node) };
      reason = { words: `Node ${node} is the installed Node nearest to it that is ${accepted}`, evidence: { what: `Node ${node} is the installed Node nearest to Node ${wanted} that is ${accepted}`, where: INSTALLED.where } };
    }
  }
  const subject = subjectOf(phase, chosen);
  if (settlementState(workflow, 'node-version', subject) !== 'open') return null;
  const entry = { workId, file, wanted, version: chosen.version, branch };
  await writeNodeOverride(root, entry);
  try {
    const { record } = await commitSettledDecision(root, config, workflow, {
      kind: 'node-version', by: 'sflow', phase: phase.id, subject,
      answer: `Running ${step}'s tests on Node ${chosen.node} for this Story: ${file} asks for Node ${wanted}, which is not installed here, and ${reason.words}. ${file} is not changed.`,
      evidence: [{ what: `${file} asks for Node ${wanted}`, where: file }, { what: `Node ${wanted} is not installed here`, where: INSTALLED.where }, reason.evidence],
      effect: { override: { file, wanted }, version: chosen.version, node: chosen.node }
    }, { actor, agent });
    say(`Using Node ${chosen.node} for this Story's tests: ${file} asks for Node ${wanted}, which is not installed here (${file} is not changed). `
      + `Undo it on the decisions card: singularity-flow decisions ${workId}`);
    return record;
  } catch {
    await writeNodeOverride(root, entry, { drop: true }).catch(() => null);
    return null;
  }
}

/**
 * Settle the Node of an open code step's tests when the evidence names it: `.nvmrc` and its settled record, or null.
 * Never refuses: when it cannot write or record, nothing is left behind and the choice stays on the list. `say` hears
 * one line for each check it runs and for what it settled; `probe` stands in for `tests node` in tests.
 */
export async function settleRepositoryNode(root, config, workflow, phase, { actor, agent = null, say = stderrLine, probe = null } = {}) {
  const { storyNodePin } = await import('./node-pin.mjs');
  const offered = await storyNodePin(root, config, workflow, phase).catch(() => null);
  if (offered?.replaces && offered.candidates?.length) {
    return settleNodeOverride(root, config, workflow, phase, offered, { actor, agent, say, probe }).catch(() => null);
  }
  let pin = await withEarlierPin(root, workflow, offered).catch(() => offered);
  // Installed Nodes that would do, and nothing names one: the tests say which, newest first.
  if (pin && !nodePinBasis(pin) && !pin.replaces && pin.candidates?.length
      && settlementState(workflow, 'node-version', subjectOf(phase, pin)) === 'open') {
    const found = await probeInstalledNodes(root, config, workflow, phase, pin.candidates, { say, probe }).catch(() => null);
    if (found?.status === 'passed') pin = { ...pin, version: found.version, node: found.node, tried: { current: true, known: true, passed: true, words: found.words } };
  }
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
    say(`${answer} Undo it on the decisions card: singularity-flow decisions ${workflow.workItem.id}`);
    return record;
  } catch {
    await rm(file, { force: true }).catch(() => null);
    return null;
  }
}
