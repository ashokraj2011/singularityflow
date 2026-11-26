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
 * - What the team already has comes first [ITW:REQ-020]: its own workflows (task-local.mjs), then the agents this
 *   repository has (installed by APM or kept in .github/agents) whose workflow is not here yet, then the marketplaces'.
 *   Each is converted and covers a task by the same rule, but a workflow the yes runs exactly as it is covers the steps
 *   the team's rules add too, and gives a person each step they give a person: nothing is added to it, and no rule is
 *   lost. One offer, never a list: a workflow already here, then a local agent, then a marketplace agent, each group by
 *   the tie-breaks above. The yes is `--use-workflow ID` (the workflow, or the one a local agent's import makes, which
 *   names that import as a marketplace agent's does); the no is `--without-workflow ID`.
 *
 * chooseTaskAgent is pure. taskAgentFinder reads the team's own workflows and agents, the trusted marketplaces
 * (task-skills.mjs trustedMarketplaceAgents, kept per commit) and the import record; an untrusted marketplace is never
 * read, and with none trusted no marketplace is read.
 */
import { lifecycleReadiness } from './marketplace-lifecycle.mjs';
import { agentWords, planSteps } from './task-composition.mjs';
import { SingularityFlowError } from './util.mjs';

/** The pdlc-tasks whose code is tests (agent-task-intents.mjs: tests are code, which a code step writes). */
export const TEST_WRITING_TASKS = Object.freeze(['unit-testing', 'contract-testing', 'e2e-testing', 'ui-test-automation']);
const NAME = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9][a-z0-9._-]{0,99})$/u;
const WORKFLOW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

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
  // Its lifecycle record's word, else its apm.yml's [OMK:REQ-002]; the one vocabulary decides [OMK:REQ-010]. An agent with
  // no mark is offered as before: its plan is always a question.
  const word = entry.lifecycleRecord?.word ?? entry.lifecycleState ?? null;
  const state = word ? String(word).toLowerCase() : null;
  return {
    id: `${marketplace.id}/${entry.name}`, marketplace: marketplace.id, agent: entry.name, version: entry.version ?? null, state,
    owner: entry.owner?.name ?? null, lifecycle: lifecycleReadiness(state, { unmarked: 'ready' }),
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

/** Every intent of a task's steps but the intake, those the team's rules add included: what a workflow run as it is covers. */
export function ownIntents(composition) {
  return [...new Set(composition.steps.map((step) => step.intent).filter((intent) => intent && intent !== 'intake'))];
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

/** A candidate the yes runs exactly as it is: the team's own workflow, or the one a local agent's import makes [ITW:REQ-020]. */
const asItIs = (candidate) => candidate.source === 'workflow' || candidate.source === 'local-agent';

/**
 * Whether `candidate` covers `composition` [ITW:REQ-011, REQ-020]. A marketplace agent's workflow covers the task's own
 * steps, the team's rules adding theirs to it. One run as it is covers the rules' steps too, and its steps of each intent
 * the rules give a person are a person's: nothing is added to it, so no rule is lost.
 */
export function planCoverage(composition, candidate) {
  if (!asItIs(candidate)) return agentCoverage(composition.kind, neededIntents(composition), candidate);
  const coverage = agentCoverage(composition.kind, ownIntents(composition), candidate);
  const personal = composition.personApproves ?? [];
  const kept = candidate.source !== 'workflow' || candidate.steps.filter((step) => personal.includes(step.intent)).every((step) => step.approvedBy === 'person');
  return coverage.covers && kept ? coverage : { covers: false, extra: 0 };
}

const list = (items) => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** A plan candidate of the team's own in a person's words: "your team's workflow Secure fix", "installed agent qa". */
export const localPlanWords = (candidate) => (candidate.source === 'workflow' ? `your team's workflow ${candidate.label}`
  : `${candidate.installed ? 'installed agent' : 'this repository\'s agent'} ${candidate.agent}`);

/** The offer a person answers: one plain question, what each answer adds to the start, and how to see the conversion. */
function offerOf(candidate, composition, needed) {
  if (asItIs(candidate)) return localOfferOf(candidate, composition, needed);
  const plan = planSteps({ kind: composition.kind, agent: candidate, steps: candidate.steps }).map((step) => step.word).filter(Boolean);
  const words = agentWords(candidate);
  // Its mark and its owner [OMK:REQ-015]: "(the marketplace marks it proposed; owned by QA Guild)".
  const facts = [candidate.lifecycle === 'unreviewed' ? `the marketplace marks it ${candidate.state}` : null, candidate.owner ? `owned by ${candidate.owner}` : null].filter(Boolean);
  const marked = facts.length ? ` (${facts.join('; ')})` : '';
  const neededWords = planSteps({ kind: composition.kind, steps: composition.steps.filter((step) => needed.includes(step.intent)) }).map((step) => step.word).filter(Boolean);
  return {
    id: candidate.id, marketplace: candidate.marketplace, agent: candidate.agent, version: candidate.version, imported: Boolean(candidate.imported),
    state: candidate.lifecycle === 'unreviewed' ? candidate.state : null, owner: candidate.owner ?? null, steps: candidate.steps.map((step) => step.label),
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

/**
 * The offer of a workflow of the team's own, or of a local agent's [ITW:REQ-020], in the marketplace offer's shape: its
 * source (`workflow` or `local-agent`), the question, and the option each answer adds. A local agent's names its
 * conversion review and the import it proposes, as a marketplace agent's does.
 */
function localOfferOf(candidate, composition, needed) {
  const plan = planSteps({ kind: composition.kind, local: candidate, steps: candidate.steps }).map((step) => step.word).filter(Boolean);
  const words = localPlanWords(candidate);
  const marked = candidate.lifecycle === 'unreviewed' ? ` (it is marked ${candidate.state})` : '';
  const neededWords = planSteps({ kind: composition.kind, steps: composition.steps.filter((step) => needed.includes(step.intent)) }).map((step) => step.word).filter(Boolean);
  const agent = candidate.source === 'local-agent';
  return {
    id: candidate.workflow, source: candidate.source, workflow: candidate.workflow, label: candidate.label, imported: !agent,
    ...(agent ? { agent: candidate.agent, path: candidate.path, version: candidate.version, ...(candidate.apm ? { package: candidate.apm } : {}) } : {}),
    ...(candidate.from ? { from: candidate.from } : {}),
    state: candidate.lifecycle === 'unreviewed' ? candidate.state : null, steps: candidate.steps.map((step) => step.label),
    ask: agent
      ? `${words[0].toUpperCase()}${words.slice(1)} covers this task: add its workflow to this repository and use it as the plan, ${plan.join(' → ')}${marked}?`
      : `${words[0].toUpperCase()}${words.slice(1)} covers this task: use it as the plan, exactly as it is, ${plan.join(' → ')}?`,
    why: `its ${agent ? 'stages' : 'steps'} cover every step this task needs (${list(neededWords)})`,
    ...(agent ? { review: `singularity-flow workflow from-agent ${candidate.path} --review`, show: `singularity-flow workflow from-agent ${candidate.path} --propose --json` } : {}),
    yes: `--use-workflow ${candidate.workflow}`, no: `--without-workflow ${candidate.workflow}`
  };
}

const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
// The order of the groups [ITW:REQ-020]: a workflow already here, then an agent this repository has, then a marketplace's.
const GROUP = Object.freeze({ workflow: 0, 'local-agent': 1 });
const groupOf = (candidate) => GROUP[candidate.source] ?? 2;

/** The yes to a workflow of the team's own, or to the one a local agent's import makes [ITW:REQ-020]. */
function chosenWorkflow(composition, candidates, named) {
  const candidate = candidates.find((entry) => asItIs(entry) && entry.workflow === named);
  if (!candidate) {
    const market = candidates.find((entry) => !asItIs(entry) && entry.imported?.workflow === named);
    if (market) {
      throw refusal('TASK_WORKFLOW_UNKNOWN', `${named} is ${agentWords(market)}'s workflow: its yes is --use-agent ${market.id}, which keeps the team's rules adding to it.`,
        { command: `singularity-flow work "<what you want done>" --kind ${composition.kind} --use-agent ${market.id}`, label: `Plan the task with ${agentWords(market)}'s workflow.` },
        { workflow: named, agent: market.id });
    }
    throw refusal('TASK_WORKFLOW_UNKNOWN', `There is no workflow '${named}' of your team's in this repository, nor an agent here whose workflow it would be.`,
      { command: 'singularity-flow workflow list', label: 'See the workflows in this repository.' }, { workflow: named });
  }
  const words = localPlanWords(candidate);
  if (!planCoverage(composition, candidate).covers) {
    const missing = candidate.ready ? '' : ' SFlow cannot yet tell what each of its stages is for: its conversion review asks.';
    throw refusal('TASK_AGENT_NOT_COVERING', `${words[0].toUpperCase()}${words.slice(1)} does not cover this ${composition.kind} task as it is: it needs a step for each of the task's steps and each one the team's rules add, and a person's approval where the rules give one.${missing}`,
      candidate.source === 'local-agent'
        ? { command: `singularity-flow workflow from-agent ${candidate.path} --review`, label: `See what each of its stages becomes.` }
        : { command: 'singularity-flow workflow list', label: 'See the workflows in this repository and their steps.' }, { workflow: named });
  }
  if (candidate.source === 'local-agent') {
    throw refusal('TASK_AGENT_IMPORT_NEEDED', `The workflow of ${words} is not in this repository yet. It comes in through its conversion review, as a reviewed configuration change; once that change is approved, the task follows it.`,
      { command: `singularity-flow workflow from-agent ${candidate.path} --propose`, label: 'Import its workflow through its conversion review.' },
      { workflow: named });
  }
  return { chosenWorkflow: { workflow: candidate.workflow, label: candidate.label, ...(candidate.from ? { from: candidate.from } : {}) } };
}

/**
 * The plan for `composition`: `{ offer }` (one workflow or agent that covers the task, asked about), `{ chosen }` (the
 * marketplace agent the person said yes to, its workflow in the repository, for composeTask's `agent`),
 * `{ chosenWorkflow }` (the team's own workflow the person said yes to, for composeTask's `workflow`), or `{}`.
 * `candidates` come from agentPlanCandidate and task-local.mjs; `kinds` are the kinds of software the task touches; `use`
 * and `without` are the MARKETPLACE/AGENT names the person said yes and no to, `useWorkflow` and `withoutWorkflow` the
 * workflow IDs.
 */
export function chooseTaskAgent(composition, { candidates = [], kinds = [], use = [], without = [], useWorkflow = [], withoutWorkflow = [] } = {}) {
  if (composition.uses) {
    if (use.length || useWorkflow.length) {
      throw refusal('TASK_AGENT_NOT_COVERING', `This team runs every ${composition.kind} task as its ${composition.uses} workflow, so ${use.length ? 'an agent\'s workflow' : 'another workflow'} is not its plan.`,
        { command: 'singularity-flow workflow list', label: 'See the team\'s workflows.' }, use.length ? { agent: use[0] } : { workflow: useWorkflow[0] });
    }
    return {};
  }
  const needed = neededIntents(composition);
  if (useWorkflow.length) return chosenWorkflow(composition, candidates, useWorkflow[0]);
  if (use.length) {
    const named = use[0];
    const market = candidates.filter((entry) => !asItIs(entry));
    const candidate = market.find((entry) => entry.id === named);
    if (!candidate) {
      const marketplace = NAME.exec(named)?.[1] ?? null;
      throw refusal('TASK_AGENT_UNKNOWN', `There is no agent '${named}' in the marketplaces this repository trusts.`,
        marketplace && market.some((entry) => entry.marketplace === marketplace)
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
  if (without.length || withoutWorkflow.length) return {};
  const touched = new Set(kinds);
  const covering = candidates
    .filter((candidate) => candidate.lifecycle !== 'retired' && (!candidate.kinds.length || candidate.kinds.some((kind) => touched.has(kind))))
    .map((candidate) => ({ candidate, coverage: planCoverage(composition, candidate) }))
    .filter((entry) => entry.coverage.covers)
    .sort((left, right) => groupOf(left.candidate) - groupOf(right.candidate)
      || Number(Boolean(right.candidate.imported)) - Number(Boolean(left.candidate.imported))
      || left.coverage.extra - right.coverage.extra || byText(left.candidate.marketplace, right.candidate.marketplace)
      || byText(left.candidate.agent ?? left.candidate.workflow, right.candidate.agent ?? right.candidate.workflow));
  if (!covering.length) return {};
  const [{ candidate }] = covering;
  return { offer: offerOf(candidate, composition, asItIs(candidate) ? ownIntents(composition) : needed) };
}

/**
 * The finder `taskPlan` calls with the composed steps: it reads the team's own workflows and agents (task-local.mjs)
 * [ITW:REQ-020], the agents of each marketplace `definition` trusts (a Git repository read at its pinned commit), the
 * import record of the workflows made from them, and the kinds of software the task touches only when an agent's tags
 * name one. With no trusted repository marketplace it reads no marketplace.
 */
export function taskAgentFinder(root, definition, { touchedPaths = [], use = [], without = [], useWorkflow = [], withoutWorkflow = [] } = {}) {
  return async (composition) => {
    const notes = [];
    const marketplaces = Object.values(definition.marketplaces ?? {}).filter((entry) => entry?.repository && entry.commit)
      .sort((left, right) => byText(left.id, right.id));
    if (composition.uses && !use.length && !useWorkflow.length) return { notes };
    const skills = await import('./task-skills.mjs');
    const kindsOf = (entry) => skills.marketplaceSkillCandidate({ name: entry.name, tags: entry.tags ?? [], pdlcTasks: [] }, null).kinds;
    const candidates = [];
    // What the team already has comes first [ITW:REQ-020]; a yes to a marketplace agent reads none of it.
    if (!composition.uses && !use.length) {
      const local = await (await import('./task-local.mjs')).localPlanCandidates(root, definition, { kindsOf });
      candidates.push(...local.candidates);
      notes.push(...local.notes);
    }
    if (marketplaces.length) {
      const [{ configurationReadRoot }, { loadImportsLedger }] = await Promise.all([import('./configuration-read-scope.mjs'), import('./imports-ledger.mjs')]);
      const ledger = await loadImportsLedger(configurationReadRoot(root)).catch(() => ({ imports: {} }));
      const importedOf = (marketplace, name) => {
        const record = Object.values(ledger.imports ?? {}).find((entry) => entry?.kind === 'workflow' && entry.source?.kind === 'marketplace-agent'
          && entry.source.marketplace === marketplace && entry.source.agent === name && definition.workTypes?.[entry.workflow]);
        return record ? { workflow: record.workflow, commit: record.source.commit ?? null, version: record.source.version ?? null, answers: record.source.answers ?? {} } : null;
      };
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
    }
    const kinds = candidates.some((candidate) => candidate.kinds.length) ? await skills.taskSoftwareKinds(root, touchedPaths) : [];
    return { ...chooseTaskAgent(composition, { candidates, kinds, use, without, useWorkflow, withoutWorkflow }), notes };
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

/** The workflow IDs a person names with --use-workflow or --without-workflow, checked [ITW:REQ-020]. */
export function namedWorkflows(values) {
  for (const value of values) {
    if (!WORKFLOW_ID.test(value)) {
      throw refusal('TASK_WORKFLOW_UNKNOWN', `'${value}' is not a workflow's ID: name it as the plan offers it, in lower-case words joined by hyphens.`,
        { command: 'singularity-flow workflow list', label: 'See the workflows in this repository.' }, { workflow: value });
    }
  }
  return values;
}
