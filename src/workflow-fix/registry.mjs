/**
 * Every finding code `workflow check` and `workflow validate` can raise, with what fixes it: a
 * deterministic fixer that drafts the exact change, or a question for what only a person can
 * decide (who is in a group, which of two valid routes the team wants, whether a noted situation is
 * intended). No model decides anything here.
 *
 * Adding a finding code: add an entry to WORKFLOW_FIXERS, keyed by the code.
 *
 *   CODE: {
 *     resolves: 'change' | 'question' | 'change-or-question',
 *     why: 'For a question: why the answer is a person's, in one sentence.',
 *     order: 40,                         // fixers run in this order; removals first, descriptions last
 *     group: (finding) => key,           // optional: findings with the same key are fixed together
 *     fix: async (findings, ctx) => ({ summary } | { questions: [...] } | { summary, questions })
 *   }
 *
 * A fixer edits through `ctx.draft` (src/workflow-fix/draft.mjs): `edit(target, transform)` for a
 * template, skill, instruction or agent's text, `phase(id, fields, { workflow })` for a step,
 * `workflow(id, field, value)` for a workflow, `op(op)` for any other Workflow Studio change, and
 * `remove(kind, id)`. What it touches becomes one change with its diffs. A question's choices each
 * carry `apply(draft, answer)`, run when `workflow fix --answers` names that choice. test/workflow-fix.test.mjs
 * fails for a code `workflow check` can raise that has no entry here: every quoted 'CHECK_…' literal
 * under src/, the route simulation's, phase topology's and obligation graph's codes, and the agent
 * mapping codes; and for an entry no module raises any more.
 *
 * A question is `{ ask, why, answer?, choices: [{ id, label, effect, needs?: 'people' | 'text', apply }] }`.
 * Choices never invent people, groups or reasons: people and reasons come from the answer.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { requiredArtifactSections } from '../artifact-required-sections.mjs';
import { normalizeMarkdownHeading, parseMarkdownStructure } from '../markdown-structure.mjs';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { isConvergencePhase, isVisualVerificationPhase } from '../phase-roles.mjs';
import { scanGuidanceText } from '../guidance-scan.mjs';
import { librarySkillText, parseLibrarySkill } from '../skill-library.mjs';
import { newStepTemplate } from '../step-outputs.mjs';
import { markTemplateGuidance } from '../template-guidance.mjs';
import { lineNumberOf, removeLine, retargetLink, unlinkTarget } from './text.mjs';
import {
  rebuiltPlannedTable, renumberedAnchors, templateAnchors, withClauseAnchors, withPlannedTable, withSections, withStepsColumn, withSupportedTokens, withWorkIdAnchors
} from './templates.mjs';

const PLANNED_HEADER = /^\|\s*clause\s*\|\s*expected paths\s*\|\s*planned tests\s*\|/imu;
const ROUNDS = 3;
const PEOPLE_WHY = 'Who may sign off is the team\'s decision; nothing in the repository says who belongs in a group.';
const ROUTE_WHY = 'Both are valid workflows; which one the team works by is its own decision.';
const NOTICE_WHY = 'Nothing is wrong with the configuration as written; only the team knows whether this is what it means.';

// -------------------------------------------------------------------------------------------------
// Helpers

const words = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const workflowOf = (ctx, finding) => ctx.model.workflows.find((entry) => entry.id === finding.subject?.workflow) ?? null;
const stepIn = (workflow, id) => workflow?.steps.find((step) => step.id === id) ?? null;
const labelOf = (ctx, workflow, id) => stepIn(workflow, id)?.label ?? ctx.model.phases.find((phase) => phase.id === id)?.label ?? id;
const groupLabel = (ctx, id) => ctx.model.groups.find((group) => group.id === id)?.label ?? id;
const signsOff = (step) => step && step.approval?.mode !== 'none' && (step.approval?.authorities ?? []).length > 0;

/**
 * The groups that sign off a step by rule: those of the nearest later step in the workflow that has
 * a sign-off, else the nearest earlier one. Null when no step of the workflow is signed off.
 */
function signOffGroups(workflow, stepId, blocked = new Set()) {
  const steps = (workflow?.steps ?? []).map((step) => (signsOff(step) && step.approval.authorities.some((id) => blocked.has(id))
    ? { ...step, approval: { ...step.approval, authorities: step.approval.authorities.filter((id) => !blocked.has(id)) } } : step));
  const at = steps.findIndex((step) => step.id === stepId);
  const later = steps.slice(at + 1).find(signsOff);
  const earlier = [...steps.slice(0, Math.max(at, 0))].reverse().find(signsOff);
  const chosen = later ?? earlier ?? null;
  return chosen ? { groups: [...chosen.approval.authorities], from: chosen } : null;
}

/** People as a group change writes them, from an answer's GitHub logins or email addresses. */
function members(answer) {
  const list = Array.isArray(answer?.people) ? answer.people : String(answer?.people ?? answer?.text ?? '').split(/[\s,;]+/u);
  return list.map((entry) => (typeof entry === 'object' && entry ? entry : String(entry).trim())).filter(Boolean)
    .map((entry) => (typeof entry === 'object' ? entry : entry.includes('@') ? { email: entry } : { githubLogin: entry.replace(/^@/u, '') }));
}

/** The text target that owns a guidance file: a library skill, an instruction or a repository agent. */
function guidanceTarget(ctx, file) {
  const skill = (ctx.model.skills ?? []).find((entry) => entry.path === file);
  if (skill) return { kind: 'skill', id: skill.id, label: `skill ${skill.label}` };
  const instruction = (ctx.model.instructions ?? []).find((entry) => entry.path === file);
  if (instruction) return { kind: 'instruction', id: instruction.id, label: `instruction ${instruction.label}` };
  const agent = ctx.model.agents.find((entry) => entry.scope === 'repository' && entry.path === file);
  if (agent) return { kind: 'agent', id: agent.id, label: `agent ${agent.label}` };
  return null;
}

