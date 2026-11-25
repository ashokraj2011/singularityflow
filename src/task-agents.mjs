/**
 * A marketplace agent as a task's plan [ITW:REQ-011, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md]: when one agent of a marketplace
 * the repository trusts has stages that cover the task, the plan offers that agent's workflow, the same way every time.
 *
 * - What each stage is for comes from the conversion every marketplace agent goes through (agent-workflow.mjs
 *   convertAgent, read at the commit the repository trusts, with the answers its import recorded). An agent with a stage
 *   SFlow cannot classify without a person's answer is not offered until its import has that answer.
 * - The agent covers the task when its workflow has a step for each of the task's own steps but the intake (the person's
 *   words are every task's intake): a plan is also covered by a requirements step before the code, which plans it
 *   (workflow-needs.mjs). Its code is the task's kind of code: an agent whose code steps only write tests covers a tests
 *   task, and one that writes the product's code covers the others. An agent with a code step never covers a task that
 *   changes no code (docs, investigate, review).
 * - An agent marked deprecated or retired is never offered, nor one whose tags name only kinds of software the task does
 *   not touch. Of those that cover, the one whose workflow is already in the repository comes first, then the one with
 *   the fewest steps the task does not need, then by marketplace and name: one offer, never a list.
 * - The yes (`--use-agent MARKETPLACE/AGENT`) makes the plan that workflow's steps (task-composition.mjs) once the
 *   workflow is in the repository; until then its start says so and names the import, which goes through the conversion
 *   review as a reviewed configuration change. The no (`--without-agent MARKETPLACE/AGENT`) keeps the composed steps and
 *   asks nothing more.
 *
 * chooseTaskAgent is pure. taskAgentFinder reads the trusted marketplaces (task-skills.mjs trustedMarketplaceAgents, kept
 * per commit) and the import record; an untrusted marketplace is never read, and with none trusted nothing is read.
 */
import { agentWords, planSteps } from './task-composition.mjs';
import { SingularityFlowError } from './util.mjs';

/** The pdlc-tasks whose code is tests (agent-task-intents.mjs: tests are code, which a code step writes). */
export const TEST_WRITING_TASKS = Object.freeze(['unit-testing', 'contract-testing', 'e2e-testing', 'ui-test-automation']);
const RETIRED = new Set(['deprecated', 'retired', 'withdrawn', 'archived']);
const UNREVIEWED = new Set(['proposed', 'beta', 'alpha', 'draft', 'experimental', 'preview']);
const NAME = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9][a-z0-9._-]{0,99})$/u;

function refusal(code, message, nextAction, details = {}) {
  return new SingularityFlowError(message, { code, details: { ...details, nextAction } });
}

/**
 * A marketplace agent as a task reads it: `{ id, marketplace, agent, version, state, lifecycle, kinds, steps, ready,
 * imported }`, each step `{ id, intent, label, tasks }` as its conversion makes it, or null when it cannot be converted.
 * `imported` is the repository's workflow made from it (`{ workflow, commit, version }`), when there is one.
 */
export async function agentPlanCandidate({ marketplace, entry, skills = [], imported = null, kindsOf = null }) {
  const { convertAgent } = await import('./agent-workflow.mjs');
  let conversion;
  try {
    conversion = convertAgent({ marketplace, agent: { ...entry, skills: entry.skills ?? [] }, skills: skills.filter((skill) => (entry.skills ?? []).includes(skill.name)),
      answers: imported?.answers ?? {} });
  } catch { return null; }
  const tasksOf = new Map(skills.map((skill) => [skill.name, skill.pdlcTasks ?? []]));
  const state = entry.lifecycleState ? String(entry.lifecycleState).toLowerCase() : null;
  return {
    id: `${marketplace.id}/${entry.name}`, marketplace: marketplace.id, agent: entry.name, version: entry.version ?? null, state,
    lifecycle: RETIRED.has(state) ? 'retired' : UNREVIEWED.has(state) ? 'unreviewed' : 'ready',
    kinds: kindsOf ? kindsOf(entry) : [],
    ready: conversion.ready,
    steps: conversion.steps.map((step) => ({ id: step.id, intent: step.intent, label: step.label,
      tasks: [...new Set(step.skills.flatMap((use) => tasksOf.get(use.skill) ?? []))].sort() })),
    ...(imported ? { imported: { workflow: imported.workflow, commit: imported.commit ?? null, version: imported.version ?? null } } : {})
  };
}

/** The intents a task needs an agent to cover: its own steps', but the intake and those the team's rules add. */
export function neededIntents(composition) {
  const ruled = new Set((composition.added ?? []).map((entry) => entry.intent));
  return [...new Set(composition.steps.map((step) => step.intent).filter((intent) => intent && intent !== 'intake' && !ruled.has(intent)))];
}

