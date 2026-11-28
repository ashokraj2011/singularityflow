/**
 * Code outside the plan [WCB, docs/SPEC-WCB-WATCH-CODE-BASE-v1.md]: owner, 2026-11-27, "If any code changes that was
 * not agreed upon in planning phase, surface it, let copilot explain if it has touched, add the reason in documents and
 * carry forward. If human has done, let them do it and move forward."
 *
 *   governedCodeBase   where a code step's first work interval starts: where code was last governed [REQ-008]
 *   codeCommittedWithoutCodeStep  code committed on a Story with no code step, its one stop [REQ-017]
 *   codeLeftInCheckout the code base files a Story with no code step leaves in the checkout, listed at its approval [REQ-017]
 *   outsidePlanFiles   a code step's changed application files no plan row names, committed or not [REQ-010]
 *   codeWriters        who left each file as it is now, from SFlow's hook records: Copilot or "you" [REQ-011]
 *   outsidePlanReasons the reasons Copilot wrote under "Changes outside the plan" in its step's document [REQ-012]
 *   outsidePlanSettlement  the settled decision that takes one file up with the step, nobody asked [REQ-010]
 *   personHeldFiles    the files a person already holds, which publication never takes up [REQ-010]
 *   outsidePlanPreview what publication will take up, as prepublish tells the author, and the reasons still owed [REQ-012]
 *   keepOutFiles       the files SFlow took up for the open code step that are still uncommitted: each can be kept out [REQ-015]
 *
 * Nothing here refuses, asks or holds. Records are evidence, never proof: a file no record explains is "by you".
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { applicationPathContext, isApplicationChangePath } from './application-paths.mjs';
import { isWorkspaceLocalPath } from './workspace-local-paths.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { openScopeAppeal } from './phase-finding-policy.mjs';
import { outsidePlanWho } from './outside-plan-words.mjs';
import { posix } from './util.mjs';

/**
 * The commit a code step's first work interval starts from [WCB:REQ-008]: the latest published commit of an earlier code
 * step, else the Story's base, when a commit since then changed an application file (code committed while a document
 * step was open), so the code step's change set holds it and its clause and test checks cover it. Null otherwise: the
 * interval starts at HEAD, as it always did.
 */
export async function governedCodeBase(root, config, workflow, phase) {
  if (!phaseRequiresCodeDelivery(phase) || Number(phase?.generation ?? 0) > 0 || phase?.generationIntent) return null;
  try {
    const [{ commitIsAncestor, committedChangedPaths, head }, { publishedGenerationCommit }] = await Promise.all([
      import('./git.mjs'), import('./generation-publication-store.mjs')]);
    const order = workflow.phaseOrder ?? [];
    const earlier = order.slice(0, Math.max(0, order.indexOf(phase.id))).map((id) => workflow.phases?.[id])
      .filter((step) => phaseRequiresCodeDelivery(step) && Number(step?.generation ?? 0) > 0);
    let base = workflow.workItem?.baseCommit ?? null;
    const last = earlier.at(-1);
    if (last) {
      try { base = publishedGenerationCommit(root, workflow, last, last.generation) ?? base; } catch { /* The Story's base. */ }
    }
    const current = head(root);
    if (!base || base === current || !commitIsAncestor(root, base, current)) return null;
    const context = applicationPathContext(config, workflow);
    const code = committedChangedPaths(root, base).filter((file) => !isWorkspaceLocalPath(file) && isApplicationChangePath(file, context));
    return code.length ? base : null;
  } catch { return null; }
}

/**
 * The changed application files of a code step's open generation that its candidate does not take, committed since the
 * generation's baseline or only in this checkout, without workspace-local files [WCB:REQ-002, REQ-010]. Empty when the
 * Story plans no claims (every change is the candidate) or the generation is not open.
 */