/** Files named `name` under `directory` (inside the configuration), as paths relative to the configuration. */
function sameNamed(ctx, directory, name, exclude) {
  const found = [];
  const walk = (relative, depth) => {
    if (depth > 6 || found.length > 20) return;
    let entries = [];
    try { entries = readdirSync(path.join(ctx.configRoot, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(child, depth + 1);
      else if (entry.isFile() && entry.name === name && child !== exclude) found.push(child);
    }
  };
  walk(directory, 0);
  return found.sort();
}

const templateExists = (ctx, template) => existsSync(path.join(ctx.configRoot, ctx.templatesRoot, template));

/** What a step's template must give its author, added to `text`: anchors, the plan's table, required sections. */
function conformTemplate(text, { definesClauses, plans, sections }) {
  let next = text;
  if (definesClauses && !templateAnchors(next).length) next = withClauseAnchors(next).text;
  if (plans && !PLANNED_HEADER.test(next)) next = withPlannedTable(next).text;
  const headings = new Set(parseMarkdownStructure(next).headings.map((heading) => heading.normalized));
  const missing = sections.filter((section) => !headings.has(normalizeMarkdownHeading(section)));
  return missing.length ? withSections(next, missing) : next;
}

/** What the step's template has to hold, from the workflow as resolved. */
function templateRoles(ctx, workflowId, stepId) {
  const resolved = ctx.resolved(workflowId);
  const phase = resolved?.phases?.find((entry) => entry.id === stepId) ?? null;
  const claims = resolved?.plannedClaims?.mode === 'required' ? resolved.plannedClaims : {};
  return {
    phase,
    definesClauses: (claims.clausePhases ?? []).includes(stepId),
    plans: Object.values(claims.owners ?? {}).includes(stepId),
    sections: phase ? requiredArtifactSections(phase) : []
  };
}

/** A decision as the workflow writes it, and its index, from the draft's current decisions. */
function decisionAt(ctx, workflowId, decisionId) {
  const decisions = ctx.draft.workflowField(workflowId, 'decisions') ?? [];
  const index = decisions.findIndex((entry) => entry?.id === decisionId);
  return { decisions, index, decision: index >= 0 ? decisions[index] : null };
}

function setDecision(ctx, workflowId, decisionId, change) {
  const { decisions, index } = decisionAt(ctx, workflowId, decisionId);
  if (index < 0) return false;
  const next = structuredClone(decisions);
  next[index] = change(structuredClone(next[index]));
  ctx.draft.workflow(workflowId, 'decisions', next.filter(Boolean));
  return true;
}

/** Choices that put one existing group, or a new one with the people a person names, on a step. */
function groupChoices(ctx, { exclude = [], apply, create = null }) {
  const choices = ctx.model.groups.filter((group) => !exclude.includes(group.id) && group.status !== 'blocked').map((group) => ({
    id: `group:${group.id}`, label: group.label, effect: `${group.label} (${plural(group.members.length, 'person')}${group.githubTeams.length ? `, ${plural(group.githubTeams.length, 'team')}` : ''})`,
    apply: (draft) => apply(draft, group.id)
  }));
  if (create) {
    choices.push({ id: `create:${create.id}`, label: `A new group, ${create.label}`, needs: 'people',
      effect: `Creates the approval group ${create.label} with the people you name (GitHub logins or email addresses).`,
      apply: (draft, answer) => { draft.op({ op: 'group.create', id: create.id, label: create.label, members: members(answer) }); apply(draft, create.id); } });
  }
  return choices;
}

/** The step's sign-off as this workflow runs it, with `groups` instead: as many approvals as it asked for, else one. */
function approvalWith(step, groups) {
  return { groups, minimum: signsOff(step) ? step.approval.minimum ?? 1 : 1 };
}

const keep = (label = 'Keep it as it is') => ({ id: 'keep', label, effect: 'Nothing changes; the finding stays as a reminder.', apply: () => {} });

// -------------------------------------------------------------------------------------------------
// Fixers

async function unusedSkill([finding], ctx) {
  const id = finding.subject.skill;
  ctx.draft.remove('skill', id);
  return { summary: `Remove skill ${id} from the skill master: no agent or workflow uses it, so no step reads it. Other files in its folder stay.` };
}

async function unusedInstruction([finding], ctx) {
  if (ctx.draft.isRemoved({ kind: 'instruction', id: finding.subject.instruction })) return { summary: null };
  ctx.draft.remove('instruction', finding.subject.instruction);
  return { summary: `Remove instruction ${finding.subject.instruction}: no skill places it, so no agent reads it.` };
}

async function unusedAgent([finding], ctx) {
  const agent = ctx.model.agents.find((entry) => entry.id === finding.subject.agent);
  const imported = Object.entries(ctx.importsLedger ?? {}).find(([, entry]) => entry?.kind === 'agent' && entry?.target?.id === agent?.id);
  if (imported) ctx.draft.op({ op: 'import.remove', key: imported[0] });
  else ctx.draft.remove('agent', finding.subject.agent);
  return { summary: `Remove agent ${agent?.label ?? finding.subject.agent} (${agent?.path ?? 'its file'}): it drafts no step, reviews nothing, and the steps it lists are in no workflow.` };
}

/** An agent that names a step the configuration does not have: the step leaves its list, or the agent goes when it lists nothing else. */
async function agentUnknownStep(findings, ctx) {
  const done = [];
  for (const finding of findings) {
    const match = /Agent '([^']+)' references unknown phase '([^']+)'/u.exec(finding.detail ?? '');
    const agent = match ? ctx.model.agents.find((entry) => entry.id === match[1]) : null;
    if (!agent) continue;
    const known = new Set([...Object.keys(ctx.raw.phases ?? {}), ...ctx.model.phases.map((phase) => phase.id)]);
    const kept = agent.phases.filter((phase) => known.has(phase));
    if (kept.length) {
      ctx.draft.op({ op: 'agent.update', id: agent.id, phases: kept });
      done.push(`${agent.label} no longer lists ${words(agent.phases.filter((phase) => !known.has(phase)))}, which no workflow configuration has`);
    } else if (!agent.defaultFor.some((phase) => known.has(phase))) {
      ctx.draft.remove('agent', agent.id);
      done.push(`agent ${agent.label} (${agent.path}) is removed: every step it lists (${words(agent.phases)}) is one the configuration does not have`);
    }
  }
  return { summary: done.length ? `${done.join('; ')}.` : null };
}

async function duplicateInstruction([finding], ctx) {
  // Keep the one a skill already places (the first when both or neither are), so nothing that reads it changes.
  const pair = [(ctx.model.instructions ?? []).find((item) => item.path === finding.related?.[0]?.file), (ctx.model.instructions ?? []).find((item) => item.id === finding.subject.instruction)];
  if (!pair[0] || !pair[1] || pair[0].id === pair[1].id) return { summary: null };
  const [keptItem, gone] = !pair[0].usedBy?.length && pair[1].usedBy?.length ? [pair[1], pair[0]] : pair;
  const kept = keptItem.id;
  const duplicate = gone.id;
  if (ctx.draft.isRemoved({ kind: 'instruction', id: duplicate })) return { summary: null };
  const users = (ctx.model.skills ?? []).filter((skill) => (skill.instructionRefs ?? []).includes(duplicate));
  for (const skill of users) {
    await ctx.draft.edit({ kind: 'skill', id: skill.id }, (text) => {
      const parsed = parseLibrarySkill(text, { id: skill.id });
      const swap = (id) => (id === duplicate ? kept : id);
      return librarySkillText({ id: skill.id, label: parsed.label, description: parsed.description, loading: parsed.loading, tags: parsed.tags,
        instructions: parsed.instructions.replaceAll(`<instruction>${duplicate}</instruction>`, `<instruction>${kept}</instruction>`),
        instructionRefs: [...new Set(parsed.declaredInstructionRefs.map(swap))] });
    });
  }
  ctx.draft.remove('instruction', duplicate);
  return { summary: `Keep instruction ${kept} and remove ${duplicate}, which says the same thing${users.length ? `; ${words(users.map((skill) => skill.id))} place ${kept} instead` : ''}.` };
}

async function skillStepUnused([finding], ctx) {
  const agent = ctx.model.agents.find((entry) => entry.id === finding.subject.agent);
  const use = agent?.skills?.find((entry) => entry.id === finding.subject.skill);
  if (!agent || !use) return { summary: null };
  const usedSteps = new Set(ctx.model.workflows.flatMap((workflow) => workflow.phases));
  const strays = (use.phases ?? []).filter((phase) => !agent.defaultFor.includes(phase) && usedSteps.has(phase));
  if (!strays.length) return { summary: null };
  const remaining = (use.phases ?? []).filter((phase) => !strays.includes(phase));
  const keepOnAgent = (draft) => draft.op(remaining.length ? { op: 'skill.attach', skill: use.id, agent: agent.id, phases: remaining, use: use.use || '' } : { op: 'skill.detach', skill: use.id, agent: agent.id });
  const attachTo = (draft, workflows) => {
    for (const workflow of workflows) {
      const existing = (workflow.skills ?? []).find((entry) => entry.id === use.id);
      if (existing && !existing.phases.length) continue;
      draft.op({ op: 'skill.attach', skill: use.id, workflow: workflow.id, phases: [...new Set([...(existing?.phases ?? []), ...strays.filter((phase) => workflow.phases.includes(phase))])], use: use.use || existing?.use || '' });
    }
    keepOnAgent(draft);
  };
  const withStrays = ctx.model.workflows.filter((workflow) => workflow.phases.some((phase) => strays.includes(phase)));
  // The workflows the agent works in: they use a stray step and a step the agent drafts.
  const home = withStrays.filter((workflow) => workflow.phases.some((phase) => agent.defaultFor.includes(phase)));
  if (home.length) {
    attachTo(ctx.draft, home);
    return { summary: `Attach skill ${use.id} to ${words(home.map((workflow) => `${workflow.label} for ${strays.filter((phase) => workflow.phases.includes(phase)).join(', ')}`))}, the workflow${home.length === 1 ? '' : 's'} ${agent.label} works in, so whichever agent drafts ${strays.length === 1 ? 'that step' : 'those steps'} reads it; ${agent.label} keeps it ${remaining.length ? `for ${remaining.join(', ')}` : 'for none of its steps'}.` };
  }
  return { questions: [{ ask: `Skill ${use.id} is attached to ${agent.label} for ${words(strays)}, which ${agent.label} does not draft, in workflows it does not work in (${words(withStrays.map((workflow) => workflow.label))}). Should those workflows read it there?`,
    why: 'Whether a skill belongs in other teams\' workflows is a decision for the people who own them.',
    choices: [{ id: 'attach', label: `Yes: attach it to ${plural(withStrays.length, 'workflow')} for ${words(strays)}`, effect: `Whichever agent drafts ${words(strays)} in ${words(withStrays.map((workflow) => workflow.label))} reads ${use.id}.`, apply: (draft) => attachTo(draft, withStrays) },
      { id: 'agent-only', label: `No: ${use.id} only for the steps ${agent.label} drafts`, effect: `${agent.label} no longer lists ${words(strays)} for ${use.id}.`, apply: keepOnAgent }, keep()] }] };
}

async function templateTokens(findings, ctx) {
  const template = findings[0].subject.template;
  let replaced = [];
  await ctx.draft.edit({ kind: 'template', path: template }, (text) => { const result = withSupportedTokens(text); replaced = result.replaced; return result.text; });
  const said = replaced.map((entry) => (entry.to ? `${entry.from} becomes ${entry.to}` : `${entry.from} becomes a TODO in words`));
  return { summary: `Template ${template}: only tokens step entry fills (${said.join('; ') || 'nothing left to change'}).` };
}

async function templateAnchorsFix(findings, ctx) {
  const [finding] = findings;
  const template = finding.subject.template;
  const target = { kind: 'template', path: template };
  const text = await ctx.draft.text(target);
  if (text == null) return { summary: null };
  if (!templateAnchors(text).length) {
    let added = [];
    await ctx.draft.edit(target, (current) => { const result = withClauseAnchors(current); added = result.added; return result.text; });
    return { summary: `Template ${template}: a requirement anchor and an acceptance-criterion anchor, each on a TODO placeholder line for the Story's author to replace${added.length ? ` (adds the ${words(added)} section${added.length === 1 ? '' : 's'})` : ''}. The template's own sections stay.` };
  }
  // Anchors that are there but refused: defined twice, in another namespace, or again after an earlier step.
  const workflow = workflowOf(ctx, finding);
  const resolved = ctx.resolved(workflow?.id);
  const before = (resolved?.plannedClaims?.clausePhases ?? []).filter((id) => resolved.phases.findIndex((phase) => phase.id === id) < resolved.phases.findIndex((phase) => phase.id === finding.subject.step));
  const taken = [];
  for (const id of before) {
    const phase = resolved.phases.find((entry) => entry.id === id);
    const earlier = phase?.template ? await ctx.draft.text({ kind: 'template', path: phase.template }) : null;
    if (earlier) taken.push(...templateAnchors(earlier));
  }
  await ctx.draft.edit(target, (current) => renumberedAnchors(current, taken));
  return { summary: `Template ${template}: each clause anchor written once as [{{work.id}}:<TYPE>-<NNN>], numbered after the clauses earlier steps define.` };
}

/** Anchors under a fixed name take each Story's Work ID, citations of them too [office, 2026-11-12]. */
async function templateNamespaceFix([finding], ctx) {
  const template = finding.subject.template;
  const allowed = ctx.resolved(workflowOf(ctx, finding)?.id)?.spec?.namespace ?? null;
  await ctx.draft.edit({ kind: 'template', path: template }, (text) => withWorkIdAnchors(text, { allowed }));
  return { summary: `Template ${template}: each clause anchor under a fixed name now opens with {{work.id}}, so every Story's clauses carry its own ID; numbers and wording are kept.` };
}

async function templatePlannedTable(findings, ctx) {
  const [finding] = findings;
  const template = finding.subject.template;
  const target = { kind: 'template', path: template };
  const text = await ctx.draft.text(target);
  if (text == null) return { summary: null };
  if (!PLANNED_HEADER.test(text)) {
    await ctx.draft.edit(target, (current) => withPlannedTable(current).text);
    return { summary: `Template ${template}: the planned-claims table the kernel reads (| Clause | Expected paths | Planned tests | Fulfillment | Observable result |), one TODO placeholder row per clause anchor, for the Story's author to fill.` };
  }
  await ctx.draft.edit(target, (current) => rebuiltPlannedTable(current, finding.location?.line ?? 1) ?? current);
  return { summary: `Template ${template}: its planned-claims table rewritten in the form the kernel reads; the cells its rows had are kept, and the rest say TODO.` };
}

async function templateSections(findings, ctx) {
  const [finding] = findings;
  const template = finding.subject.template;
  const { sections } = templateRoles(ctx, finding.subject.workflow, finding.subject.step);
  let added = [];
  await ctx.draft.edit({ kind: 'template', path: template }, (text) => {
    const headings = new Set(parseMarkdownStructure(text).headings.map((heading) => heading.normalized));
    added = sections.filter((section) => !headings.has(normalizeMarkdownHeading(section)));
    return added.length ? withSections(text, added) : text;
  });
  return { summary: `Template ${template}: the section${added.length === 1 ? '' : 's'} its publication checks for (${words(added.map((section) => `"${section}"`))}), each with a TODO line.` };
}

// Guidance a published document would keep, or that wraps: each paragraph on one line inside the marker
// publication removes (template-guidance.mjs). The template's own words are unchanged.
async function templateGuidance([finding], ctx) {
  const template = finding.subject.template;
  await ctx.draft.edit({ kind: 'template', path: template }, (text) => markTemplateGuidance(text).text);
  return { summary: `Template ${template}: each guidance paragraph on one line inside <!-- sflow:guidance ... -->, so publication removes it.` };
}

async function templateMissing([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const stepId = finding.subject.step;
  const roles = templateRoles(ctx, workflow?.id, stepId);
  const label = labelOf(ctx, workflow, stepId);
  const template = finding.subject.template;
  const packaged = path.join(PACKAGE_ROOT, 'templates', 'artifacts', template);
  const starter = /does not exist/u.test(finding.title) && existsSync(packaged) && statSync(packaged).isFile()
    ? (await import('node:fs/promises')).readFile(packaged, 'utf8') : newStepTemplate(stepId, label);
  const content = conformTemplate(await starter, roles);
  if (/does not exist/u.test(finding.title) && !template.startsWith('../') && !path.posix.isAbsolute(template)) {
    ctx.draft.create({ kind: 'template', path: template }, content);
    return { summary: `Create template ${template} for ${label}${existsSync(packaged) ? ' from the packaged one' : ' from the starter'}, with what the step's publication reads as placeholders.` };
  }
  let name = `${workflow?.id ?? 'steps'}/${stepId}.md`;
  for (let number = 2; templateExists(ctx, name) || ctx.draft.has({ kind: 'template', path: name }); number += 1) name = `${workflow?.id ?? 'steps'}/${stepId}-${number}.md`;
  ctx.draft.create({ kind: 'template', path: name }, content);
  ctx.draft.phase(stepId, { template: name }, { workflow: workflow?.id });
  return { summary: `Give ${label} a template of its own, ${name} (the one it names ${finding.title.replace(/^The template of .*? /u, '')}), with what the step's publication reads as placeholders.` };
}

async function brokenLinks(findings, ctx) {
  const file = findings[0].subject.file;
  const target = guidanceTarget(ctx, file);
  if (!target) {
    return { questions: [{ ask: `${file} links to files that do not exist, and it is not a skill, instruction or agent Workflow Studio edits. Take the links out by hand?`,
      why: 'Workflow Studio has no change for this file, so only a person can edit it.', choices: [keep()] }] };
  }
  if (ctx.draft.isRemoved(target)) return { summary: null };
  const text = await ctx.draft.text(target);
  if (text == null) return { summary: null };
  const directory = path.posix.dirname(file);
  const broken = scanGuidanceText(text).links.filter((link) => link.kind === 'relative' && link.target).filter((link) => {
    const resolved = path.posix.normalize(path.posix.join(directory, link.target));
    return !resolved.startsWith('../') && !path.posix.isAbsolute(resolved) && !existsSync(path.join(ctx.configRoot, resolved));
  });
  const done = [];
  const questions = [];
  let next = text;
  const original = text.split('\n');
  // A choice applied after other edits finds its line by what it said.
  const at = (current, link) => lineNumberOf(current, original[link.line - 1], link.line) || link.line;
  for (const link of broken) {
    const candidates = sameNamed(ctx, directory, path.posix.basename(link.target), file);
    if (candidates.length === 1) {
      const replacement = path.posix.relative(directory, candidates[0]);
      next = retargetLink(next, link.line, link.target, replacement) ?? next;
      done.push(`${link.target} now points at ${replacement}, the file of that name in the same folder`);
    } else if (!candidates.length) {
      next = unlinkTarget(next, link.line, link.target) ?? next;
      done.push(`${link.target} keeps its words without the link (line ${link.line})`);
    } else {
      questions.push({ ask: `In ${file} line ${link.line}, ${link.target} does not exist, and ${candidates.length} files of that name do: which one does the link mean?`,
        why: 'Several files have that name; which one the author meant is not written anywhere.',
        choices: [...candidates.map((candidate) => ({ id: `link:${candidate}`, label: candidate, effect: `The link points at ${candidate}.`,
          apply: (draft) => draft.edit(target, (current) => retargetLink(current, at(current, link), link.target, path.posix.relative(directory, candidate)) ?? current) })),
        { id: 'unlink', label: 'Remove the link, keep its words', effect: 'The link markup goes; its words stay.',
          apply: (draft) => draft.edit(target, (current) => unlinkTarget(current, at(current, link), link.target) ?? current) }] });
    }
  }
  if (next !== text) await ctx.draft.edit(target, () => next);
  return { summary: done.length ? `In ${target.label} (${file}): ${done.join('; ')}.` : null, questions };
}

async function undescribedSteps([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const explained = new Map((ctx.check.workflows.find((entry) => entry.id === workflow?.id)?.explanation?.steps ?? []).map((step) => [step.id, step]));
  const protectedSteps = new Set(ctx.model.protection?.phases ?? []);
  const written = [];
  for (const step of workflow?.steps ?? []) {
    if (step.description || protectedSteps.has(step.id) || ctx.draft.describes(step.id)) continue;
    const what = String(explained.get(step.id)?.what ?? '').replace(/\s+/gu, ' ').trim();
    if (!what) continue;
    ctx.draft.phase(step.id, { description: what.slice(0, 600) });
    written.push(`${step.label}: "${what.slice(0, 600)}"`);
  }
  return { summary: written.length ? `Describe each step with what the check says it does (edit a description to say why the step is there):\n${written.map((line) => `- ${line}`).join('\n')}` : null };
}

async function duplicateLabel([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  // The steps that share the name, from "Steps a, b share a name"; a step SFlow protects keeps its name.
  const ids = /^Steps (.+) share a name/u.exec(finding.detail ?? '')?.[1]?.split(/,\s*/u) ?? [finding.subject.step];
  const protectedSteps = new Set(ctx.model.protection?.phases ?? []);
  const step = stepIn(workflow, [...ids].reverse().find((id) => !protectedSteps.has(id)) ?? finding.subject.step);
  if (!step) return { summary: null };
  const label = `${step.label} (${step.id})`.slice(0, 120);
  ctx.draft.phase(step.id, { label });
  return { summary: `Rename ${step.id}, one of the steps called ${step.label}, to ${label}, so people can tell them apart.` };
}

async function stepAgent([finding], ctx) {
  const stepId = finding.subject.step;
  const phase = ctx.model.phases.find((entry) => entry.id === stepId);
  const label = phase?.label ?? stepId;
  const named = finding.subject.agents?.length ? finding.subject.agents : null;
  const ambiguous = finding.code === 'AGENT_PHASE_DEFAULT_AMBIGUOUS';
  const candidates = (named ?? phase?.eligibleAgents ?? []).map((id) => ctx.model.agents.find((agent) => agent.id === id) ?? { id, label: id });
  const assign = (agentId) => (draft) => draft.op({ op: 'phase.agent', phase: stepId, agent: agentId });
  if (!ambiguous && candidates.length === 1) {
    assign(candidates[0].id)(ctx.draft);
    return { summary: `${candidates[0].label} drafts ${label}: it is the one agent that can.` };
  }
  if (!ambiguous && !candidates.length) {
    const id = `${stepId}-author`.slice(0, 64);
    ctx.draft.op({ op: 'agent.create', id, label: `${label} author`.slice(0, 120), description: `Drafts ${label}.`, role: 'blank' });
    assign(id)(ctx.draft);
    return { summary: `A new agent, ${label} author (.github/agents/${id}.agent.md), drafts ${label}: no agent can draft it now. Its instructions are the blank starter; say there how the step is drafted.` };
  }
  return { questions: [{ ask: `Which agent drafts ${label}?`, why: ambiguous ? `${plural(candidates.length, 'agent')} each say they draft it; which one the team meant is its decision.` : 'Several agents can draft it; which one the team wants is its decision.',
    choices: candidates.map((agent) => ({ id: `agent:${agent.id}`, label: agent.label ?? agent.id, effect: `${agent.label ?? agent.id} drafts ${label}${ambiguous ? '; the others stop claiming it' : ''}.`, apply: assign(agent.id) })) }] };
}

/** A sign-off for a step by rule (the nearest signed-off step's groups), or the question when no step has one. */
function signOff(ctx, finding, stepId, why) {
  const workflow = workflowOf(ctx, finding);
  const step = stepIn(workflow, stepId);
  const label = labelOf(ctx, workflow, stepId);
  const ruled = signOffGroups(workflow, stepId, new Set(ctx.model.groups.filter((group) => group.status === 'blocked').map((group) => group.id)));
  const apply = (draft, groups) => draft.phase(stepId, { approval: { ...approvalWith(step, groups), rejectTo: [stepId] } }, { workflow: workflow?.id });
  if (ruled) {
    apply(ctx.draft, ruled.groups);
    return { summary: `Ask ${words(ruled.groups.map((id) => groupLabel(ctx, id)))} to sign off ${label}, the group${ruled.groups.length === 1 ? '' : 's'} that sign${ruled.groups.length === 1 ? 's' : ''} off ${ruled.from.label}, the nearest step with a sign-off; ${why}` };
  }
  return { questions: [{ ask: `Who signs off ${label}?`, why: 'No step of this workflow has a sign-off to follow, and who reviews the work is the team\'s decision.',
    choices: groupChoices(ctx, { apply: (draft, group) => apply(draft, [group]), create: { id: `${workflow?.id ?? 'workflow'}-reviewers`.slice(0, 64), label: `${workflow?.label ?? 'Workflow'} reviewers`.slice(0, 120) } }) }] };
}

async function codeWithoutSignOff([finding], ctx) {
  return signOff(ctx, finding, finding.subject.step, 'rejected work goes back to the step itself.');
}

async function reviewGap([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const at = workflow?.phases.indexOf(finding.subject.step) ?? -1;
  // A step someone signs off already: the review missing is on a route after it, at the first step nobody signs off.
  const target = signsOff(stepIn(workflow, finding.subject.step)) ? workflow.steps.slice(at + 1).find((step) => !signsOff(step) && !ctx.draft.signedOff(step.id))?.id : finding.subject.step;
  if (!target || ctx.draft.signedOff(target)) return { summary: null };
  return signOff(ctx, finding, target, 'a person then reviews what reaches the end there.');
}

async function blockedGroup(findings, ctx) {
  const id = findings[0].subject.group;
  const group = ctx.model.groups.find((entry) => entry.id === id);
  return { questions: [{ ask: `Who belongs in ${group?.label ?? id}? Name their GitHub logins or email addresses.`, why: PEOPLE_WHY,
    answer: { kind: 'people' },
    choices: [{ id: 'people', label: `These people sign off as ${group?.label ?? id}`, needs: 'people', effect: `${group?.label ?? id} gets the people you name.`,
      apply: (draft, answer) => draft.op({ op: 'group.update', id, members: [...(group?.members ?? []).filter((member) => member.email || member.githubLogin), ...members(answer)] }) }] }] };
}

async function lastStepNoSignOff([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const step = stepIn(workflow, finding.subject.step);
  const used = [...new Set((workflow?.steps ?? []).filter(signsOff).flatMap((entry) => entry.approval.authorities))];
  return { questions: [{ ask: `Should someone sign off ${step?.label ?? finding.subject.step}, the last step, before the Story ends?`,
    why: 'A workflow may end as soon as its last step is submitted; whether the team wants a sign-off there is its decision.',
    choices: [keep('No: the Story ends when the last step is submitted'),
      ...used.map((group) => ({ id: `group:${group}`, label: `Yes: ${groupLabel(ctx, group)} signs it off`, effect: `${groupLabel(ctx, group)} signs off ${step?.label}.`,
        apply: (draft) => draft.phase(step.id, { approval: { ...approvalWith(step, [group]), rejectTo: [step.id] } }, { workflow: workflow.id }) }))] }] };
}

async function rejectionTarget([finding], ctx) {
  const changes = finding.fix?.changes ?? [];
  for (const change of changes) {
    const { op, id, workflow, ...fields } = change;
    if (op === 'phase.update') ctx.draft.phase(id, fields, { workflow });
    else ctx.draft.op(change);
  }
  return { summary: changes.length ? finding.fix.text : null, questions: changes.length ? [] : [{ ask: finding.title, why: ROUTE_WHY, choices: [keep()] }] };
}

async function unknownAuthority([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const unknown = /'([a-z0-9-]+)', which is not a declared approval authority/u.exec(finding.detail ?? '')?.[1] ?? null;
  const replace = (list) => (draft, group) => [...new Set(list.map((entry) => (entry === unknown ? group : entry)))];
  if (finding.subject.decision) {
    const { decision } = decisionAt(ctx, workflow.id, finding.subject.decision);
    return { questions: [{ ask: `"${decision?.label ?? finding.subject.decision}" names the group '${unknown}', which does not exist. Who decides there?`, why: PEOPLE_WHY,
      choices: groupChoices(ctx, { apply: (draft, group) => setDecision({ ...ctx, draft }, workflow.id, finding.subject.decision, (entry) => ({ ...entry, by: replace(entry.by ?? [])(draft, group) })),
        create: unknown ? { id: unknown, label: unknown.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') } : null }) }] };
  }
  const step = stepIn(workflow, finding.subject.step);
  const groups = step?.approval?.authorities ?? [];
  return { questions: [{ ask: `${step?.label ?? finding.subject.step} is signed off by '${unknown}', a group that does not exist. Which group signs it off?`, why: PEOPLE_WHY,
    choices: groupChoices(ctx, { apply: (draft, group) => draft.phase(step.id, { approval: approvalWith(step, replace(groups)(draft, group)) }, { workflow: workflow.id }),
      create: unknown ? { id: unknown, label: unknown.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') } : null }) }] };
}

/** A decision that goes back owned and bounded: `by` the groups that sign off the step it follows, at most ROUNDS rounds. */
function boundDecision(ctx, workflow, decision) {
  const after = stepIn(workflow, decision.after);
  const by = decision.by?.length ? decision.by : signsOff(after) ? [...after.approval.authorities] : null;
  if (!by) return null;
  setDecision(ctx, workflow.id, decision.id, (entry) => ({ ...entry, by, ...(entry.maxRounds == null ? { maxRounds: ROUNDS } : {}) }));
  return { by, rounds: decision.maxRounds ?? ROUNDS };
}

async function decisionOwner([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const { decision } = decisionAt(ctx, workflow.id, finding.subject.decision);
  if (!decision) return { summary: null };
  const bound = boundDecision(ctx, workflow, decision);
  if (bound) return { summary: `"${decision.label ?? decision.id}" pauses for ${words(bound.by.map((id) => groupLabel(ctx, id)))} (who sign off ${labelOf(ctx, workflow, decision.after)}) after ${bound.rounds} rounds.` };
  return { questions: [{ ask: `Who decides what happens when "${decision.label ?? decision.id}" runs out of rounds?`, why: 'The step it follows has no sign-off to follow, and who decides is the team\'s decision.',
    choices: groupChoices(ctx, { apply: (draft, group) => setDecision({ ...ctx, draft }, workflow.id, decision.id, (entry) => ({ ...entry, by: [group], ...(entry.maxRounds == null ? { maxRounds: ROUNDS } : {}) })) }) }] };
}

async function unboundedRoutes([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const bound = [];
  for (const decision of ctx.draft.workflowField(workflow.id, 'decisions') ?? []) {
    if (decision?.mode === 'ask' || decision?.maxRounds != null) continue;
    if (!(decision?.routes ?? []).some((route) => workflow.phases.indexOf(route.to) >= 0 && workflow.phases.indexOf(route.to) <= workflow.phases.indexOf(decision.after))) continue;
    if (boundDecision(ctx, workflow, decision)) bound.push(decision.label ?? decision.id);
  }
  if (bound.length) return { summary: `${words(bound.map((entry) => `"${entry}"`))} go${bound.length === 1 ? 'es' : ''} back at most ${ROUNDS} rounds, then pause${bound.length === 1 ? 's' : ''} for the people who sign off the step before.` };
  return { questions: [{ ask: 'A route repeats without a limit. Which decision should stop after a number of rounds?', why: ROUTE_WHY, choices: [keep()] }] };
}

async function unreachableRoute([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const { decision } = decisionAt(ctx, workflow.id, finding.subject.decision);
  const route = /route '([^']+)'/u.exec(finding.detail ?? '')?.[1];
  if (!decision || !route) return { questions: [{ ask: finding.title, why: ROUTE_WHY, choices: [keep()] }] };
  const edit = (change) => (draft) => setDecision({ ...ctx, draft }, workflow.id, decision.id, change);
  return { questions: [{ ask: `In "${decision.label ?? decision.id}", the route ${route} can never be taken: an earlier route's rule always holds first. What should happen to it?`, why: ROUTE_WHY,
    choices: [
      { id: 'first', label: `Check ${route} first`, effect: `${route} moves before the routes whose rule always holds.`, apply: edit((entry) => ({ ...entry, routes: [entry.routes.find((item) => item.id === route), ...entry.routes.filter((item) => item.id !== route)] })) },
      { id: 'remove', label: `Remove ${route}`, effect: `${route} is taken out of the decision.`, apply: edit((entry) => ({ ...entry, routes: entry.routes.filter((item) => item.id !== route) })) },
      keep()] }] };
}

async function unreachableStep([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const label = labelOf(ctx, workflow, finding.subject.step);
  return { questions: [{ ask: `No route reaches ${label}. Take it out of ${workflow.label}, or route a decision to it?`, why: ROUTE_WHY,
    choices: [{ id: 'remove', label: `Take ${label} out of ${workflow.label}`, effect: `${workflow.label} no longer lists ${label}; the step itself stays for other workflows.`,
      apply: (draft) => draft.workflow(workflow.id, 'phases', (draft.workflowField(workflow.id, 'phases') ?? workflow.phases).filter((id) => id !== finding.subject.step)) },
    keep('Keep it; route a decision to it in Workflow Studio')] }] };
}

async function routeNoEnd([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  if (finding.subject.decision) {
    const { decision } = decisionAt(ctx, workflow.id, finding.subject.decision);
    const route = /Taking '([^']+)'/u.exec(finding.detail ?? '')?.[1];
    const edit = (to) => (draft) => setDecision({ ...ctx, draft }, workflow.id, decision.id, (entry) => ({ ...entry, routes: entry.routes.map((item) => (item.id === route ? { ...item, to } : item)) }));
    if (decision && route) {
      return { questions: [{ ask: `Taking ${route} at "${decision.label ?? decision.id}" never reaches the end. Where should it go?`, why: ROUTE_WHY,
        choices: [{ id: 'next', label: 'On to the next step', effect: `${route} continues with the step after ${labelOf(ctx, workflow, decision.after)}.`, apply: edit('next') },
          { id: 'end', label: 'End the Story', effect: `${route} ends the Story.`, apply: edit('end') }, keep()] }] };
    }
  }
  if (finding.subject.step) {
    const step = stepIn(workflow, finding.subject.step);
    return { questions: [{ ask: `After ${step?.label} is rejected, the run never reaches the end. Send rejected work back to ${step?.label} itself?`, why: ROUTE_WHY,
      choices: [{ id: 'self', label: `Back to ${step?.label} itself`, effect: `Rejecting ${step?.label} redoes it.`,
        apply: (draft) => draft.phase(step.id, { approval: { ...approvalWith(step, step.approval.authorities), rejectTo: [step.id] } }, { workflow: workflow.id }) }, keep()] }] };
  }
  return { questions: [{ ask: `${finding.title}: ${finding.detail}`, why: ROUTE_WHY, choices: [keep()] }] };
}

async function proofOutput([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const label = labelOf(ctx, workflow, finding.subject.step);
  // An analysis step stays one; any other writes its document again.
  const output = ctx.raw.phases?.[finding.subject.step]?.generation?.task === 'analyze' ? 'analysis' : 'document';
  ctx.draft.phase(finding.subject.step, { output });
  return { summary: `${label} writes its ${output === 'analysis' ? 'analysis' : 'document'} again instead of being sign-off only, which this kind of step cannot be.` };
}

async function keepOneStep(findings, ctx) {
  const [finding] = findings;
  const workflow = workflowOf(ctx, finding);
  const kind = finding.code === 'WORKFLOW_VISUAL_MULTIPLE_UNSUPPORTED' ? 'visual-evidence' : 'Convergence';
  const resolved = ctx.resolved(workflow.id);
  const same = (resolved?.phases ?? []).filter(kind === 'Convergence' ? isConvergencePhase : isVisualVerificationPhase).map((phase) => phase.id);
  const candidates = same.length > 1 ? same : [finding.subject.step];
  return { questions: [{ ask: `${workflow.label} has more than one ${kind} step, and only one is supported. Which one stays?`, why: ROUTE_WHY,
    choices: candidates.map((id) => ({ id: `keep:${id}`, label: `Keep ${labelOf(ctx, workflow, id)}`, effect: `The other ${kind} steps leave ${workflow.label}.`,
      apply: (draft) => draft.workflow(workflow.id, 'phases', (draft.workflowField(workflow.id, 'phases') ?? workflow.phases).filter((step) => step === id || !candidates.includes(step))) })) }] };
}

async function convergenceSource([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const stepId = finding.subject.step;
  const label = labelOf(ctx, workflow, stepId);
  const code = workflow.steps.filter((step) => step.output === 'code').map((step) => step.id);
  const lastCode = code.at(-1);
  const choices = [{ id: 'remove', label: `Take ${label} out`, effect: `${workflow.label} reviews with an ordinary document review instead.`,
    apply: (draft) => draft.workflow(workflow.id, 'phases', (draft.workflowField(workflow.id, 'phases') ?? workflow.phases).filter((id) => id !== stepId)) }];
  if (lastCode) {
    choices.push({ id: 'move', label: `Move ${label} after ${labelOf(ctx, workflow, lastCode)}`, effect: `${label} reconciles the code ${labelOf(ctx, workflow, lastCode)} delivers.`,
      apply: (draft) => {
        const phases = (draft.workflowField(workflow.id, 'phases') ?? workflow.phases).filter((id) => id !== stepId);
        phases.splice(phases.indexOf(lastCode) + 1, 0, stepId);
        draft.workflow(workflow.id, 'phases', phases);
      } });
  }
  return { questions: [{ ask: `${label} reconciles code, and no step before it delivers any. Take it out, or move it after the code step?`, why: ROUTE_WHY, choices }] };
}

async function plannedClaims([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const resolved = ctx.resolved(workflow.id);
  if (resolved?.plannedClaims?.mode === 'retired-opt-out') {
    ctx.draft.workflow(workflow.id, 'plannedClaims', 'infer');
    return { summary: `${workflow.label} no longer opts out of planned claims (retired); the engine works out its clause steps and planners from its steps.` };
  }
  return omitOrAddStep(ctx, workflow, finding, 'scope');
}

/** Two valid routes for a route that lacks a responsibility: add the step that holds it, or say why it does not apply. */
function omitOrAddStep(ctx, workflow, finding, responsibility) {
  const code = workflow.steps.find((step) => step.output === 'code');
  const requirements = ctx.model.phases.filter((phase) => phase.definesClauses && !workflow.phases.includes(phase.id));
  const choices = [];
  if (responsibility === 'scope' && code) {
    for (const phase of requirements.slice(0, 4)) {
      choices.push({ id: `add:${phase.id}`, label: `Add ${phase.label} before ${code.label}`, effect: `${phase.label} defines the requirement clauses ${code.label} traces to.`,
        apply: (draft) => {
          const phases = [...(draft.workflowField(workflow.id, 'phases') ?? workflow.phases)];
          phases.splice(phases.indexOf(code.id), 0, phase.id);
          draft.workflow(workflow.id, 'phases', phases);
        } });
    }
  }
  const authorities = ctx.model.groups.filter((group) => group.status !== 'blocked');
  for (const group of authorities.slice(0, 6)) {
    choices.push({ id: `omit:${group.id}`, label: `${workflow.label} needs no ${responsibility}; ${group.label} records why`, needs: 'text',
      effect: `Declares omits for ${responsibility} with the reason you give (at least 20 characters), decided by ${group.label}.`,
      apply: (draft, answer) => draft.workflow(workflow.id, 'omits', [...(draft.workflowField(workflow.id, 'omits') ?? []).filter((entry) => entry?.responsibility !== responsibility),
        { responsibility, reason: String(answer?.text ?? '').trim(), authority: group.id }]) });
  }
  return { questions: [{ ask: `${finding.title}. Add a step that holds it, or declare that ${workflow.label} does not need it?`, why: ROUTE_WHY, choices }] };
}

async function routeDropsResponsibility([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const missing = /without (.+)\.$/u.exec(finding.detail ?? '')?.[1] ?? 'it';
  const names = ['scope', 'plan', 'implement', 'verify', 'review'].filter((name) => (finding.detail ?? '').includes({ scope: 'requirement', plan: 'plan', implement: 'implement', verify: 'verif', review: 'review' }[name]));
  if (names.length === 1 && names[0] === 'review' && finding.subject.step) return reviewGap([finding], ctx);
  const result = omitOrAddStep(ctx, workflow, finding, names[0] ?? 'scope');
  result.questions[0].ask = `${finding.title} (${missing}). Add the steps that hold it, or declare on that route that it does not apply?`;
  return result;
}

async function implementWithoutPlan([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const stepId = finding.subject.step;
  const order = ctx.draft.workflowField(workflow.id, 'phases') ?? workflow.phases;
  const before = order[order.indexOf(stepId) - 1];
  const planner = stepIn(workflow, before);
  const resolved = ctx.resolved(workflow.id);
  const claims = resolved?.plannedClaims ?? {};
  if (planner && planner.output !== 'code' && (claims.clausePhases ?? []).length) {
    ctx.draft.workflow(workflow.id, 'plannedClaims', { clausePhases: [...claims.clausePhases], owners: { ...(claims.owners ?? {}), [stepId]: planner.id } });
    return { summary: `${planner.label}, the step just before ${labelOf(ctx, workflow, stepId)}, plans its claims (plannedClaims.owners).` };
  }
  return omitOrAddStep(ctx, workflow, finding, 'plan');
}

async function omitInvalid([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  return { questions: [{ ask: `${finding.detail} What is the reason, and which group records that decision?`, why: 'Why a responsibility does not apply is the team\'s own reasoning; nothing in the repository says it.',
    answer: { kind: 'text' },
    choices: ctx.model.groups.filter((group) => group.status !== 'blocked').slice(0, 6).map((group) => ({ id: `omit:${group.id}`, label: `${group.label} records it`, needs: 'text',
      effect: 'Every incomplete omits entry of the workflow gets this reason (at least 20 characters) and group.',
      apply: (draft, answer) => draft.workflow(workflow.id, 'omits', (draft.workflowField(workflow.id, 'omits') ?? []).map((entry) => ({ responsibility: entry?.responsibility,
        reason: String(entry?.reason ?? '').trim().length >= 20 ? entry.reason : String(answer?.text ?? '').trim(), authority: ctx.model.groups.some((item) => item.id === entry?.authority) ? entry.authority : group.id }))) })) }] };
}

async function omitUnnecessary([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const met = /omits (.+), which every route/u.exec(finding.detail ?? '')?.[1] ?? '';
  const names = ['scope', 'plan', 'implement', 'verify', 'review'].filter((name) => met.includes(name));
  const route = /route '([^']+)'/u.exec(finding.detail ?? '')?.[1];
  if (finding.subject.decision && route) {
    setDecision(ctx, workflow.id, finding.subject.decision, (entry) => ({ ...entry, routes: entry.routes.map((item) => {
      if (item.id !== route) return item;
      const omits = (item.omits ?? []).filter((omit) => !names.includes(omit?.responsibility));
      const { omits: _drop, ...rest } = item;
      return omits.length ? { ...rest, omits } : rest;
    }) }));
  } else {
    ctx.draft.workflow(workflow.id, 'omits', (ctx.draft.workflowField(workflow.id, 'omits') ?? []).filter((omit) => !names.includes(omit?.responsibility)));
  }
  return { summary: `Remove the omission of ${words(names)}: every route there already meets ${names.length === 1 ? 'it' : 'them'}, so nobody is asked to decide it does not apply.` };
}

async function emptyWorkflow([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  return { questions: [{ ask: `${workflow?.label ?? 'This workflow'} has no steps. Which steps does it run?`, why: 'What a workflow is for is the team\'s decision.',
    answer: { kind: 'text' }, choices: [{ id: 'steps', label: 'These steps, in order', needs: 'text', effect: 'The workflow lists the step IDs you name.',
      apply: (draft, answer) => draft.workflow(workflow.id, 'phases', String(answer?.text ?? '').split(/[\s,]+/u).filter(Boolean)) }] }] };
}

async function reviewPhasesSuperseded([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const written = ctx.draft.workflowField(workflow.id, 'sourceReview') ?? {};
  const { phases: legacy = [], ...rest } = written;
  const resolved = ctx.resolved(workflow.id);
  const kinds = resolved?.sourceReview?.kinds ?? {};
  const own = legacy.filter((id) => kinds[id] && kinds[id] !== 'document' && kinds[id] !== 'code');
  const apply = (draft) => draft.workflow(workflow.id, 'sourceReview', Object.keys(rest).length ? rest : null);
  if (!own.length) {
    apply(ctx.draft);
    return { summary: `Remove ${workflow.label}'s review list (sourceReview.phases: ${legacy.join(', ')}): it no longer limits which steps are reviewed, and no step's review changes without it.` };
  }
  return { questions: [{ ask: `${workflow.label}'s review list (sourceReview.phases) no longer limits which steps are reviewed, but it still gives ${words(own.map((id) => labelOf(ctx, workflow, id)))} ${own.length === 1 ? 'its' : 'their'} own scope or plan review. Remove it?`,
    why: 'Removing it changes how those steps are reviewed; whether the team wants that is its decision.',
    choices: [{ id: 'remove', label: 'Remove the list', effect: `Every authored step keeps a review; ${words(own.map((id) => labelOf(ctx, workflow, id)))} get the document review.`, apply }, keep()] }] };
}

async function reviewerUnavailable([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const missing = /reviewed by '([^']+)'/u.exec(finding.detail ?? '')?.[1];
  const reviewers = ctx.model.agents.filter((agent) => agent.id !== missing && ctx.readOnlyReviewers.has(agent.id));
  const written = ctx.draft.workflowField(workflow.id, 'sourceReview') ?? {};
  const name = (draft, id) => draft.workflow(workflow.id, 'sourceReview', { ...written, reviewerAgent: id });
  if (reviewers.length === 1) {
    name(ctx.draft, reviewers[0].id);
    return { summary: `${reviewers[0].label}, this configuration's read-only reviewer, reviews ${workflow.label}'s steps (sourceReview.reviewerAgent).` };
  }
  return { questions: [{ ask: `No step of ${workflow.label} is reviewed: its reviewer '${missing}' is not in this configuration. Who reviews, or should review be off?`,
    why: 'Whether steps are reviewed, and by which reviewer, is the team\'s decision.',
    choices: [...reviewers.map((agent) => ({ id: `reviewer:${agent.id}`, label: agent.label, effect: `${agent.label} reviews every authored step.`, apply: (draft) => name(draft, agent.id) })),
      { id: 'off', label: 'Review off for this workflow', effect: 'sourceReview.mode: off; no step is reviewed, and the warning goes.', apply: (draft) => draft.workflow(workflow.id, 'sourceReview', { mode: 'off' }) },
      keep(`Keep it; add the ${missing} agent with sflow-mode: read-only-review`)] }] };
}

async function sharedPlan([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const planner = finding.subject.step;
  const resolved = ctx.resolved(workflow.id);
  const claims = resolved?.plannedClaims ?? {};
  const codeSteps = Object.entries(claims.owners ?? {}).filter(([, owner]) => owner === planner).map(([code]) => code);
  const order = workflow.phases;
  const own = Object.fromEntries(codeSteps.map((code) => [code, order[order.indexOf(code) - 1]]));
  const distinct = Object.values(own).every((id) => id && stepIn(workflow, id)?.output !== 'code') && new Set(Object.values(own)).size === codeSteps.length;
  const template = stepIn(workflow, planner)?.template ?? ctx.model.phases.find((phase) => phase.id === planner)?.template;
  const choices = [];
  if (distinct) {
    choices.push({ id: 'own-plans', label: 'Each code step is planned by the step just before it', effect: words(codeSteps.map((code) => `${labelOf(ctx, workflow, own[code])} plans ${labelOf(ctx, workflow, code)}`)) + '.',
      apply: (draft) => draft.workflow(workflow.id, 'plannedClaims', { clausePhases: [...(claims.clausePhases ?? [])], owners: { ...(claims.owners ?? {}), ...own } }) });
  }
  if (template) {
    choices.push({ id: 'steps-column', label: `One plan; each row of ${template}'s table names its code step`, effect: `${template}'s planned-claims table gets a Steps column for the Story's author to fill.`,
      apply: (draft) => draft.edit({ kind: 'template', path: template }, (text) => withStepsColumn(text) ?? text) });
  }
  choices.push(keep());
  return { questions: [{ ask: `${labelOf(ctx, workflow, planner)} plans ${plural(codeSteps.length, 'code step')}. Give each its own plan, or keep one plan whose rows name their code step?`, why: ROUTE_WHY, choices }] };
}

async function guidanceConflict([finding], ctx) {
  const match = /^"(.+)" \((.+) line (\d+)\) and "(.+)" \((.+) line (\d+)\)\.$/u.exec(finding.detail ?? '');
  if (!match) return { questions: [{ ask: finding.title, why: NOTICE_WHY, choices: [keep('Keep both: each applies in its own case')] }] };
  const [, firstText, firstFile, firstLine, secondText, secondFile, secondLine] = match;
  const drop = (file, line, sentence) => async (draft) => {
    const target = guidanceTarget(ctx, file);
    if (!target) return;
    await draft.edit(target, (text) => {
      const lines = text.split('\n');
      // The line that says the sentence, nearest to where the check saw it.
      const found = lines.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(sentence))
        .sort((left, right) => Math.abs(left.index + 1 - Number(line)) - Math.abs(right.index + 1 - Number(line)))[0];
      if (!found) return text;
      const without = found.entry.replace(sentence, '').replace(/\s{2,}/gu, ' ');
      if (/^\s*(?:[-*+]|\d+[.)])?\s*$/u.test(without)) return removeLine(text, found.index + 1) ?? text;
      lines[found.index] = without.trimEnd();
      return lines.join('\n');
    });
  };
  return { questions: [{ ask: `${finding.title}: "${firstText}" (${firstFile} line ${firstLine}) or "${secondText}" (${secondFile} line ${secondLine}). Which rule stands?`,
    why: 'Which rule the team works by is its decision; both are written by people.',
    choices: [
      { id: 'first', label: `"${firstText}"`, effect: `"${secondText}" is taken out of ${secondFile}.`, apply: drop(secondFile, secondLine, secondText) },
      { id: 'second', label: `"${secondText}"`, effect: `"${firstText}" is taken out of ${firstFile}.`, apply: drop(firstFile, firstLine, firstText) },
      keep('Both: each applies in its own case')] }] };
}

async function apiUnprovided([finding], ctx) {
  const workflow = workflowOf(ctx, finding);
  const step = stepIn(workflow, finding.subject.step);
  const host = /^(?:[A-Z]+ )?https?:\/\/([^/\s]+)/u.exec(finding.detail ?? '')?.[1] ?? null;
  const targets = (ctx.model.integrations?.targets ?? []).filter((target) => {
    try { return host && [target.url, target.repository].filter(Boolean).some((url) => new URL(url).host === host); } catch { return false; }
  });
  const file = finding.location?.file; const line = finding.location?.line;
  const target = file ? guidanceTarget(ctx, file) : null;
  const said = target && line ? (await ctx.draft.text(target))?.split('\n')[line - 1] ?? null : null;
  return { questions: [{ ask: `${finding.title}: ${finding.detail} Can the agent reach it on its own?`,
    why: 'Whether the agent has its own access to that service is known only to the team that runs it.',
    choices: [keep('Yes: the agent has its own access'),
      ...targets.map((entry) => ({ id: `action:${entry.id}`, label: `Tell ${entry.id} in an action after ${step?.label}`, effect: `${step?.label} sends an event to ${entry.id} when it is approved.`,
        apply: (draft) => draft.phase(step.id, { afterStep: [...(step.afterStep ?? []), { id: `${entry.id}-after-${step.id}`.slice(0, 64), on: ['approved'], target: entry.id, send: 'event' }] }, { workflow: workflow.id }) })),
      ...(said != null ? [{ id: 'remove-call', label: 'No: take the call out of the guidance', effect: `"${said.trim()}" goes from ${file}.`,
        apply: (draft) => draft.edit(target, (text) => { const at = lineNumberOf(text, said, line); return at ? removeLine(text, at) ?? text : text; }) }] : [])] }] };
}

async function externalLinks([finding], ctx) {
  return { questions: [{ ask: `${finding.title}. Agents see them as text; nothing fetches them. Keep them?`, why: NOTICE_WHY,
    choices: [keep('Keep them as text the agents read')] }] };
}

async function browserTarget([finding]) {
  return { questions: [{ ask: `${finding.title}. Each Story must be started with the target it checks (--target-url). Is that how the team starts these Stories?`,
    why: 'Which live site a Story checks is chosen per Story by the person who starts it; no configuration can know it.',
    choices: [keep('Yes: each Story is started with its target')] }] };
}

async function unreadable([finding]) {
  return { questions: [{ ask: `${finding.title}: ${finding.detail}`, why: 'The engine refused this workflow with the message above; what it should be instead is not written anywhere a fixer can read.',
    answer: { kind: 'text' }, choices: [keep('Fix it by hand in Workflow Studio')] }] };
}

/**
 * A step's questions setting (clarification), from the check's own `fix.data` (src/workflow-check.mjs,
 * above clarificationSetting): `edits` when the fixer decides, `question` when a person does. Each
 * edit's `path` is a key path in workflow.yml under the setting's `path`; the result is written as the
 * step's whole setting, for this workflow alone when other workflows share the step (`sharedWith`;
 * an override replaces the step's whole setting, so it starts from the step's value). Two findings
 * on one step can set one key, so only the first is applied in a round; the next round checks again.
 */
function clarificationValue(ctx, data, workflowScoped) {
  const { setting } = data;
  const drafted = ctx.draft.clarification(data.step, workflowScoped ? data.workflow : null);
  if (drafted !== undefined) return drafted;
  const read = (keys) => keys.reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), ctx.raw);
  const own = read(setting.path);
  return own !== undefined ? own : workflowScoped ? read(['phases', data.step, 'clarification']) : undefined;
}

function clarificationEdits(ctx, data, edits) {
  const { setting } = data;
  const workflowScoped = Boolean(data.workflow) && (setting.scope === 'workflow' || (setting.sharedWith ?? []).length > 0);
  const current = clarificationValue(ctx, data, workflowScoped);
  let value = typeof current === 'string' ? { mode: current } : current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current) : {};
  for (const edit of edits) {
    const key = edit.path.length > setting.path.length ? edit.path[setting.path.length] : null;
    if (!key) value = edit.to && typeof edit.to === 'object' && !Array.isArray(edit.to) ? { ...value, ...structuredClone(edit.to) } : { mode: edit.to };
    else if (edit.remove) delete value[key];
    else value[key] = structuredClone(edit.to);
  }
  ctx.draft.phase(data.step, { clarification: value }, { workflow: workflowScoped ? data.workflow : null });
  return { workflowScoped, value };
}

async function clarificationFix(findings, ctx) {
  const questions = [];
  const done = [];
  for (const finding of findings) {
    const data = finding.fix?.data;
    if (!data?.setting || !data.step) {
      questions.push({ ask: `${finding.title}: ${finding.detail ?? ''} ${finding.fix?.text ?? ''}`.trim(), why: 'workflow check gave no change to apply here, so a person sets it.', choices: [keep()] });
      continue;
    }
    if (data.decidedBy === 'person' || !(data.edits ?? []).length) {
      if (!data.question) continue;
      questions.push({ ask: data.question.text, why: WORKFLOW_FIXERS[finding.code]?.why ?? NOTICE_WHY,
        choices: data.question.choices.map((choice) => ({ id: choice.id, label: choice.label, effect: (choice.edits ?? []).length ? `${choice.edits.map((edit) => `${edit.path.join('.')}${edit.remove ? ' goes' : `: ${JSON.stringify(edit.to)}`}`).join('; ')}.` : 'Nothing changes.',
          apply: (draft) => { if ((choice.edits ?? []).length) clarificationEdits({ ...ctx, draft }, data, choice.edits); } })) });
      continue;
    }
    // One fix per step and workflow in a round: two findings can set one key, so the next round checks again.
    if (ctx.draft.clarification(data.step, data.workflow) !== undefined || ctx.draft.clarification(data.step, null) !== undefined) continue;
    const { workflowScoped, value } = clarificationEdits(ctx, data, data.edits);
    const label = ctx.model.phases.find((phase) => phase.id === data.step)?.label ?? data.step;
    done.push(`the questions setting of ${label} becomes ${JSON.stringify(value)}${workflowScoped ? ` for ${data.workflow} alone` : ''}${(data.alternatives ?? []).length ? ` (also possible: ${data.alternatives.map((entry) => entry.label.toLowerCase()).join('; ')})` : ''}`);
  }
  return { summary: done.length ? `${done.join('; ').replace(/^t/u, 'T')}.` : null, questions };
}

/** A configuration that does not load: its own diagnosis's fix, applied to the exact line, or the person's corrected line. */
async function configurationProblem(findings, ctx) {
  const results = { questions: [] };
  const done = [];
  // Later lines first, so a line taken out does not move the ones still to mend.
  for (const finding of [...findings].sort((left, right) => (right.location?.line ?? 0) - (left.location?.line ?? 0))) {
    const problem = ctx.configurationProblems.find((entry) => entry.line === finding.location?.line && entry.code === finding.code
      && (finding.detail ?? '').startsWith(String(entry.message ?? '').slice(0, 40))) ?? ctx.configurationProblems.find((entry) => entry.line === finding.location?.line && entry.code === finding.code) ?? null;
    const file = problem?.file ?? finding.subject?.file;
    // The key the message names ("Work type 'x' intelligence.worldModel must be ..."), found by its keys
    // when the diagnosis located only the work type, or nothing.
    const named = /^(?:Work type '([^']+)' )?([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*) must be/u.exec(problem?.message ?? finding.detail ?? '');
    const keys = named ? [...(named[1] ? ['workTypes', named[1]] : []), ...named[2].split('.')] : null;
    const keyed = keys && file ? ctx.locate(file, keys) : null;
    let keyLine = keyed && (await ctx.draft.lineOf(file, keyed))?.trim().startsWith(`${keys.at(-1)}:`) ? keyed : null;
    if (!keyLine && keys && file) {
      // Nested where the message does not say: the one line that sets that key, when only one does.
      const lines = (await ctx.draft.fileText(file))?.split('\n') ?? [];
      const setting = lines.map((text, index) => ({ text, index })).filter(({ text }) => new RegExp(`^\\s*${keys.at(-1)}:\\s*\\S`, 'u').test(text));
      if (setting.length === 1) keyLine = setting[0].index + 1;
    }
    const line = keyLine ?? problem?.line ?? finding.location?.line ?? null;
    // The values the validator accepts: its own list, else the ones its message names ("must be off or commit").
    const choices = problem?.choices ?? /must be (?:one of )?([a-z0-9-]+(?:, [a-z0-9-]+)*,? or [a-z0-9-]+|[a-z0-9-]+(?:, [a-z0-9-]+)+)\./u.exec(problem?.message ?? finding.detail ?? '')?.[1]
      .split(/,? or |, /u).filter(Boolean) ?? [];
    // A field the configuration does not have, written on one line: it goes.
    const unknownField = /contains unknown field '([^']+)'/u.exec(problem?.message ?? finding.detail ?? '')?.[1];
    const fieldLine = unknownField && line ? await ctx.draft.lineOf(file, line) : null;
    const nextLine = fieldLine != null ? await ctx.draft.lineOf(file, line + 1) : null;
    if (fieldLine != null && new RegExp(`^(\\s*)(?:- )?${unknownField}:\\s*[^\\s#|>]`, 'u').test(fieldLine)
        && !(nextLine && /^\s*/u.exec(nextLine)[0].length > /^\s*/u.exec(fieldLine)[0].length)) {
      await ctx.draft.editLine(file, line, () => null, { remove: true });
      done.push(`${file} line ${line}: '${unknownField}', a field the configuration does not have, goes`);
      continue;
    }
    const unknownGroup = /Phase '([^']+)' approval references unknown authority '([^']+)'/u.exec(problem?.message ?? finding.detail ?? '');
    if (unknownGroup) {
      // Workflow Studio reads the configuration as written, so the step's sign-off is changed there.
      const [, stepId, missing] = unknownGroup;
      const approval = ctx.raw.phases?.[stepId]?.approval ?? {};
      const groups = (approval.authorities ?? []).filter((id) => id !== missing);
      const groupsHere = Object.entries(ctx.raw.approvalAuthorities ?? {}).map(([id, group]) => ({ id, label: group?.label ?? id, members: group?.members ?? [], githubTeams: group?.githubTeams ?? [], status: 'people' }));
      results.questions.push({ ask: `${ctx.raw.phases?.[stepId]?.label ?? stepId} is signed off by '${missing}', a group that does not exist. Which group signs it off?`, why: PEOPLE_WHY,
        choices: groupChoices({ ...ctx, model: { ...ctx.model, groups: groupsHere } }, { exclude: groups,
          apply: (draft, group) => draft.phase(stepId, { approval: { groups: [...new Set([...groups, group])], minimum: approval.minimum ?? 1, ...(approval.rejectTo ? { rejectTo: approval.rejectTo } : {}) } }),
          create: { id: missing, label: missing.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') } }) });
      continue;
    }
    if (problem?.code === 'WORKFLOW_TEMPLATE_MISSING' && problem.path) {
      const [scope, , , step] = problem.path;
      const stepId = scope === 'phases' ? problem.path[1] : step;
      const workflowId = scope === 'workTypes' ? problem.path[1] : null;
      if (problem.suggestion) ctx.draft.phase(stepId, { template: problem.suggestion }, { workflow: workflowId });
      else ctx.draft.create({ kind: 'template', path: /uses template '([^']+)'/u.exec(problem.message)?.[1] }, newStepTemplate(stepId, stepId));
      done.push(problem.suggestion ? `${stepId} uses template ${problem.suggestion}` : `the missing template of ${stepId} is created from the starter`);
      continue;
    }
    // A YAML 1.1 writer turns off and on into false and true; where off (on) is the one the validator wants, it is meant.
    // Every line that sets that key to the flag under that parent is refused alike, so each is mended.
    const flagged = [];
    if (file && keys && !keyLine && choices.length) {
      const lines = (await ctx.draft.fileText(file))?.split('\n') ?? [];
      lines.forEach((text, index) => {
        const match = new RegExp(`^(\\s*)${keys.at(-1)}:\\s*(false|true)\\s*(?:#.*)?$`, 'u').exec(text);
        if (!match) return;
        const parent = lines.slice(0, index).reverse().find((above) => /\S/u.test(above) && /^\s*/u.exec(above)[0].length < match[1].length);
        if (keys.length < 2 || new RegExp(`^\\s*${keys.at(-2)}:`, 'u').test(parent ?? '')) flagged.push({ line: index + 1, flag: match[2] });
      });
    } else if (line) {
      const flag = /:\s*(false|true)\s*(?:#.*)?$/u.exec((await ctx.draft.lineOf(file, line)) ?? problem?.source ?? '')?.[1];
      if (flag) flagged.push({ line, flag });
    }
    const mended = flagged.filter((entry) => choices.includes(entry.flag === 'false' ? 'off' : 'on'));
    if (file && mended.length) {
      for (const entry of mended) {
        const meant = entry.flag === 'false' ? 'off' : 'on';
        await ctx.draft.editLine(file, entry.line, (text) => text.replace(/:(\s*)(false|true)(\s*(?:#.*)?)$/u, `:$1${meant}$3`));
      }
      done.push(`${file} line${mended.length === 1 ? '' : 's'} ${words(mended.map((entry) => String(entry.line)))}: ${mended[0].flag} becomes ${mended[0].flag === 'false' ? 'off' : 'on'}, the value a YAML writer turned into ${mended[0].flag}`);
      continue;
    }
    const swap = /^Change '(.+)' to '(.+)'\.$/u.exec(problem?.fix ?? finding.fix?.text ?? '');
    const indent = /Indent it by (\d+) spaces\.$/u.exec(problem?.fix ?? finding.fix?.text ?? '');
    const tab = /tab/iu.test(problem?.message ?? '') && /YAML_TAB/u.test(problem?.code ?? '');
    const edit = swap ? (text) => text.replace(swap[1], swap[2]) : indent ? (text) => `${' '.repeat(Number(indent[1]))}${text.trimStart()}`
      : tab ? (text) => text.replace(/^[\t ]+/u, (lead) => lead.replace(/\t/gu, '  ')) : null;
    if (edit && file && line) {
      await ctx.draft.editLine(file, line, edit);
      done.push(`${file} line ${line}: ${swap ? `'${swap[1]}' becomes '${swap[2]}'` : indent ? `indented ${indent[1]} spaces` : 'tabs become spaces'}`);
      continue;
    }
    results.questions.push({ ask: `${file ?? 'singularity/workflow.yml'}${line ? ` line ${line}` : ''}: ${finding.detail ?? finding.title}${problem?.fix || finding.fix?.text ? ` ${problem?.fix ?? finding.fix.text}` : ''} What should the line say?`,
      why: 'The configuration does not load, and its own diagnosis names no single correct value; the right one is the author\'s.',
      answer: { kind: 'text' },
      choices: [...choices.slice(0, 8).map((choice) => ({ id: `value:${choice}`, label: choice, effect: `Line ${line} uses '${choice}'.`,
        apply: (draft) => draft.editLine(file, line, (text) => text.replace(/:\s*.*$/u, `: ${choice}`)) })),
      ...(file && line ? [{ id: 'line', label: 'This text for the line', needs: 'text', effect: `Line ${line} becomes the text you give.`, apply: (draft, answer) => draft.editLine(file, line, () => String(answer?.text ?? '')) }] : [])] });
  }
  return { summary: done.length ? `Repair ${words(done)}.` : null, ...results };
}

// -------------------------------------------------------------------------------------------------
// The registry

const change = (order, fix, extra = {}) => Object.freeze({ resolves: 'change', order, fix, ...extra });
const question = (order, why, fix, extra = {}) => Object.freeze({ resolves: 'question', order, why, fix, ...extra });
const either = (order, why, fix, extra = {}) => Object.freeze({ resolves: 'change-or-question', order, why, fix, ...extra });
const byTemplate = (finding) => finding.subject?.template ?? finding.location?.file ?? finding.id;
const byFile = (finding) => finding.subject?.file ?? finding.location?.file ?? finding.id;
const byWorkflow = (finding) => finding.subject?.workflow ?? finding.id;

export const WORKFLOW_FIXERS = Object.freeze({
  // Assets: removals first, so no later fix edits a file that goes.
  CHECK_SKILL_UNUSED: change(10, unusedSkill),
  CHECK_INSTRUCTION_UNUSED: change(10, unusedInstruction),
  CHECK_AGENT_UNUSED: change(10, unusedAgent),
  AGENT_PHASE_UNKNOWN: change(8, agentUnknownStep, { group: () => 'agents' }),
  CHECK_INSTRUCTION_DUPLICATE: change(9, duplicateInstruction),
  CHECK_SKILL_STEP_UNUSED: either(14, 'Whether a skill belongs in other teams\' workflows is a decision for the people who own them.', skillStepUnused),
  // Templates: a missing one is made first, its tokens fixed, then anchors before the table that cites them.
  CHECK_TEMPLATE_MISSING: change(20, templateMissing),
  CHECK_TEMPLATE_TOKEN_UNSUPPORTED: change(22, templateTokens, { group: byTemplate }),
  CHECK_TEMPLATE_CLAUSE_NAMESPACE: change(23, templateNamespaceFix, { group: byTemplate }),
  CHECK_TEMPLATE_CLAUSE_ANCHORS: change(24, templateAnchorsFix, { group: byTemplate }),
  CHECK_TEMPLATE_PLANNED_TABLE: change(26, templatePlannedTable, { group: byTemplate }),
  CHECK_TEMPLATE_HEADING_MISSING: change(28, templateSections, { group: byTemplate }),
  CHECK_TEMPLATE_GUIDANCE: change(29, templateGuidance, { group: byTemplate }),
  // Guidance.
  CHECK_LINK_BROKEN: either(30, 'Several files have the linked name; which one the author meant is not written anywhere.', brokenLinks, { group: byFile }),
  CHECK_GUIDANCE_CONFLICT: question(32, 'Which rule the team works by is its decision; both are written by people.', guidanceConflict),
  CHECK_API_UNPROVIDED: question(34, 'Whether the agent has its own access to that service is known only to the team that runs it.', apiUnprovided),
  CHECK_LINKS_EXTERNAL: question(36, NOTICE_WHY, externalLinks),
  // Ownership.
  AGENT_PHASE_UNMAPPED: either(40, 'Several agents can draft the step; which one the team wants is its decision.', stepAgent),
  AGENT_PHASE_DEFAULT_MISSING: either(40, 'Several agents can draft the step; which one the team wants is its decision.', stepAgent),
  AGENT_PHASE_DEFAULT_AMBIGUOUS: question(40, 'Several agents each say they draft the step; which one the team meant is its decision.', stepAgent),
  CHECK_STEP_NO_AGENT: either(40, 'Several agents can draft the step; which one the team wants is its decision.', stepAgent),
  CHECK_GROUP_BLOCKED: question(42, PEOPLE_WHY, blockedGroup, { group: (finding) => finding.subject?.group ?? finding.id }),
  CHECK_CODE_WITHOUT_SIGNOFF: either(44, 'No step of the workflow has a sign-off to follow; who reviews the work is the team\'s decision.', codeWithoutSignOff),
  CHECK_LAST_STEP_NO_SIGNOFF: question(46, 'A workflow may end when its last step is submitted; whether the team wants a sign-off there is its decision.', lastStepNoSignOff),
  // Flow: the engine's own rules.
  WORKFLOW_REJECTION_TARGET: either(50, 'A step nobody signs off has no send-back target to repoint; where rejected work goes is the team\'s decision.', rejectionTarget),
  WORKFLOW_AUTHORITY_UNKNOWN: question(50, PEOPLE_WHY, unknownAuthority),
  WORKFLOW_ROUTE_PAUSE_UNOWNED: either(52, 'The step the decision follows has no sign-off to follow; who decides is the team\'s decision.', decisionOwner),
  WORKFLOW_ROUTE_EXHAUSTION: either(52, 'The step the decision follows has no sign-off to follow; who decides is the team\'s decision.', decisionOwner),
  WORKFLOW_ROUTE_UNBOUNDED: either(52, ROUTE_WHY, unboundedRoutes, { group: byWorkflow }),
  WORKFLOW_ROUTE_UNREACHABLE: question(54, ROUTE_WHY, unreachableRoute),
  WORKFLOW_PHASE_UNREACHABLE: question(54, ROUTE_WHY, unreachableStep),
  WORKFLOW_ROUTE_NO_END: question(54, ROUTE_WHY, routeNoEnd),
  WORKFLOW_CONVERGENCE_MULTIPLE_UNSUPPORTED: question(56, ROUTE_WHY, keepOneStep, { group: byWorkflow }),
  WORKFLOW_VISUAL_MULTIPLE_UNSUPPORTED: question(56, ROUTE_WHY, keepOneStep, { group: byWorkflow }),
  WORKFLOW_CONVERGENCE_CODE_SOURCE_MISSING: question(56, ROUTE_WHY, convergenceSource),
  WORKFLOW_PROOF_OUTPUT_REQUIRED: change(56, proofOutput),
  WORKFLOW_REVIEW_RECEIPT_UNSUPPORTED: change(56, proofOutput),
  OBLIGATION_OPT_OUT_RETIRED: change(58, plannedClaims),
  CHECK_PLANNED_CLAIMS: either(58, ROUTE_WHY, plannedClaims),
  OBLIGATION_IMPLEMENT_WITHOUT_PLAN: either(60, ROUTE_WHY, implementWithoutPlan),
  OBLIGATION_ROUTE_DROPS_RESPONSIBILITY: either(60, ROUTE_WHY, routeDropsResponsibility),
  OBLIGATION_VERIFY_WITHOUT_REVIEW: either(62, 'No step of the workflow has a sign-off to follow; who reviews the work is the team\'s decision.', reviewGap),
  OBLIGATION_REVIEW_POLICY_ONLY: either(62, 'No step of the workflow has a sign-off to follow; who reviews the work is the team\'s decision.', reviewGap),
  OBLIGATION_OMIT_UNNECESSARY: change(64, omitUnnecessary),
  OBLIGATION_OMIT_INVALID: question(64, 'Why a responsibility does not apply is the team\'s own reasoning; nothing in the repository says it.', omitInvalid, { group: byWorkflow }),
  OBLIGATION_GRAPH_EMPTY: question(64, 'What a workflow is for is the team\'s decision.', emptyWorkflow),
  CHECK_PLAN_SHARED_BY_CODE_STEPS: question(66, ROUTE_WHY, sharedPlan),
  CHECK_REVIEW_PHASES_SUPERSEDED: either(68, 'Removing the list changes how some steps are reviewed; whether the team wants that is its decision.', reviewPhasesSuperseded),
  CHECK_REVIEWER_UNAVAILABLE: either(68, 'Whether steps are reviewed, and by which reviewer, is the team\'s decision.', reviewerUnavailable),
  CHECK_BROWSER_TARGET_REQUIRED: question(70, 'Which live site a Story checks is chosen per Story by the person who starts it; no configuration can know it.', browserTarget),
  CHECK_WORKFLOW_UNREADABLE: question(72, 'The engine refused the workflow; what it should be instead is not written anywhere a fixer can read.', unreadable),
  CHECK_ROUTES_UNREADABLE: question(72, 'The engine refused the workflow\'s routes; what they should be instead is not written anywhere a fixer can read.', unreadable),
  // Questions: where each step asks, from the check's own fix data (fix.data, see clarificationFix).
  CHECK_CLARIFICATION_INVALID: either(6, 'The setting cannot be read and could mean several things; which one the team meant is its decision.', clarificationFix),
  CHECK_MARKERS_UNANSWERABLE: change(74, clarificationFix),
  CHECK_SCOPE_NOT_CLARIFIED: change(75, clarificationFix),
  CHECK_CODE_STEP_ALWAYS_ASKS: change(76, clarificationFix),
  CHECK_QUESTIONS_SETTLED_BY_SCOPE: change(77, clarificationFix),
  CHECK_SOURCE_STEP_ASKS_ONLY_WHEN_NEEDED: question(78, 'Whether a step always confirms its reading of the sources with a person is the team\'s choice, not a defect.', clarificationFix),
  // Clarity last: descriptions read the explanation, labels the steps.
  CHECK_STEP_LABEL_DUPLICATE: change(80, duplicateLabel),
  CHECK_STEPS_UNDESCRIBED: change(90, undescribedSteps)
});

/**
 * A configuration that does not load reports its validator's own codes (YAML_*, WORKFLOW_* and the
 * rest of src/config.mjs); there are too many to list, so one fixer takes them all: the diagnosis's
 * own repair when it names one, else the person's corrected line.
 */
export const CONFIGURATION_FIXER = either(5, 'The configuration does not load, and its own diagnosis names no single correct value; the right one is the author\'s.', configurationProblem,
  { group: (finding) => finding.subject?.file ?? 'configuration' });

/** The fixer for a finding: its code's entry, or the configuration fixer for a configuration that does not load. */
export function fixerFor(finding, { configurationLoads = true } = {}) {
  return WORKFLOW_FIXERS[finding.code] ?? (!configurationLoads ? CONFIGURATION_FIXER : null);
}

export { members as answerMembers };