/** Whether `candidate`'s steps cover a `kind` task needing `needed`, and how many of its steps that task does not need. */
export function agentCoverage(kind, needed, candidate) {
  if (!candidate?.ready) return { covers: false, extra: 0 };
  const intents = candidate.steps.map((step) => step.intent);
  const codeSteps = candidate.steps.filter((step) => step.intent === 'code');
  if (Boolean(codeSteps.length) !== needed.includes('code')) return { covers: false, extra: 0 };
  if (codeSteps.length) {
    const testsOnly = codeSteps.every((step) => step.tasks.length && step.tasks.every((task) => TEST_WRITING_TASKS.includes(task)));
    if (testsOnly !== (kind === 'tests')) return { covers: false, extra: 0 };
  }
  const firstCode = intents.indexOf('code');
  const covered = (intent) => intents.includes(intent)
    || (intent === 'plan' && firstCode > 0 && intents.slice(0, firstCode).includes('requirements'))
    || (intent === 'design' && kind === 'docs' && intents.includes('document'));
  if (!needed.every(covered)) return { covers: false, extra: 0 };
  const used = new Set([...needed, 'intake', ...(needed.includes('plan') ? ['requirements'] : []), ...(kind === 'docs' ? ['document'] : [])]);
  return { covers: true, extra: candidate.steps.filter((step) => !used.has(step.intent)).length };
}

const list = (items) => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** The offer a person answers: one plain question, what each answer adds to the start, and how to see the conversion. */
function offerOf(candidate, composition, needed) {
  const plan = planSteps({ kind: composition.kind, agent: candidate, steps: candidate.steps }).map((step) => step.word).filter(Boolean);
  const words = agentWords(candidate);
  const marked = candidate.lifecycle === 'unreviewed' ? ` (the marketplace marks it ${candidate.state})` : '';
  const neededWords = planSteps({ kind: composition.kind, steps: composition.steps.filter((step) => needed.includes(step.intent)) }).map((step) => step.word).filter(Boolean);
  return {
    id: candidate.id, marketplace: candidate.marketplace, agent: candidate.agent, version: candidate.version, imported: Boolean(candidate.imported),
    state: candidate.lifecycle === 'unreviewed' ? candidate.state : null, steps: candidate.steps.map((step) => step.label),
    ask: candidate.imported
      ? `${words} covers this task: use its workflow as the plan, ${plan.join(' → ')}${marked}?`
      : `${words} covers this task: add its workflow to this repository and use it as the plan, ${plan.join(' → ')}${marked}?`,
    why: `its stages cover every step this task needs (${list(neededWords)})`,
    review: `singularity-flow workflow from-agent ${candidate.id} --review`,
    // Not here yet: its conversion review and the import it proposes, which the yes confirms (as /sf-import does).
    ...(candidate.imported ? {} : { show: `singularity-flow workflow from-agent ${candidate.id} --propose --json` }),
    yes: `--use-agent ${candidate.id}`, no: `--without-agent ${candidate.id}`
  };
}