export async function outsidePlanFiles(root, config, workflow, phase) {
  // Only the step's own open code generation, read as an appeal reads it (phase-finding-policy.mjs).
  const baseline = phase && openScopeAppeal(workflow, phase, phaseRequiresCodeDelivery(phase)) ? phase.generationIntent.baseline?.commit : null;
  if (!baseline) return [];
  const [{ codeCandidateScope, unreconciledCandidatePaths }, { storyLocation }, { committedChangedPaths }] = await Promise.all([
    import('./candidate-scope.mjs'), import('./story-paths.mjs'), import('./git.mjs')]);
  const scope = await codeCandidateScope(storyLocation(root, [config, workflow], workflow.workItem.id).directory, workflow, phase);
  if (!scope) return [];
  const context = applicationPathContext(config, workflow);
  const committed = committedChangedPaths(root, baseline)
    .filter((file) => !isWorkspaceLocalPath(file) && isApplicationChangePath(file, context) && !scope.allows(file));
  const dirty = await unreconciledCandidatePaths(root, config, workflow, phase, scope);
  return [...new Set([...committed, ...dirty])].sort();
}

/**
 * The files of a code step a person already holds [WCB:REQ-010]: a departure they rejected (its author restores it), a
 * settlement of it they undid (theirs to answer), or a departure still waiting for them. Publication never takes these up.
 */
export async function personHeldFiles(workflow, phaseId) {
  const [{ departuresWithStatus, rejectedDeparturePaths }, { settledDecisions }] = await Promise.all([
    import('./departures.mjs'), import('./settled-decisions.mjs')]);
  const undone = settledDecisions(workflow).filter((entry) => entry.kind === 'plan-accounting' && entry.undone)
    .map((entry) => entry.effect?.path ?? entry.effect?.file ?? String(entry.subject ?? '').replace(/^file:/u, ''));
  const waiting = departuresWithStatus(workflow, { phaseId }).filter((entry) => ['open', 'reopened'].includes(entry.status))
    .flatMap((entry) => entry.departure.paths ?? []);
  return new Set([...rejectedDeparturePaths(workflow, phaseId).keys(), ...undone, ...waiting]);
}

const digestOf = (value) => (typeof value === 'string' ? value.replace(/^sha256:/u, '') : null);
const agentOf = (writer) => (writer?.agent ? { agent: String(writer.agent).slice(0, 80) } : {});
// A shell record from before SF Guard kept its start: the minute before it ended stands for it (presence/reconcile.mjs).
const SHELL_SKEW_MS = 2000;
const LEGACY_SHELL_WINDOW_MS = 60_000;

/**
 * The files among `files` that hold exactly what the Story's base branch has, brought in by a merge or pull of it since
 * the Story began (git mergedBaseChanges): `file -> { branch, commit }`. Their change came with the base branch, not from
 * this Story. Empty when nothing newer was merged, or on any doubt.
 */
async function mergedFromBase(root, config, workflow, files) {
  const branch = workflow?.workItem?.baseBranch;
  const start = workflow?.workItem?.baseCommit;
  const found = new Map();
  if (!branch || !start || !files.length) return found;
  try {
    const { mergedBaseChanges } = await import('./git.mjs');
    for (const ref of [`refs/remotes/${config?.git?.remote ?? 'origin'}/${branch}`, `refs/heads/${branch}`]) {
      const merged = mergedBaseChanges(root, { startCommit: start, baseRefs: [ref], paths: files.filter((file) => !found.has(file)) });
      for (const file of merged?.paths ?? []) found.set(file, { branch, commit: merged.commit });
    }
  } catch { /* Not known to be the base branch's: read as any other file. */ }
  return found;
}

/**
 * Copilot's terminal commands SF Guard's hooks recorded in this checkout for this Story (preToolUse notes the call and its
 * start, postToolUse its end), since the Story began: each `{ writer, started, ended }`. A call another Story's turn ran is
 * not read; one a person refused never ran.
 */
async function copilotShellCalls(root, workflow, since) {
  try {
    const { readSfGuardShellRecords } = await import('./comprehension/xpl2/sf-guard-recorder.mjs');
    return (await readSfGuardShellRecords(root)).filter((record) => record?.ran === true && /^copilot-/u.test(String(record.writer?.kind ?? ''))
      && (!record.subject?.workId || record.subject.workId === workflow?.workItem?.id) && !(Date.parse(record.recordedAt) < since))
      .map((record) => {
        const ended = Date.parse(record.recordedAt);
        return { writer: record.writer, ended, started: record.startedAt ? Date.parse(record.startedAt) : ended - LEGACY_SHELL_WINDOW_MS };
      }).filter((call) => Number.isFinite(call.ended) && Number.isFinite(call.started));
  } catch { return []; }
}

