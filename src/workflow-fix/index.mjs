/**
 * `workflow fix`: every finding of `workflow check` (and so of `workflow validate`, which reports the
 * same findings) turned into either a drafted change or a question only a person can answer.
 *
 * Changes are Workflow Studio change set operations (src/workflow-studio.mjs), gathered into one
 * change set: `workflow check --change-set` confirms what it leaves, and `workflow studio apply
 * --change-set --propose` makes it one reviewed configuration proposal. Nothing here writes to the
 * repository or applies anything; the caller may write the change set to its private draft file
 * (src/workflow-validation.mjs workflowFixDraftPath). A question's answer (`answers`) turns its
 * chosen choice into one more change. The fixers are in ./registry.mjs, one per finding code.
 *
 * The result, `resultType: 'workflow-fix'`:
 *   findings   each finding checked, with how it is resolved: `change` (its change ID), `question`
 *              (its question ID), `answered`, `covered` (an earlier change already does it), or
 *              `packaged` (a workflow SFlow protects, which changes only with SFlow)
 *   changes    [{ id, code, findings, summary, ops, diffs, shared?, answers? }]: `ops` the Studio
 *              operations that make it (an op another change also shapes is in `shared`), `diffs`
 *              each text it edits as a unified diff
 *   questions  [{ id, code, findings, ask, why, answer, choices: [{ id, label, effect, needs? }] }]:
 *              `needs` 'people' or 'text' says what the answer adds; answer with
 *              `{ "answers": { "<question>": { "choice": "<id>", "people": [...], "text": "..." } } }`
 *   changeSet  { schema, base, changes } (null when there is no change): every change, as one set
 *   configurationFiles  [{ path, content }]: a workflow.yml that does not load, repaired as text;
 *              Workflow Studio cannot read it, so it goes through `configuration save --propose`
 *   after      what `workflow check` says once the change set is applied (checked on a copy)
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { loadDefinition, resolveWorkType, validateDefinition, WORKFLOW_PATH } from '../config.mjs';
import { configurationReadRoot } from '../configuration-read-scope.mjs';
import { SingularityFlowError } from '../util.mjs';
import { checkWorkflowConfiguration } from '../workflow-check.mjs';
import { buildStudioModel, planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA } from '../workflow-studio.mjs';
import { FixDraft } from './draft.mjs';
import { CONFIGURATION_FIXER, fixerFor } from './registry.mjs';

export { WORKFLOW_FIXERS, CONFIGURATION_FIXER, fixerFor } from './registry.mjs';
export const WORKFLOW_FIX_RESULT = 'workflow-fix';

const SEVERITIES = ['problem', 'warning', 'note'];
const countsOf = (findings) => Object.fromEntries(SEVERITIES.map((severity) => [severity, findings.filter((entry) => entry.severity === severity).length]));
const shortHash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 10);
const EMPTY_MODEL = Object.freeze({ workflows: [], phases: [], agents: [], groups: [], skills: [], instructions: [], protection: {}, integrations: { targets: [] }, base: null });

/** Read answers: `{ answers: { [question]: { choice, people?, text? } } }`, or the map itself. */
export function readFixAnswers(text) {
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new SingularityFlowError(`The answers are not valid JSON: ${error.message}`, { code: 'WORKFLOW_FIX_ANSWERS_INVALID' }); }
  const answers = value?.answers ?? value;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new SingularityFlowError('Answers are a map from question ID to { "choice": "<choice ID>" }, with "people" or "text" when the choice needs them.', { code: 'WORKFLOW_FIX_ANSWERS_INVALID' });
  }
  return answers;
}