const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The agent for `composition`: `{ offer }` (one agent whose stages cover the task, asked about), `{ chosen }` (the
 * agent the person said yes to, its workflow in the repository, for composeTask's `agent`), or `{}`. `candidates` come
 * from agentPlanCandidate; `kinds` are the kinds of software the task touches; `use` and `without` are the
 * MARKETPLACE/AGENT names the person said yes and no to.
 */
export function chooseTaskAgent(composition, { candidates = [], kinds = [], use = [], without = [] } = {}) {
  if (composition.uses) {
    if (use.length) {
      throw refusal('TASK_AGENT_NOT_COVERING', `This team runs every ${composition.kind} task as its ${composition.uses} workflow, so an agent's workflow is not its plan.`,
        { command: 'singularity-flow workflow list', label: 'See the team\'s workflows.' }, { agent: use[0] });
    }
    return {};
  }
  const needed = neededIntents(composition);
  if (use.length) {
    const named = use[0];
    const candidate = candidates.find((entry) => entry.id === named);
    if (!candidate) {
      const marketplace = NAME.exec(named)?.[1] ?? null;
      throw refusal('TASK_AGENT_UNKNOWN', `There is no agent '${named}' in the marketplaces this repository trusts.`,
        marketplace && candidates.some((entry) => entry.marketplace === marketplace)
          ? { command: `singularity-flow marketplace browse ${marketplace} --kind agent`, label: `See ${marketplace}'s agents.` }
          : { command: 'singularity-flow marketplace list', label: 'See the marketplaces this repository trusts.' }, { agent: named });
    }
    if (!agentCoverage(composition.kind, needed, candidate).covers) {
      const missing = candidate.ready ? '' : ' SFlow cannot yet tell what each of its stages is for: its conversion review asks.';
      throw refusal('TASK_AGENT_NOT_COVERING', `${agentWords(candidate)}'s stages do not cover this ${composition.kind} task.${missing}`,
        { command: `singularity-flow workflow from-agent ${candidate.id} --review`, label: `See what each of ${agentWords(candidate)}'s stages becomes.` }, { agent: named });
    }
    if (!candidate.imported) {
      throw refusal('TASK_AGENT_IMPORT_NEEDED', `${agentWords(candidate)}'s workflow is not in this repository yet. It comes in through its conversion review, as a reviewed configuration change; once that change is approved, the task follows it.`,
        { command: `singularity-flow workflow from-agent ${candidate.id} --propose`, label: 'Import its workflow through its conversion review.' },
        { agent: named });
    }
    return { chosen: { marketplace: candidate.marketplace, agent: candidate.agent, version: candidate.imported.version ?? candidate.version,
      workflow: candidate.imported.workflow, ...(candidate.imported.commit ? { commit: candidate.imported.commit } : {}) } };
  }
  if (without.length) return {};
  const touched = new Set(kinds);
  const covering = candidates
    .filter((candidate) => candidate.lifecycle !== 'retired' && (!candidate.kinds.length || candidate.kinds.some((kind) => touched.has(kind))))
    .map((candidate) => ({ candidate, coverage: agentCoverage(composition.kind, needed, candidate) }))
    .filter((entry) => entry.coverage.covers)
    .sort((left, right) => Number(Boolean(right.candidate.imported)) - Number(Boolean(left.candidate.imported))
      || left.coverage.extra - right.coverage.extra || byText(left.candidate.marketplace, right.candidate.marketplace) || byText(left.candidate.agent, right.candidate.agent));
  return covering.length ? { offer: offerOf(covering[0].candidate, composition, needed) } : {};
}

/**
 * The finder `taskPlan` calls with the composed steps: it reads the agents of each marketplace `definition` trusts (a
 * Git repository read at its pinned commit), the import record of the workflows made from them, and the kinds of
 * software the task touches only when an agent's tags name one. With no trusted repository marketplace it reads nothing.
 */
export function taskAgentFinder(root, definition, { touchedPaths = [], use = [], without = [] } = {}) {
  return async (composition) => {
    const notes = [];
    const marketplaces = Object.values(definition.marketplaces ?? {}).filter((entry) => entry?.repository && entry.commit)
      .sort((left, right) => byText(left.id, right.id));
    if (composition.uses && !use.length) return { notes };
    if (!marketplaces.length) {
      if (use.length) return { ...chooseTaskAgent(composition, { use }), notes };
      return { notes };
    }
    const [{ configurationReadRoot }, { loadImportsLedger }, skills] = await Promise.all([
      import('./configuration-read-scope.mjs'), import('./imports-ledger.mjs'), import('./task-skills.mjs')]);
    const ledger = await loadImportsLedger(configurationReadRoot(root)).catch(() => ({ imports: {} }));
    const importedOf = (marketplace, name) => {
      const record = Object.values(ledger.imports ?? {}).find((entry) => entry?.kind === 'workflow' && entry.source?.kind === 'marketplace-agent'
        && entry.source.marketplace === marketplace && entry.source.agent === name && definition.workTypes?.[entry.workflow]);
      return record ? { workflow: record.workflow, commit: record.source.commit ?? null, version: record.source.version ?? null, answers: record.source.answers ?? {} } : null;
    };
    const kindsOf = (entry) => skills.marketplaceSkillCandidate({ name: entry.name, tags: entry.tags ?? [], pdlcTasks: [] }, null).kinds;
    const candidates = [];
    for (const marketplace of marketplaces) {
      let listing;
      try { listing = await skills.trustedMarketplaceAgents(root, marketplace); } catch (error) {
        notes.push(`Marketplace ${marketplace.id} could not be read, so its agents are not offered: ${String(error?.message ?? error).split('\n')[0]}`);
        continue;
      }
      for (const entry of listing.agents) {
        const candidate = await agentPlanCandidate({ marketplace, entry, skills: listing.skills, imported: importedOf(marketplace.id, entry.name), kindsOf });
        if (candidate) candidates.push(candidate);
      }
    }
    const kinds = candidates.some((candidate) => candidate.kinds.length) ? await skills.taskSoftwareKinds(root, touchedPaths) : [];
    return { ...chooseTaskAgent(composition, { candidates, kinds, use, without }), notes };
  };
}

/** The `MARKETPLACE/AGENT` a person names, checked: one only, in that form. */
export function namedAgents(values) {
  for (const value of values) {
    if (!NAME.test(value)) {
      throw refusal('TASK_AGENT_UNKNOWN', `'${value}' is not an agent's name: name it as MARKETPLACE/AGENT, as the plan offers it.`,
        { command: 'singularity-flow marketplace list', label: 'See the marketplaces this repository trusts.' }, { agent: value });
    }
  }
  return values;
}