/**
 * Why no record names a file's writer, when no Copilot write explains it: `not-recorded` when SFlow's hooks ran for this
 * Story here (a recorded write, a terminal command or a prompt), else `linked-folder` when VS Code opened this checkout
 * through a link, where Copilot runs no hooks (copilot-chat-hooks.mjs), else `no-hook-records`.
 */
async function noRecordBasis(repository, read, shells, workflow) {
  if (read?.status === 'available' || shells.length) return 'not-recorded';
  try {
    const { readPromptLog } = await import('./plain-chat-prompts.mjs');
    if (repository && workflow?.workItem?.id && (await readPromptLog(repository.commonDir, { workId: workflow.workItem.id, limit: 1 })).length) return 'not-recorded';
  } catch { /* No prompt log: no prompt hook ran. */ }
  try {
    const { vscodeLinkedOpenings } = await import('./copilot-chat-hooks.mjs');
    if (repository && vscodeLinkedOpenings(repository.root).length) return 'linked-folder';
  } catch { /* Unknown: said plainly as no hook records. */ }
  return 'no-hook-records';
}

/**
 * Who left each file as it is now [WCB:REQ-011], from SFlow's own hook records: `copilot` when a recorded Copilot write left
 * the bytes the file holds now (an edit, `recorded-write`; a terminal command the guard saw change it in an SFlow turn,
 * `shell-write`), or when SF Guard recorded a Copilot terminal command running as the file last changed (`shell-call`);
 * `base` when the file holds exactly what the base branch has, merged in since the Story began (`merged-from-base`): not this
 * Story's change; `person` otherwise, with its basis: `changed-after-copilot`, `not-recorded` (hooks ran here, and recorded
 * no Copilot change of this file), `linked-folder` (VS Code opened this checkout through a link, so no hook ran) or
 * `no-hook-records` (no hook ran here: an IDE's local agent, a terminal). A checkout reached through a link is read at its
 * real path, where the hooks that ran wrote. Writes from before the Story began are not read. `config` names the remote.
 * Never throws: an unreadable store reads as no hook records.
 */
export async function codeWriters(root, workflow, files, { config = null } = {}) {
  const writers = new Map();
  const wanted = [...new Set(files ?? [])];
  if (!wanted.length) return writers;
  const [{ sfGuardRepository }, { readObservedWrites }, { fileEvidence }] = await Promise.all([
    import('./comprehension/xpl2/sf-guard-recorder.mjs'), import('./comprehension/xpl2/observed-writes.mjs'), import('./work-intervals.mjs')]);
  const real = await realpath(path.resolve(root)).catch(() => path.resolve(root));
  const repository = await sfGuardRepository(real).catch(() => null);
  const read = repository ? await readObservedWrites(repository.gitDir, { paths: wanted }).catch(() => null) : null;
  const since = Date.parse(workflow?.workItem?.createdAt ?? workflow?.history?.[0]?.at ?? '');
  const fromStory = (at) => !Number.isFinite(since) || !(Date.parse(at) < since);
  const records = (read?.records ?? []).filter((record) => record?.source === 'copilot-hook' && /^copilot-/u.test(String(record.writer?.kind ?? ''))
    && fromStory(record.recordedAt));
  const now = new Map((await fileEvidence(real, wanted).catch(() => [])).map((entry) => [entry.path, entry.status === 'deleted' ? 'absent' : entry.sha256]));
  let fromBase = null;
  let shells = null;
  let unrecorded = null;
  for (const file of wanted) {
    const writes = records.flatMap((record) => (record.files ?? []).filter((entry) => entry?.path === file).map((entry) => ({ record, entry })));
    const left = now.get(file) ? writes.filter(({ entry }) => digestOf(entry.after) === now.get(file)) : [];
    if (left.length) {
      const { record } = left.at(-1);
      writers.set(file, { writer: 'copilot', basis: record.tool === 'shell' ? 'shell-write' : 'recorded-write', ...agentOf(record.writer),
        recordedAt: record.recordedAt ?? null });
      continue;
    }
    fromBase ??= await mergedFromBase(real, config, workflow, wanted);
    if (fromBase.has(file)) {
      writers.set(file, { writer: 'base', basis: 'merged-from-base', ...fromBase.get(file) });
      continue;
    }
    shells ??= await copilotShellCalls(real, workflow, Number.isFinite(since) ? since : -Infinity);
    const changedAt = shells.length && now.get(file) !== 'absent' ? (await lstat(path.join(real, file)).catch(() => null))?.mtimeMs : null;
    const call = Number.isFinite(changedAt) ? shells.findLast((entry) => changedAt >= entry.started - SHELL_SKEW_MS && changedAt <= entry.ended + SHELL_SKEW_MS) : null;
    if (call) {
      writers.set(file, { writer: 'copilot', basis: 'shell-call', ...agentOf(call.writer), recordedAt: new Date(call.ended).toISOString() });
      continue;
    }
    if (!writes.length) unrecorded ??= await noRecordBasis(repository, read, shells, workflow);
    writers.set(file, { writer: 'person', basis: writes.length ? 'changed-after-copilot' : unrecorded });
  }
  return writers;
}