/** What every fixer reads: the configuration as written, as loaded and as Workflow Studio models it. */
export async function fixContext(root) {
  const configRoot = configurationReadRoot(root);
  const text = await readFile(path.join(configRoot, WORKFLOW_PATH), 'utf8').catch(() => '');
  let raw = {};
  try { raw = YAML.parse(text) ?? {}; } catch { raw = {}; }
  let definition = null;
  let configurationProblems = [];
  try { definition = await loadDefinition(root); }
  catch (error) {
    configurationProblems = error?.details?.configurationProblems ?? [];
    definition = await loadDefinition(root, { storyBootstrap: true }).catch(() => null);
  }
  const model = await buildStudioModel(root).catch(() => EMPTY_MODEL);
  const [{ discoverAgents }, { loadImportsLedger }] = await Promise.all([import('../agents.mjs'), import('../asset-import.mjs')]);
  const agents = await discoverAgents(root).catch(() => []);
  const ledger = await loadImportsLedger(configRoot).catch(() => ({ imports: {} }));
  const resolvedCache = new Map();
  const { yamlLocator } = await import('../workflow-check.mjs');
  const locators = new Map([[WORKFLOW_PATH, yamlLocator(text, WORKFLOW_PATH)]]);
  return {
    configRoot, raw, definition, configurationProblems, model,
    /** The line of a key path in a configuration file, or null. */
    locate: (file, keys) => locators.get(file)?.(keys)?.line ?? null,
    templatesRoot: model.templatesRoot ?? raw.templatesRoot ?? 'singularity/templates',
    readOnlyReviewers: new Set(agents.filter((agent) => agent.metadata?.['sflow-mode'] === 'read-only-review').map((agent) => agent.id)),
    importsLedger: ledger.imports ?? {},
    resolved(id) {
      if (!id || !definition) return null;
      if (!resolvedCache.has(id)) { try { resolvedCache.set(id, resolveWorkType(definition, id)); } catch { resolvedCache.set(id, null); } }
      return resolvedCache.get(id);
    }
  };
}

/** The finding as `workflow fix` lists it: the check's fields, and a reference unique in this result. */
function listed(finding, ref) {
  return { id: ref, code: finding.code, severity: finding.severity, title: finding.title, ...(finding.location ? { location: finding.location } : {}),
    ...(finding.subject?.workflow ? { workflow: finding.subject.workflow } : {}) };
}

/** A question as the result shows it: its choices without the functions that apply them. */
function shownQuestion(entry) {
  const { choices, apply, ...rest } = entry;
  return { ...rest, choices: choices.map(({ apply: _apply, ...choice }) => choice) };
}

/**
 * One round: check `root`, run each finding's fixer, apply the answers that name this round's
 * questions. Returns the round's findings, changes (with their draft keys), questions and draft.
 */
