/**
 * What SFlow settles in a code step before its tests run and before anything is recorded as a departure
 * [owner, 2026-11-13]: the Node the repository names (node-version-settle.mjs), and, at the agent's prepublish and its
 * governed publish, a changed file outside the plan whose place is clear. Each is recorded as settled with its evidence and
 * listed on the decisions card with an undo; anything less clear is recorded as a departure a person decides, as before.
 *
 * Which files are clear [owner, 2026-11-19, C3]: only the classes out-of-plan-classes.mjs allows (a companion, test support
 * including a page object the repository's test configuration or its content shows, documentation, an ignore file, a
 * generated file whose source is planned), never a dependency, build, CI or runner configuration, governance metadata, a
 * sensitive path or anything that can change what the product does. A Story started before then (no `settling` pin) keeps
 * the one rule it started with: a file beside one a single row names. Never a file a person rejected or undid.
 */
import path from 'node:path';

import { coveringRow } from './out-of-plan-classes.mjs';

export { coveringRow };

const SECRET = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|[^/]+\.(?:pem|key|p12|pfx|keystore|jks))$/iu;

/** The settling pin a Story started with [C3]: 1 settles the classes above; none keeps the companion rule alone. */
export const OUT_OF_PLAN_SETTLING = 1;
export const outOfPlanSettling = (workflow) => Number(workflow?.resolution?.settling?.outOfPlan ?? 0) >= OUT_OF_PLAN_SETTLING;

/** What every settle site reads once: the plan, the vetoes, and what the files hold. */
async function settleContext(root, config, workflow, phase, files) {
  const [{ rejectedDeparturePaths, departuresWithStatus }, { loadActiveSpecRecords, mergePlannedClaimRecords }, { storyLocation }, { settledDecisions }] = await Promise.all([
    import('./departures.mjs'), import('./specifications.mjs'), import('./story-paths.mjs'), import('./settled-decisions.mjs')]);
  const plan = mergePlannedClaimRecords((await loadActiveSpecRecords(storyLocation(root, config, workflow.workItem.id).directory, workflow)).planned ?? []);
  const protectedPaths = [...(config.governance?.protectedPaths ?? []), ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])];
  const settled = settledDecisions(workflow).filter((entry) => entry.kind === 'plan-accounting');
  const fileOf = (entry) => entry.effect?.path ?? entry.effect?.file ?? String(entry.subject ?? '').replace(/^file:/u, '');
  const open = new Set(departuresWithStatus(workflow, { phaseId: phase.id }).filter((entry) => ['open', 'reopened'].includes(entry.status))
    .flatMap((entry) => entry.departure.paths ?? []));
  const context = { plan, phaseId: phase.id, protectedPaths, rejected: new Set(rejectedDeparturePaths(workflow, phase.id).keys()),
    undone: new Set(settled.filter((entry) => entry.undone).map(fileOf)), open };
  if (!outOfPlanSettling(workflow)) return context;
  const [{ readFileSync }, { alwaysLocalName }, { detectTestSupport }] = await Promise.all([import('node:fs'), import('./local-config-policy.mjs'),
    import('./test-support-detection.mjs')]);
  const head = (file) => { try { return readFileSync(path.join(root, ...file.split('/')), 'utf8').slice(0, 4096); } catch { return null; } };
  // A generated file's source: a planned path, or a file already settled into a row.
  const settledRows = new Map([...Object.entries(plan).flatMap(([clauseId, claim]) => (claim.expectedPaths ?? []).map((file) => [file, clauseId])),
    ...settled.filter((entry) => !entry.undone && entry.effect?.path && entry.effect?.clauseId).map((entry) => [entry.effect.path, entry.effect.clauseId])]);
  const testSupport = await detectTestSupport(root, workflow, files.filter((file) => !context.rejected.has(file) && !context.undone.has(file) && !open.has(file))).catch(() => new Map());
  return { ...context, alwaysLocal: (file) => { try { return alwaysLocalName(file); } catch { return false; } }, head, generatedPaths: await generatedAtBase(root, workflow), settledRows, testSupport };
}