const OUTSIDE_PLAN_HEADING = /changes?\s+outside\s+(?:of\s+)?(?:the\s+)?plan/iu;

/**
 * The reasons Copilot wrote in its step's document [WCB:REQ-012]: under a heading `Changes outside the plan` (any level),
 * each line naming a file in backticks, then why, as a list item or a table row. A Map of file to reason; guidance
 * comments, table headers and lines naming no file are skipped.
 */
export function outsidePlanReasons(text) {
  const reasons = new Map();
  let level = 0;
  let comment = false;
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    if (comment) { if (line.includes('-->')) comment = false; continue; }
    if (/^\s*<!--/u.test(line)) { comment = !line.includes('-->'); continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading) {
      if (OUTSIDE_PLAN_HEADING.test(heading[2])) level = heading[1].length;
      else if (level && heading[1].length <= level) level = 0;
      continue;
    }
    if (!level) continue;
    const named = /`([^`\n]+)`/u.exec(line);
    if (!named) continue;
    const file = posix(named[1].trim()).replace(/^\.\//u, '');
    const why = line.slice(named.index + named[0].length).replace(/\|/gu, ' ').replace(/^[\s:;,.\-–—]+/u, '').replace(/\s+/gu, ' ').trim();
    if (file && why && !reasons.has(file)) reasons.set(file, why.slice(0, 400));
  }
  return reasons;
}

/** The reasons in a code step's own document, read from the checkout; empty when it cannot be read. */
export async function stepDocumentReasons(root, config, workflow, phase) {
  try {
    const { storyLocation } = await import('./story-paths.mjs');
    const relative = phase?.requiredArtifact?.path;
    if (!relative) return { reasons: new Map(), document: null };
    const location = storyLocation(root, [config, workflow], workflow.workItem.id);
    return { reasons: outsidePlanReasons(await readFile(location.file(relative), 'utf8')), document: storyLocation(null, [config, workflow], workflow.workItem.id).record(relative) };
  } catch { return { reasons: new Map(), document: null }; }
}

const BASIS_WORDS = Object.freeze({
  'recorded-write': 'SFlow\'s hook recorded Copilot writing it as it is now',
  'shell-write': 'SFlow\'s hook saw a Copilot terminal command leave it as it is now',
  'shell-call': 'SFlow\'s hook recorded a Copilot terminal command running when it last changed',
  'agent-said': 'the agent recorded that it changed it (departure record)',
  'changed-after-copilot': 'Copilot wrote it, and it changed again outside Copilot since',
  'not-recorded': 'SFlow\'s hooks ran here, and none recorded Copilot changing it',
  'linked-folder': 'no hooks ran here: VS Code opened this folder through a link, and Copilot runs no hooks there',
  'no-hook-records': 'no hooks ran here, so nothing shows Copilot changed it'
});

/** What a writer's basis rests on, in one line, and where it was read [WCB:REQ-011]. */
function basisEvidence(writer) {
  if (writer.writer === 'base') {
    return { what: `it holds exactly what ${writer.branch ?? 'the base branch'} has${writer.commit ? ` at ${String(writer.commit).slice(0, 12)}` : ''}: it came in when that branch was merged, not from this Story`,
      where: 'Git history' };
  }
  return { what: BASIS_WORDS[writer.basis] ?? BASIS_WORDS['no-hook-records'], where: writer.basis === 'agent-said' ? 'the agent\'s departure record'
    : writer.writer === 'copilot' || writer.basis === 'changed-after-copilot' ? 'SFlow\'s hook records' : 'this checkout' };
}

/**
 * The settled decision that takes one file up with its code step [WCB:REQ-010, REQ-011, REQ-012]: a `plan-accounting`
 * settlement of class `out-of-plan`, with who changed it and, for Copilot, the reason it wrote. A file that holds exactly
 * what the base branch has (`writer: 'base'`) is taken up too, as that branch's, so the step's tests run on the code it
 * delivers; no reason is asked of anyone. `kind` is what the file is (person-change-class.mjs: dependency, build,
 * governance; else behaviour).
 */
export function outsidePlanSettlement(file, { phase, stepName = phase?.id, writer = { writer: 'person', basis: 'no-hook-records' }, reason = null, document = null, kind = 'behaviour' }) {
  const copilot = writer.writer === 'copilot';
  const base = writer.writer === 'base';
  const why = copilot ? (reason ? String(reason).replace(/\s+/gu, ' ').trim().slice(0, 400) : null) : null;
  const who = outsidePlanWho({ writer: copilot ? 'copilot' : base ? 'base' : 'person', reason: why, basis: writer.basis, branch: writer.branch });
  return {
    kind: 'plan-accounting', by: 'sflow', phase: phase.id, subject: `file:${file}`,
    answer: `Took ${file} up with ${stepName}: ${base ? `it came ${who}` : `changed outside the plan ${who}`}.`,
    evidence: [
      { what: `no row of the approved plan names ${file}`, where: 'the approved plan' }, basisEvidence(writer),
      ...(why ? [{ what: `Copilot says: ${why}`, where: document ?? `${stepName}'s document` }] : [])
    ],
    effect: { file, class: 'out-of-plan', writer: copilot ? 'copilot' : base ? 'base' : 'person', basis: writer.basis, reason: why, kind,
      ...(writer.agent ? { agent: writer.agent } : {}), ...(base ? { branch: writer.branch ?? null, commit: writer.commit ?? null } : {}) }
  };
}

