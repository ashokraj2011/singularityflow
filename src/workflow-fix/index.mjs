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
 *              (its question ID), `answered`, or `covered` (an earlier change already does it)
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
import { fixerFor } from './registry.mjs';

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

async function context(root) {
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
  return {
    configRoot, raw, definition, configurationProblems, model,
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
  const ctx = await context(root);
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
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.fixer) continue;
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
    ...(resolution.get(ref) ?? (fixer ? { resolution: 'covered' } : { resolution: 'unhandled' })) }));
  return { check, ctx, draft, findings, changes, questions, answered };
}

const MAX_ROUNDS = 3;
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
  const studioChanges = () => rounds.flatMap((entry) => entry.draft.studioChanges());
  const changeSetOf = (changes) => (changes.length ? { schema: STUDIO_CHANGE_SET_SCHEMA, ...(base ? { base } : {}), changes } : null);
  let after = null;
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
    if (!plan.valid || !next) break;
    rounds.push(next);
  }
  if (verify && rounds.length > 1) {
    const plan = await planStudioChangeSet(root, changeSetOf(studioChanges()), { inspect: (candidateRoot) => checkWorkflowConfiguration(candidateRoot, only) });
    after = afterOf(plan);
  }
  const configurationFiles = first.draft.files();
  if (verify && !after && configurationFiles.length) {
    const file = configurationFiles.find((entry) => entry.path === WORKFLOW_PATH);
    let problem = null;
    try { validateDefinition(YAML.parse(file?.content ?? '') ?? {}); } catch (error) { problem = error.message; }
    after = { valid: !problem, configurationLoads: !problem, ...(problem ? { problems: [{ code: 'CONFIGURATION_INVALID', message: problem }] } : {}) };
  }

  // Number the changes across rounds; each change's ops as its round's draft leaves them.
  const changes = [];
  const ids = new Map();
  for (const entry of rounds) {
    const owners = new Map();
    for (const change of entry.changes) for (const key of change.keys) owners.set(key, [...(owners.get(key) ?? []), change]);
    for (const change of entry.changes) {
      const id = `c-${changes.length + 1}`;
      ids.set(change, id);
      const { keys, ...shown } = change;
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