async function draftRound(root, { only, answers, round }) {
  const check = await checkWorkflowConfiguration(root, only);
  const ctx = await fixContext(root);
  ctx.check = check;
  const draft = new FixDraft({ configRoot: ctx.configRoot, templatesRoot: ctx.templatesRoot, raw: ctx.raw, agents: ctx.model.agents });
  ctx.draft = draft;
  const configurationLoads = check.configuration.valid || check.workflows.length > 0;

  // Every finding once, with a reference unique in this result (two broken links on one line share a check ID).
  const seen = new Map();
  const entries = [...check.workflows.flatMap((entry) => entry.findings), ...check.repository.findings].map((finding) => {
    const count = (seen.get(finding.id) ?? 0) + 1;
    seen.set(finding.id, count);
    return { finding, ref: count === 1 ? finding.id : `${finding.id}-${count}`, fixer: fixerFor(finding, { configurationLoads }) };
  });
  // A packaged workflow SFlow protects changes with SFlow, never through a change set here.
  const packaged = new Set(ctx.model.workflows.filter((entry) => entry.readOnly).map((entry) => entry.id));
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.fixer || packaged.has(entry.finding.subject?.workflow)) continue;
    const key = `${entry.finding.code}\0${entry.fixer.group ? entry.fixer.group(entry.finding) : entry.ref}`;
    if (!groups.has(key)) groups.set(key, { key, fixer: entry.fixer, entries: [] });
    groups.get(key).entries.push(entry);
  }
  const resolution = new Map();
  const changes = [];
  const questions = [];
  for (const group of [...groups.values()].sort((left, right) => left.fixer.order - right.fixer.order)) {
    const code = group.entries[0].finding.code;
    const refs = group.entries.map((entry) => entry.ref);
    const { value, keys, diffs } = await draft.record(() => group.fixer.fix(group.entries.map((entry) => entry.finding), ctx));
    const result = value ?? {};
    const change = keys.length ? { code, findings: refs, summary: result.summary ?? group.entries[0].finding.title, keys, diffs } : null;
    if (change) changes.push(change);
    const asked = (result.questions ?? []).map((entry, index) => ({ id: `q-${shortHash(`${group.key}\0${index}`)}`, code, findings: refs, ...entry }));
    questions.push(...asked);
    for (const ref of refs) {
      resolution.set(ref, change ? { resolution: 'change', change, ...(asked.length ? { questions: asked.map((entry) => entry.id) } : {}) }
        : asked.length ? { resolution: 'question', question: asked[0].id, ...(asked.length > 1 ? { questions: asked.map((entry) => entry.id) } : {}) }
          : { resolution: 'covered', reason: 'An earlier change already does what this finding asks.' });
    }
  }
  // A workflow.yml repaired as text is diagnosed again: its validator stops at what it cannot repair
  // itself, so the next problems show only once the first are mended.
  const seenProblems = new Set(entries.map((entry) => String(entry.finding.detail ?? '')));
  for (let pass = 0; !configurationLoads && pass < CONFIGURATION_PASSES; pass += 1) {
    const repaired = draft.files().find((file) => file.path === WORKFLOW_PATH);
    if (!repaired) break;
    const problems = await diagnoseConfiguration(ctx.configRoot, repaired.content);
    // Only what this pass shows for the first time: one still unanswered is asked once.
    const fresh = problems.filter((problem) => !seenProblems.has(String(problem.message)));
    for (const problem of fresh) seenProblems.add(String(problem.message));
    if (!fresh.length) break;
    ctx.configurationProblems = problems;
    const found = fresh.map((problem) => ({ id: problemRef(problem), code: problem.code ?? 'WORKFLOW_CONFIGURATION_INVALID', severity: 'problem',
      title: String(problem.message).split(/(?<=[.!?])\s+/u)[0], detail: problem.message, fix: problem.fix ? { text: problem.fix } : null,
      subject: { file: problem.file ?? WORKFLOW_PATH }, ...(problem.line ? { location: { file: problem.file ?? WORKFLOW_PATH, line: problem.line } } : {}), blocksStart: true }));
    const { value, keys, diffs } = await draft.record(() => CONFIGURATION_FIXER.fix(found, ctx));
    const refs = found.map((finding) => finding.id);
    const change = keys.length ? { code: found[0].code, findings: refs, summary: value?.summary ?? found[0].title, keys, diffs } : null;
    if (change) changes.push(change);
    const asked = (value?.questions ?? []).map((entry, index) => ({ id: `q-${shortHash(`${refs.join('\0')}\0${index}`)}`, code: found[0].code, findings: refs, ...entry }));
    questions.push(...asked);
    found.forEach((finding) => { entries.push({ finding, ref: finding.id, fixer: CONFIGURATION_FIXER }); resolution.set(finding.id, change ? { resolution: 'change', change } : asked.length ? { resolution: 'question', question: asked[0].id } : { resolution: 'covered' }); });
    if (!keys.length) break;
  }
  // Answered questions become changes of their own.
  const answered = new Set();
  for (const [id, answer] of Object.entries(answers ?? {})) {
    const entry = questions.find((candidate) => candidate.id === id);
    if (!entry) continue;
    const choice = entry.choices.find((candidate) => candidate.id === answer?.choice);
    if (!choice) throw new SingularityFlowError(`Question ${id} has no choice '${answer?.choice}'. Choices: ${entry.choices.map((candidate) => candidate.id).join(', ')}.`, { code: 'WORKFLOW_FIX_ANSWER_UNKNOWN' });
    if (choice.needs === 'people' && !(Array.isArray(answer.people) ? answer.people.length : String(answer.people ?? answer.text ?? '').trim())) {
      throw new SingularityFlowError(`Question ${id}, choice ${choice.id}, needs the people: "people": ["<github-login>", "<email>"].`, { code: 'WORKFLOW_FIX_ANSWER_INCOMPLETE' });
    }
    if (choice.needs === 'text' && !String(answer.text ?? '').trim()) {
      throw new SingularityFlowError(`Question ${id}, choice ${choice.id}, needs your words: "text": "...".`, { code: 'WORKFLOW_FIX_ANSWER_INCOMPLETE' });
    }
    const { keys, diffs } = await draft.record(() => choice.apply(draft, answer));
    answered.add(id);
    const change = keys.length ? { code: entry.code, findings: entry.findings, summary: `${entry.ask} ${choice.label}. ${choice.effect ?? ''}`.trim(), keys, diffs, answers: id } : null;
    if (change) changes.push(change);
    for (const ref of entry.findings) resolution.set(ref, { resolution: 'answered', question: id, ...(change ? { change } : {}) });
  }
  const findings = entries.map(({ finding, ref, fixer }) => ({ ...listed(finding, ref), ...(round > 1 ? { round } : {}),
    ...(resolution.get(ref) ?? (packaged.has(finding.subject?.workflow) ? { resolution: 'packaged', reason: PACKAGED }
      : fixer ? { resolution: 'covered' } : { resolution: 'unhandled' })) }));
  return { check, ctx, draft, findings, changes, questions, answered };
}