/**
 * What the code step's publication will take up because it changed outside the plan, as its prepublish tells the author
 * [WCB:REQ-010, REQ-012]: each file with who changed it and the reason found in the document now, and the Copilot files
 * whose reason is not written yet. Publication never waits for one: it records "no reason written". Null when none.
 */
export async function outsidePlanPreview(root, config, workflow, phase) {
  const changed = await outsidePlanFiles(root, config, workflow, phase);
  if (!changed.length) return null;
  const held = await personHeldFiles(workflow, phase.id);
  const guarded = [...(config?.governance?.protectedPaths ?? []), ...(workflow?.resolution?.capability?.policy?.protectedPaths ?? [])]
    .map((entry) => String(entry).replace(/\/$/u, ''));
  // Not a key or certificate either: SFlow never commits one on its own (settle-before-publication.mjs).
  const files = changed.filter((file) => !held.has(file) && !/(?:^|\/)(?:id_(?:rsa|ed25519|ecdsa)|[^/]+\.(?:pem|key|p12|pfx|keystore|jks))$/iu.test(file)
    && !guarded.some((entry) => file === entry || file.startsWith(`${entry}/`)));
  if (!files.length) return null;
  const [writers, { reasons, document }] = await Promise.all([codeWriters(root, workflow, files, { config }), stepDocumentReasons(root, config, workflow, phase)]);
  const entries = files.map((file) => {
    const found = writers.get(file) ?? { writer: 'person' };
    return { file, writer: found.writer, ...(found.writer === 'copilot' ? { reason: reasons.get(file) ?? null } : {}),
      ...(found.writer === 'base' ? { branch: found.branch } : {}) };
  });
  const missing = entries.filter((entry) => entry.writer === 'copilot' && !entry.reason).map((entry) => entry.file);
  const step = phase.label ?? phase.id;
  const mine = entries.filter((entry) => entry.writer !== 'base').map((entry) => entry.file);
  const merged = entries.filter((entry) => entry.writer === 'base');
  const words = [mine.length ? `${mine.join(', ')} changed outside the plan: publishing takes ${mine.length === 1 ? 'it' : 'them'} up with ${step}, and its approval lists who changed each.` : '',
    // The base branch's own files, merged in: taken up so the tests run on what is delivered, nothing asked of anyone.
    merged.length ? `${merged.map((entry) => entry.file).join(', ')} came from ${merged[0].branch} when it was merged in: publishing takes ${merged.length === 1 ? 'it' : 'them'} up with ${step} as ${merged[0].branch}'s, not this Story's change.` : '',
    missing.length ? `Say why you changed ${missing.join(', ')}: under "## Changes outside the plan" in ${document ?? `${step}'s document`}, each file in backticks, then why.` : '']
    .filter(Boolean).join(' ');
  return { files: entries, ...(missing.length ? { reasonsMissing: missing } : {}), words };
}

/**
 * Code committed on the branch of a Story with no code step at all [WCB:REQ-017]: a docs, investigate or review task, or a
 * team workflow with none. Nothing would check it against a clause and a test, and it would reach the pull request, so it is
 * the one code base change such a Story stops for. Only commits on the Story's own line (no merge brings one) that changed
 * a code base file count; `{ paths, commits, takeOut }`, commits newest first, or null. A Story with a code step, or no
 * base, is never asked.
 */
export async function codeCommittedWithoutCodeStep(root, config, workflow) {
  if ((workflow?.phaseOrder ?? []).some((id) => phaseRequiresCodeDelivery(workflow.phases?.[id]))) return null;
  const base = workflow?.workItem?.baseCommit;
  if (!base) return null;
  try {
    const { commitChangedPaths, commitsChangingSince, committedChangedPaths } = await import('./git.mjs');
    const context = applicationPathContext(config, workflow);
    const code = (file) => !isWorkspaceLocalPath(file) && isApplicationChangePath(file, context);
    const changed = committedChangedPaths(root, base).filter(code);
    if (!changed.length) return null;
    const commits = commitsChangingSince(root, base, changed, { limit: 20 });
    const paths = [...new Set(commits.flatMap((entry) => commitChangedPaths(root, entry.commit)).filter((file) => changed.includes(file)))].sort();
    if (!commits.length || !paths.length) return null;
    return { paths, commits, takeOut: `git revert --no-edit ${commits.map((entry) => entry.commit.slice(0, 12)).join(' ')}` };
  } catch { return null; }
}

/**
 * The code base files left uncommitted in the checkout of a Story with no code step [WCB:REQ-017]: nothing delivers them,
 * so its approval lists them as not part of the task, and nothing stops for them. Null for a Story with a code step.
 */
export async function codeLeftInCheckout(root, config, workflow) {
  if ((workflow?.phaseOrder ?? []).some((id) => phaseRequiresCodeDelivery(workflow.phases?.[id]))) return null;
  try {
    const { inspectLifecycleWorktree } = await import('./lifecycle-worktree.mjs');
    const context = applicationPathContext(config, workflow);
    return [...new Set(inspectLifecycleWorktree(root, config, workflow).entries.flatMap((entry) => [entry.path, entry.originalPath]
      .filter((item) => item?.kind === 'utf8' && !isWorkspaceLocalPath(item.value)
        && isApplicationChangePath(item.value, { ...context, untracked: entry.type === 'untracked' })).map((item) => item.value)))].sort();
  } catch { return null; }
}

/**
 * The files SFlow took up with the open code step that are still only in the checkout [WCB:REQ-015]: each can be kept out of
 * the Story in one step, its take-up undone and the file set aside with a private copy (`decisions undo --keep-out`).
 * A Map of file to its settlement ID; empty when the step is not an open code step or nothing taken up is uncommitted.
 */
export async function keepOutFiles(root, config, workflow) {
  const phase = workflow?.phases?.[workflow?.currentPhase];
  if (workflow?.status !== 'in_progress' || phase?.status !== 'in_progress' || !phaseRequiresCodeDelivery(phase)) return new Map();
  const { settledDecisions } = await import('./settled-decisions.mjs');
  const taken = new Map(settledDecisions(workflow).filter((entry) => !entry.undone && entry.kind === 'plan-accounting' && entry.phase === phase.id
    && typeof entry.effect?.file === 'string' && entry.effect.writer).map((entry) => [entry.effect.file, entry.id]));
  if (!taken.size) return new Map();
  try {
    const { inspectLifecycleWorktree } = await import('./lifecycle-worktree.mjs');
    const dirty = new Set(inspectLifecycleWorktree(root, config, workflow).entries.flatMap((entry) => [entry.path, entry.originalPath])
      .filter((item) => item?.kind === 'utf8').map((item) => item.value));
    return new Map([...taken].filter(([file]) => dirty.has(file)));
  } catch { return new Map(); }
}