/** The files the Story base's .gitattributes marks linguist-generated, exactly as named; empty on any doubt. */
async function generatedAtBase(root, workflow) {
  try {
    const base = workflow.workItem?.baseCommit;
    if (!base) return new Set();
    const { exactFileAtObject } = await import('./git.mjs');
    const text = exactFileAtObject(root, base, '.gitattributes', { maximumBytes: 256 * 1024 })?.toString('utf8') ?? '';
    return new Set(text.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)).filter(([file, ...attributes]) => file && !/[*?[]/u.test(file)
      && attributes.some((attribute) => attribute === 'linguist-generated' || attribute === 'linguist-generated=true')).map(([file]) => file.replace(/^\//u, '')));
  } catch { return new Set(); }
}

/**
 * Where each of `files` belongs, settled now [C3, WCB:REQ-010]. A file whose class places it (a companion, test support,
 * documentation, an ignore file, a generated file) is settled into the plan as before; every other file is taken up with
 * the step as changed outside the plan, with who changed it and, for Copilot, the reason it wrote in the step's document
 * (code-outside-plan.mjs). Returns `{ settled, person }`: the settlements recorded (or already standing), and each file
 * left for a person with its class: only one a person rejected or undid, one that already waits as a departure, or a
 * protected path. `reason`: the agent's own words, when it recorded the files itself (`departure record`), kept as one
 * more line of evidence. `takeUp`: only publication, whose document is final, and the agent's own `departure record` take a
 * file up; prepublish settles the clear classes alone. Never refuses: a settlement that cannot be written leaves its
 * question standing.
 */
export async function settleOutOfPlan(root, config, workflow, phase, files, { actor, agent = null, reason = null, takeUp: taking = true, claimedBy = null } = {}) {
  const settled = [];
  const person = [];
  if (!files.length) return { settled, person };
  const [{ settlementState, commitSettledDecision }, { outOfPlanPlace, personClass, sensitivePath }, outside] = await Promise.all([
    import('./settled-decisions.mjs'), import('./out-of-plan-classes.mjs'), import('./code-outside-plan.mjs')]);
  const context = await settleContext(root, config, workflow, phase, files);
  const pinned = outOfPlanSettling(workflow);
  // Who changed each file, and what Copilot wrote about it, read once [WCB:REQ-011, REQ-012].
  const [writers, { reasons, document }] = await Promise.all([outside.codeWriters(root, workflow, files).catch(() => new Map()),
    outside.stepDocumentReasons(root, config, workflow, phase)]);
  const guarded = context.protectedPaths.map((entry) => String(entry).replace(/\/$/u, ''));
  // Taken up with the step unless a person already has it, it is a protected path, a hard stop [WCB:REQ-001, REQ-010], or it is
  // shaped like a key or certificate, which SFlow never commits on its own.
  const takesUp = (file) => !context.rejected.has(file) && !context.undone.has(file) && !context.open.has(file) && !SECRET.test(file)
    && !guarded.some((entry) => file === entry || file.startsWith(`${entry}/`));
  const takeUp = async (file) => {
    // The agent's own `departure record` says it changed the file: Copilot's, with its reason, when no hook says so already.
    const recorded = writers.get(file) ?? { writer: 'person', basis: 'no-hook-records' };
    const writer = claimedBy === 'agent' && recorded.writer !== 'copilot' ? { writer: 'copilot', basis: 'agent-said' } : recorded;
    const settlement = outside.outsidePlanSettlement(file, { phase, stepName: phase.label ?? phase.id, writer, document,
      reason: reasons.get(file) ?? (writer.writer === 'copilot' ? reason : null),
      kind: personClass(file)?.class ?? (sensitivePath(file) ? 'sensitive' : 'behaviour') });
    const { record } = await commitSettledDecision(root, config, workflow, settlement, { actor, agent });
    settled.push(record);
  };
  for (const file of files) {
    let place;
    if (pinned) place = outOfPlanPlace(file, { ...context, reason });
    else {
      // The rule a Story started before 2026-11-19 keeps: a companion only, never a supporting file or a protected one.
      const { classifySupportingChange } = await import('./supporting-changes.mjs');
      const guarded = context.protectedPaths.map((entry) => String(entry).replace(/\/$/u, ''));
      const row = context.rejected.has(file) || SECRET.test(file) || classifySupportingChange(file).class
        || guarded.some((entry) => file === entry || file.startsWith(`${entry}/`)) ? null : coveringRow(context.plan, phase.id, file);
      place = row ? { settle: { class: 'companion', answer: `Accounted ${file} to ${row.clauseId}'s row, which names ${row.path} beside it.`,
        evidence: [{ what: `${row.clauseId}'s row names ${row.path}`, where: 'the approved plan' },
          { what: `${file} sits beside it with the same name`, where: path.posix.dirname(file) },
          { what: `no other row of ${phase.id} names a file of that name there`, where: 'the approved plan' }],
        effect: { clauseId: row.clauseId, path: file } } } : { person: { class: 'behaviour' } };
    }
    const standing = settlementState(workflow, 'plan-accounting', `file:${file}`) === 'open';
    if (place.settle && standing) {
      try {
        const { record } = await commitSettledDecision(root, config, workflow, { kind: 'plan-accounting', by: 'sflow', phase: phase.id, subject: `file:${file}`,
          answer: place.settle.answer, evidence: place.settle.evidence, effect: place.settle.effect }, { actor, agent });
        settled.push(record);
        if (place.settle.effect?.clauseId) context.settledRows?.set(file, place.settle.effect.clauseId);
        continue;
      } catch { /* Taken up below instead. */ }
    }
    if (!taking && standing && takesUp(file)) continue;
    if (standing && takesUp(file)) {
      try { await takeUp(file); continue; } catch { /* Settling is a convenience over the question it replaces: that question stands. */ }
    }
    person.push({ file, ...(place.person ?? { class: place.settle?.class ?? 'behaviour' }) });
  }
  return { settled, person };
}

/** Settle each changed file outside the plan, committed or not [WCB:REQ-010]; returns what was settled. */
async function settlePlanAccounting(root, config, workflow, phase, { actor, agent, takeUp }) {
  const files = await (await import('./code-outside-plan.mjs')).outsidePlanFiles(root, config, workflow, phase).catch(() => []);
  return (await settleOutOfPlan(root, config, workflow, phase, files, { actor, agent, takeUp })).settled;
}

/**
 * Settle before the step's tests and its departures; never refuses. `accounting`: the agent's prepublish, and every
 * publication [C3]: a companion was a person's question there before. `takeUp`: publication, which also takes up every other
 * file no plan row names, with who changed it and Copilot's reason from the now final document [WCB:REQ-010].
 */
export async function settleBeforePublication(root, config, workflow, phase, { actor, agent = null, accounting = false, takeUp = false, nodeSettled = false } = {}) {
  if (workflow.status !== 'in_progress' || phase?.generationIntent?.status !== 'open' || workflow.currentPhase !== phase.id) return { node: null, files: [] };
  // `nodeSettled`: the caller settled the Node already in this command (publish does, before its tests).
  const node = nodeSettled ? null : await (await import('./node-version-settle.mjs')).settleRepositoryNode(root, config, workflow, phase, { actor, agent }).catch(() => null);
  const files = accounting ? await settlePlanAccounting(root, config, workflow, phase, { actor, agent, takeUp }).catch(() => []) : [];
  return { node, files };
}