const MAX_ROUNDS = 3;
const BISECT_LIMIT = 8;
const PACKAGED = 'A packaged workflow SFlow protects: it changes with an SFlow update, never by a change set here. Copy it (workflow copy) to change your own.';
const CONFIGURATION_PASSES = 6;
const problemRef = (problem) => `f-${shortHash(`${problem.code}\0${problem.line ?? ''}\0${problem.message}`)}`;

/** The located problems of a workflow.yml text, as the configuration loader diagnoses them. */
async function diagnoseConfiguration(configRoot, text) {
  const [{ diagnoseWorkflowText }, { applyWorkflowCompatibility }, { isAgentTemplateReference }] = await Promise.all([
    import('../configuration-diagnostics.mjs'), import('../config.mjs'), import('../agent-document-parser.mjs')]);
  return diagnoseWorkflowText(text, { root: configRoot, validate: (candidate) => validateDefinition(candidate), prepare: applyWorkflowCompatibility,
    resolveWorkType, isAgentTemplateReference }).catch(() => []);
}
const afterOf = (plan) => (plan.valid
  ? { valid: plan.inspection?.configuration?.valid !== false, counts: plan.inspection?.counts ?? countsOf([]),
    findings: [...(plan.inspection?.workflows ?? []).flatMap((entry) => entry.findings), ...(plan.inspection?.repository?.findings ?? [])]
      .map((finding) => ({ code: finding.code, severity: finding.severity, title: finding.title, ...(finding.location ? { location: finding.location } : {}) })),
    files: plan.files.map((file) => ({ path: file.path, action: file.action })), summary: plan.summary }
  : { valid: false, problems: plan.problems.map((problem) => ({ code: problem.code, message: problem.message })) });

/**
 * Draft the fixes for the workflows at `root` (all, or `workflow`). Reads the configuration the way
 * `workflow check` does (call it in the same configuration read scope); writes nothing.
 *
 * Fixes come in rounds: a configuration that does not load hides every other finding, so once a
 * round's change set applies, the configuration it leaves is checked again (on a copy) and the
 * findings it shows are fixed in the next round, up to three. Later rounds' changes follow earlier
 * ones in the one change set; each reads what the earlier ones left.
 */
export async function draftWorkflowFixes(root, { workflow = null, answers = null, verify = true } = {}) {
  const only = workflow ? { workflows: [workflow] } : {};
  const rounds = [await draftRound(root, { only, answers, round: 1 })];
  const first = rounds[0];
  const base = first.ctx.model.base;
  // Changes Workflow Studio refused, by round: their keys leave the change set.
  const refusedKeys = new Map();
  const studioChanges = () => rounds.flatMap((entry) => entry.draft.studioChanges(refusedKeys.get(entry)));
  const changeSetOf = (changes) => (changes.length ? { schema: STUDIO_CHANGE_SET_SCHEMA, ...(base ? { base } : {}), changes } : null);
  let after = null;
  let lastPlan = null;
  while (verify) {
    const changeSet = changeSetOf(studioChanges());
    if (!changeSet) break;
    let next = null;
    const plan = await planStudioChangeSet(root, changeSet, { inspect: async (candidateRoot) => {
      const inspection = await checkWorkflowConfiguration(candidateRoot, only);
      // Fix what this change set leaves, as long as that is something new to fix.
      if (rounds.length < MAX_ROUNDS) {
        const round = await draftRound(candidateRoot, { only, answers, round: rounds.length + 1 });
        if (round.changes.length || round.questions.some((entry) => !rounds.some((earlier) => earlier.questions.some((asked) => asked.id === entry.id)))) next = round;
      }
      return inspection;
    } });
    after = afterOf(plan);
    lastPlan = plan;
    if (!plan.valid || !next) break;
    rounds.push(next);
  }
  const replan = async () => {
    const changeSet = changeSetOf(studioChanges());
    lastPlan = changeSet ? await planStudioChangeSet(root, changeSet, { inspect: (candidateRoot) => checkWorkflowConfiguration(candidateRoot, only) }) : null;
    after = lastPlan ? afterOf(lastPlan) : null;
  };
  if (verify && rounds.length > 1) await replan();
  // A change Workflow Studio refuses (a step another workflow protects, a group it will not take) is
  // taken out, and its finding is asked about instead; the rest still apply.
  for (let attempt = 0; verify && lastPlan && !lastPlan.valid && attempt < 3; attempt += 1) {
    const culprits = [];
    for (const problem of lastPlan.problems.filter((entry) => entry.change)) {
      for (const entry of rounds) {
        for (const change of entry.changes.filter((candidate) => !candidate.refused)) {
          const ops = change.keys.map((key) => entry.draft.compile(key)).filter(Boolean);
          if (!culprits.some((culprit) => culprit.change === change)
              && ops.some((op) => op.op === problem.change && (!problem.subject?.id || [op.id, op.phase, op.path].includes(problem.subject.id)))) culprits.push({ entry, change, problem });
        }
      }
    }
    if (!culprits.length) {
      // Refused as a whole (validation names no change): the latest change whose leaving makes the rest apply.
      const candidates = rounds.flatMap((entry) => entry.changes.filter((change) => !change.refused).map((change) => ({ entry, change }))).reverse().slice(0, BISECT_LIMIT);
      for (const candidate of candidates) {
        const trial = new Map([...refusedKeys].map(([entry, keys]) => [entry, new Set(keys)]));
        trial.set(candidate.entry, new Set([...(trial.get(candidate.entry) ?? []), ...candidate.change.keys]));
        const changes = rounds.flatMap((entry) => entry.draft.studioChanges(trial.get(entry)));
        const plan = changes.length ? await planStudioChangeSet(root, changeSetOf(changes)) : { valid: true };
        if (plan.valid) { culprits.push({ ...candidate, problem: lastPlan.problems[0] }); break; }
      }
    }
    if (!culprits.length) break;
    for (const { entry, change, problem } of culprits) {
      change.refused = problem.message;
      refusedKeys.set(entry, new Set([...(refusedKeys.get(entry) ?? []), ...change.keys]));
      entry.questions.push({ id: `q-${shortHash(`refused\0${change.findings.join('\0')}`)}`, code: change.code, findings: change.findings,
        ask: `Workflow Studio refused the change drafted for this (${change.summary.split('\n')[0]}): ${problem.message}`,
        why: 'The fix needs a change Workflow Studio does not allow here; what to do instead is a person\'s decision.', choices: [{ id: 'keep', label: 'Leave it for now', effect: 'Nothing changes.', apply: () => {} }] });
      for (const finding of entry.findings.filter((candidate) => change.findings.includes(candidate.id))) Object.assign(finding, { resolution: 'question', question: entry.questions.at(-1).id, change: undefined });
    }
    await replan();
  }
  const configurationFiles = first.draft.files();
  if (verify && !after && configurationFiles.length) {
    const file = configurationFiles.find((entry) => entry.path === WORKFLOW_PATH);
    const problems = file ? await diagnoseConfiguration(first.ctx.configRoot, file.content) : [];
    after = { valid: !problems.length, configurationLoads: !problems.length,
      ...(problems.length ? { problems: problems.map((problem) => ({ code: problem.code, message: `${problem.line ? `line ${problem.line}: ` : ''}${problem.message}` })) } : {}) };
  }

  // Number the changes across rounds; each change's ops as its round's draft leaves them.
  const changes = [];
  const ids = new Map();
  for (const entry of rounds) {
    const owners = new Map();
    const kept = entry.changes.filter((change) => !change.refused);
    for (const change of kept) for (const key of change.keys) owners.set(key, [...(owners.get(key) ?? []), change]);
    for (const change of kept) {
      const id = `c-${changes.length + 1}`;
      ids.set(change, id);
      const { keys, refused: _refused, ...shown } = change;
      changes.push({ id, ...shown, ...(entry !== first ? { round: rounds.indexOf(entry) + 1 } : {}),
        ops: keys.filter((key) => !key.startsWith('file:')).map((key) => entry.draft.compile(key)).filter(Boolean), owners, keys });
    }
  }
  const shownChanges = changes.map(({ owners, keys, ...change }) => {
    const shared = [...new Set(keys.flatMap((key) => (owners.get(key) ?? []).map((other) => ids.get(other)).filter((id) => id !== change.id)))];
    return { ...change, ...(shared.length ? { shared } : {}) };
  });
  const resolved = (finding) => (finding.change ? { ...finding, change: ids.get(finding.change) } : finding);
  const findings = rounds.flatMap((entry, index) => entry.findings.filter((finding) => index === 0 || !rounds.slice(0, index).some((earlier) => earlier.findings.some((other) => other.id === finding.id))).map(resolved));
  const answered = new Set(rounds.flatMap((entry) => [...entry.answered]));
  const asked = [...new Map(rounds.flatMap((entry) => entry.questions).map((entry) => [entry.id, entry])).values()];
  const unknown = Object.keys(answers ?? {}).filter((id) => !answered.has(id));
  if (unknown.length) {
    throw new SingularityFlowError(`There is no question '${unknown[0]}' in this run. Questions: ${asked.map((entry) => entry.id).join(', ') || 'none'}.`, { code: 'WORKFLOW_FIX_ANSWER_UNKNOWN' });
  }
  const open = asked.filter((entry) => !answered.has(entry.id));
  return {
    schemaVersion: 1, resultType: WORKFLOW_FIX_RESULT,
    workflow, configuration: first.check.configuration,
    counts: { ...first.check.counts, findings: findings.length, changes: shownChanges.length, questions: open.length, rounds: rounds.length,
      unhandled: findings.filter((entry) => entry.resolution === 'unhandled').length },
    findings,
    changes: shownChanges,
    questions: open.map(shownQuestion),
    ...(answered.size ? { answered: [...answered] } : {}),
    changeSet: changeSetOf(studioChanges()),
    configurationFiles,
    after
  };
}
