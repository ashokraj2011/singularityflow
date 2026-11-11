/**
 * A simpler workflow from one a team has: `workflow build start --simplify ID`.
 *
 * The build copies the workflow under a new ID: the original is never changed, and Stories already
 * running keep the workflow they started with. It lists what the platform can see a simpler copy
 * could leave out or merge, each candidate located (file and line), with why, and with the build
 * moves that make it. Deterministic: no model decides a candidate.
 *
 * - unneeded-step: a step no later step reads and nobody signs off, with no check, action, decision
 *   or planned-claims role;
 * - duplicate-step: a later step with the same agent, output and template as an earlier one, or the
 *   same name and output;
 * - unused-asset: an agent, skill or instruction nothing uses (`workflow check`'s CHECK_*_UNUSED);
 * - mergeable-groups: approval groups of this workflow with exactly the same people in them;
 * - contradicting-settings: review, clarification and question-placement findings of `workflow check`
 *   (offered with the builder's move a finding carries, or the step.clarify its fix's edits make);
 * - shipped-template: a team step whose template the kernel cannot read, where a shipped step writes
 *   the same kind of document;
 * - loop-only-route: a decision whose routes only send work back.
 *
 * A candidate is offered (as a proposal by SFlow that a person accepts or declines) only after its
 * moves are checked like any proposal and the workflow they leave is checked again: one that would
 * add a problem, or change the original, is listed with the reason and not offered. Before the build
 * finishes it is verified (`verifyBuild`): `workflow validate`, and `workflow walk` where this SFlow
 * has it, on the configuration exactly as the build leaves it. A simplify build finishes only when
 * no problem or stop remains, or the person accepts each one that does by its ID.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeClarificationPolicy } from '../clarifications.mjs';
import { resolveWorkType } from '../config.mjs';
import { SingularityFlowError } from '../util.mjs';
import { applyMoves, lowerDraft, validateMoves } from './moves.mjs';
import { draftOf, planFor, repositoryOf, targetWorkflow, withRepository, workflowFingerprint } from './engine.mjs';
import { readWorkflowBuild, saveWorkflowBuild } from './store.mjs';

export const SIMPLIFY_KINDS = Object.freeze(['loop-only-route', 'duplicate-step', 'unneeded-step', 'mergeable-groups', 'contradicting-settings', 'shipped-template', 'unused-asset']);
const SETTINGS_CODE = /^CHECK_(?:REVIEW|REVIEWER|CLARIFICATION|QUESTION|PLACEMENT)/u;
// `workflow check`'s clarity findings say where questions are asked (CHECK_SCOPE_NOT_CLARIFIED,
// CHECK_MARKERS_UNANSWERABLE, CHECK_QUESTIONS_SETTLED_BY_SCOPE, CHECK_CODE_STEP_ALWAYS_ASKS, ...).
const SETTINGS_AREAS = new Set(['review', 'questions', 'clarification', 'placement', 'clarity']);
const UNUSED = Object.freeze({ CHECK_AGENT_UNUSED: 'agent', CHECK_SKILL_UNUSED: 'skill', CHECK_INSTRUCTION_UNUSED: 'instruction' });
// Moves a simplify candidate may carry: each changes only the copy (a step the copy leaves out or
// adds as it is, what a step reads and who signs it off in this workflow, a decision), never a step
// other workflows share.
const COPY_ONLY_MOVES = new Set(['step.remove', 'step.move', 'step.clarify', 'decision.remove', 'decision.add', 'branch.add', 'item.leaveOut', 'item.keepAsLink', 'item.prerequisite', 'item.classify']);

function fail(code, message, details = undefined) {
  throw new SingularityFlowError(message, { code, details });
}

const unique = (values) => [...new Set(values)];
const words = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list.at(-1)}`);
const candidateId = (kind, subject) => `sc-${createHash('sha256').update(JSON.stringify([kind, subject])).digest('hex').slice(0, 10)}`;

/** Whether a move changes only the copy: see COPY_ONLY_MOVES; a step.add reuses a step or copies one under a new ID. */
export function copyOnlyMove(move, model) {
  if (COPY_ONLY_MOVES.has(move?.move)) return true;
  if (move?.move === 'step.change') return ['label', 'purpose', 'agent', 'output'].every((field) => move[field] == null);
  if (move?.move === 'step.add') return move.from != null || model.phases.some((phase) => phase.id === move.id);
  return false;
}

/**
 * Findings for moves (anyone's) that would change the workflow a simplify build copies: a shared
 * field of one of its steps, or a skill attached to an agent that drafts one. Each located at
 * `moves[i]`, like every other move finding.
 */
export function originalMoveFindings(moves, { model, record }) {
  const original = model.workflows.find((workflow) => workflow.id === record.goal.simplify?.from);
  if (!original || !Array.isArray(moves)) return [];
  const steps = new Set(original.phases);
  const agents = new Set(original.steps.map((step) => step.agent).filter(Boolean));
  const findings = [];
  moves.forEach((move, index) => {
    if (move?.move === 'step.change' && steps.has(move.id) && ['label', 'purpose', 'agent', 'output'].some((field) => move[field] != null)) {
      findings.push({ at: `moves[${index}].id`, code: 'BUILD_SIMPLIFY_ORIGINAL', message: `Step '${move.id}' is in ${original.label}, which a simpler copy never changes: its name, purpose, agent and output stay. Add a copy with step.add and from: '${move.id}' and a new ID instead.` });
    }
    if (move?.move === 'skill.attach' && move.agent && agents.has(move.agent)) {
      findings.push({ at: `moves[${index}].agent`, code: 'BUILD_SIMPLIFY_ORIGINAL', message: `Agent '${move.agent}' drafts steps of ${original.label}, so attaching a skill to it changes that workflow too. Attach the skill to this workflow instead (leave out agent).` });
    }
  });
  return findings;
}

/** The step IDs a workflow's planned claims name: they stay, since no build move changes planned claims. */
function plannedSteps(workflow) {
  const claims = workflow.plannedClaims ?? {};
  return new Set([...(claims.clausePhases ?? []), ...Object.keys(claims.owners ?? {}), ...Object.values(claims.owners ?? {})].filter(Boolean));
}

/** Where each step is read, sent back to and routed to, for one workflow. */
function references(workflow) {
  const steps = workflow.steps ?? [];
  const decisions = workflow.decisions ?? [];
  return {
    readers: (id) => steps.filter((step) => step.id !== id && [...(step.inputs ?? []), ...(step.optionalInputs ?? [])].includes(id)),
    sendersBack: (id) => steps.filter((step) => step.id !== id && step.approval?.mode !== 'none' && (step.sendBackTo ?? []).includes(id)),
    routedTo: (id) => decisions.filter((decision) => decision.back === id || (decision.routes ?? []).some((route) => route.to === id)),
    decisionAfter: (id) => decisions.find((decision) => decision.after === id) ?? null
  };
}

/**
 * The moves that let `to` take `from`'s place for the steps that read it or send rejected work back
 * to it, one step.change per step. A sign-off keeps its groups and minimum; the step keeps the rest.
 */
function repointMoves(workflow, from, to) {
  const refs = references(workflow);
  const changes = new Map();
  const change = (step) => {
    if (!changes.has(step.id)) changes.set(step.id, { move: 'step.change', id: step.id });
    return changes.get(step.id);
  };
  for (const step of refs.readers(from)) change(step).reads = unique((step.inputs ?? []).map((id) => (id === from ? to : id)));
  for (const step of refs.sendersBack(from)) {
    change(step).signOff = { groups: [...(step.approval.authorities ?? [])], minimum: step.approval.minimum || 1,
      sendBackTo: unique((step.sendBackTo ?? []).map((id) => (id === from ? to : id))) };
  }
  return [...changes.values()];
}

/**
 * Where a decision sends work when its routes only loop: every route goes back (to its own step or
 * an earlier one) and no decision on the way back leads past it, so a run never gets beyond it until
 * its rounds run out. Null otherwise: a repair loop with a way on (pass goes on, fail goes back, or a
 * repair that returns to a check which passes on) is how a workflow means to work, and stays.
 */
function loopTargets(workflow, decision) {
  const order = workflow.phases;
  const at = order.indexOf(decision.after);
  if (at < 0 || decision.kind === 'loop') return null;
  const routes = decision.routes ?? [];
  if (!routes.length || routes.some((route) => (route.omits ?? []).length)) return null;
  const back = [];
  for (const route of routes) {
    const index = order.indexOf(route.to);
    if (index < 0 || index > at) return null;
    back.push(route.to);
  }
  const from = Math.min(...back.map((id) => order.indexOf(id)));
  const leadsOn = (other) => {
    const index = order.indexOf(other.after);
    return other !== decision && index >= from && index < at
      && (other.routes ?? []).some((route) => route.to === 'end' || order.indexOf(route.to) > at);
  };
  return (workflow.decisions ?? []).some(leadsOn) ? null : unique(back);
}

function loopCandidates({ workflow, labelOf, groupLabel, locate, findings }) {
  const candidates = [];
  (workflow.decisions ?? []).forEach((decision, index) => {
    const back = loopTargets(workflow, decision);
    if (!back) return;
    const step = workflow.steps.find((entry) => entry.id === decision.after);
    const targets = back.map((id) => (id === decision.after ? `${labelOf(id)} itself` : labelOf(id)));
    const signed = step?.approval?.mode !== 'none' && (step?.approval?.authorities ?? []).length > 0;
    const missing = signed ? back.filter((id) => !(step.sendBackTo ?? []).includes(id)) : back;
    const name = decision.label ?? decision.id;
    const stops = decision.kind === 'ask' ? 'a person is asked every round'
      : `every round waits for its inputs to be recorded${decision.maxRounds ? `, and when its ${decision.maxRounds} rounds run out the Story pauses${(decision.by ?? []).length ? ` for ${decision.by.map(groupLabel).join(' or ')}` : ''}` : ''}`;
    const after = !signed ? `Without it, ${labelOf(decision.after)} moves on; work goes back only when a later sign-off rejects it.`
      : missing.length ? `Without it, a person who rejects ${labelOf(decision.after)} sends the work back; this also lets them send it to ${words(missing.map(labelOf))}.`
        : `Rejecting ${labelOf(decision.after)} already sends work back to ${words(back.map(labelOf))}, so a person still can.`;
    const moves = [{ move: 'decision.remove', after: decision.after }];
    if (signed && missing.length) {
      moves.push({ move: 'step.change', id: step.id, signOff: { groups: [...step.approval.authorities], minimum: step.approval.minimum || 1,
        sendBackTo: unique([...(step.sendBackTo ?? []), ...missing]) } });
    }
    const located = findings.find((finding) => finding.subject?.decision === decision.id && finding.location)?.location;
    candidates.push({
      kind: 'loop-only-route', subject: { decision: decision.id, step: decision.after },
      title: `"${name}" only sends work back`,
      why: `"${name}" after ${labelOf(decision.after)} only sends work back, to ${words(targets)}, so a run that passes never moves on: ${stops}. ${after}`,
      location: located ?? locate(['workTypes', workflow.id, 'decisions', index]), moves
    });
  });
  return candidates;
}

function duplicateCandidates({ workflow, model, labelOf, locate, findings, templateOf }) {
  const candidates = [];
  const steps = workflow.steps ?? [];
  const planned = plannedSteps(workflow);
  const refs = references(workflow);
  const taken = new Set();
  const norm = (text) => String(text ?? '').trim().toLowerCase();
  const reads = (step) => JSON.stringify([...(step.inputs ?? [])].sort());
  // The same work on the same inputs: same output and reads, and the same agent and template (or name).
  // A retest after a repair reads the repair, so it is not the check before it again.
  steps.forEach((later, laterIndex) => {
    const earlier = steps.slice(0, laterIndex).find((step) => !taken.has(step.id) && step.output === later.output && reads(step) === reads(later) && (
      (step.agent && step.agent === later.agent && templateOf(step) && templateOf(step) === templateOf(later) && (step.approval?.mode === 'none') === (later.approval?.mode === 'none'))
      || norm(step.label) === norm(later.label)));
    if (!earlier) return;
    taken.add(later.id);
    const same = earlier.agent === later.agent && templateOf(earlier) === templateOf(later)
      ? `the same agent (${model.agents.find((agent) => agent.id === later.agent)?.label ?? later.agent}), output (${later.output}) and template (${templateOf(later)})`
      : `the same name (${later.label}) and output (${later.output})`;
    const signed = later.approval?.mode !== 'none';
    const readers = refs.readers(later.id);
    const routed = refs.routedTo(later.id);
    const decision = refs.decisionAfter(later.id);
    const notOffered = planned.has(later.id) ? `The workflow's planned claims name ${labelOf(later.id)}, and no build move changes planned claims; change them in Workflow Studio first.`
      : routed.length ? `${routed.map((entry) => `"${entry.label ?? entry.id}"`).join(', ')} routes work to ${labelOf(later.id)}; repoint ${routed.length === 1 ? 'that decision' : 'those decisions'} first.` : null;
    const located = findings.find((finding) => finding.code === 'CHECK_STEP_LABEL_DUPLICATE' && finding.subject?.step === later.id && finding.location)?.location;
    candidates.push({
      kind: 'duplicate-step', subject: { step: later.id, keeps: earlier.id },
      title: `${labelOf(later.id)} (${later.id}) does what ${labelOf(earlier.id)} (${earlier.id}) does`,
      why: `${labelOf(later.id)} (${later.id}) has ${same} as ${labelOf(earlier.id)} (${earlier.id}), so a Story writes the same document twice. Leaving it out removes one step${signed ? ' and one sign-off' : ''}`
        + `${readers.length ? `; ${words(readers.map((step) => labelOf(step.id)))} read${readers.length === 1 ? 's' : ''} ${labelOf(earlier.id)} instead` : ''}`
        + `${decision ? `; the decision after it ("${decision.label ?? decision.id}") goes with it` : ''}.`,
      location: located ?? locate(['workTypes', workflow.id, 'phases', workflow.phases.indexOf(later.id)]),
      moves: notOffered ? [] : [{ move: 'step.remove', id: later.id }, ...repointMoves(workflow, later.id, earlier.id)],
      ...(notOffered ? { notOffered } : {})
    });
  });
  return candidates;
}

function unneededCandidates({ workflow, labelOf, locate, skip }) {
  const planned = plannedSteps(workflow);
  const refs = references(workflow);
  return (workflow.steps ?? []).filter((step) => !skip.has(step.id) && step.approval?.mode === 'none' && step.output !== 'code' && !step.definesClauses
    && !planned.has(step.id) && !(step.qualityCommands ?? []).length && !(step.afterStep ?? []).length && !refs.readers(step.id).length
    && !refs.sendersBack(step.id).length && !refs.routedTo(step.id).length && !refs.decisionAfter(step.id))
    .map((step) => ({
      kind: 'unneeded-step', subject: { step: step.id },
      title: `No Story needs ${labelOf(step.id)}`,
      why: `Nothing later reads ${labelOf(step.id)} (${step.id}), nobody signs it off, and it runs no check or action, so no Story needs it: it is one more document for the agent to write and nobody acts on it.`,
      location: locate(['workTypes', workflow.id, 'phases', workflow.phases.indexOf(step.id)]),
      moves: [{ move: 'step.remove', id: step.id }]
    }));
}

/** Approval groups of this workflow with exactly the same people (and teams) in them. */
function groupCandidates({ workflow, model, labelOf, groupLabel, locate }) {
  const membership = (id) => {
    const group = model.groups.find((entry) => entry.id === id);
    const people = (group?.members ?? []).map((member) => (typeof member === 'string' ? member.toLowerCase() : JSON.stringify(member))).sort();
    const teams = [...(group?.githubTeams ?? [])].map(String).sort();
    return people.length || teams.length ? JSON.stringify([people, teams]) : null;
  };
  const used = unique((workflow.steps ?? []).filter((step) => step.approval?.mode !== 'none').flatMap((step) => step.approval?.authorities ?? []));
  const candidates = [];
  const merged = new Set();
  for (const [index, keep] of used.entries()) {
    if (merged.has(keep) || !membership(keep)) continue;
    for (const other of used.slice(index + 1).filter((id) => !merged.has(id) && membership(id) === membership(keep))) {
      merged.add(other);
      const steps = workflow.steps.filter((step) => step.approval?.mode !== 'none' && (step.approval?.authorities ?? []).includes(other));
      const deciding = (workflow.decisions ?? []).filter((decision) => (decision.by ?? []).includes(other)
        || (decision.routes ?? []).some((route) => (route.omits ?? []).some((omit) => omit.authority === other)));
      const count = JSON.parse(membership(keep));
      candidates.push({
        kind: 'mergeable-groups', subject: { group: other, keeps: keep },
        title: `${groupLabel(keep)} and ${groupLabel(other)} are the same people`,
        why: `${groupLabel(keep)} and ${groupLabel(other)} have exactly the same ${count[0].length} ${count[0].length === 1 ? 'person' : 'people'}${count[1].length ? ` and ${count[1].length} team${count[1].length === 1 ? '' : 's'}` : ''}, so ${words(steps.map((step) => labelOf(step.id)))} can be signed off by ${groupLabel(keep)} alone in this workflow: one group to keep up to date instead of two. Both groups stay as they are for other workflows.`,
        location: locate(['approvalAuthorities', other]),
        moves: deciding.length ? [] : steps.map((step) => ({ move: 'step.change', id: step.id,
          signOff: { groups: unique(step.approval.authorities.map((id) => (id === other ? keep : id))), minimum: step.approval.minimum || 1 } })),
        ...(deciding.length ? { notOffered: `${deciding.map((decision) => `"${decision.label ?? decision.id}"`).join(', ')} names ${groupLabel(other)}; no build move changes who decides it, so change it in Workflow Studio.` } : {})
      });
    }
  }
  return candidates;
}

/**
 * The builder move a clarity finding's fix makes: `fix.data` names the step and the edits to its
 * clarification setting (`setting.path`, then each edit's `path` and `to`, or `remove`), and the move
 * is the whole policy the step then has in this workflow, so nothing the edits leave alone is lost (a
 * workflow's override replaces the step's own policy). Null when a person decides (`decidedBy:
 * person`, with its `question`) or an edit is not to that setting. `policyOf(step)` is the step's
 * policy now, as the loader normalized it.
 */
export function clarifyMoveOf(finding, policyOf) {
  const data = finding?.fix?.data;
  if (!data || data.decidedBy === 'person' || !data.step || !Array.isArray(data.edits) || !data.edits.length) return null;
  const base = Array.isArray(data.setting?.path) ? data.setting.path : null;
  const current = policyOf(data.step);
  if (!base || !current) return null;
  const policy = { mode: current.mode, maxQuestions: current.maxQuestions, ...(current.topics?.length ? { topics: [...current.topics] } : {}),
    ...(current.markers?.mode && current.markers.mode !== 'off' ? { markers: { mode: current.markers.mode } } : {}) };
  for (const edit of data.edits) {
    if (!Array.isArray(edit?.path) || base.some((key, index) => edit.path[index] !== key)) return null;
    const rest = edit.path.slice(base.length);
    if (!rest.length && plainObject(edit.to)) Object.assign(policy, structuredClone(edit.to));
    else if (rest.length === 1 && ['mode', 'maxQuestions', 'topics', 'markers'].includes(rest[0])) {
      if (edit.remove) delete policy[rest[0]];
      else policy[rest[0]] = structuredClone(edit.to);
    } else return null;
  }
  try { normalizeClarificationPolicy(policy); } catch { return null; }
  return { move: 'step.clarify', id: data.step, ...policy };
}
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Review, clarification and question-placement findings `workflow check` reports for this workflow. */
function settingsCandidates({ findings, policyOf }) {
  return findings.filter((finding) => (SETTINGS_CODE.test(finding.code) || SETTINGS_AREAS.has(finding.area))
      && (finding.severity !== 'note' || finding.fix?.move || clarifyMoveOf(finding, policyOf)))
    .map((finding) => {
      const move = finding.fix?.move ?? clarifyMoveOf(finding, policyOf);
      const decides = finding.fix?.data?.decidedBy === 'person' && finding.fix.data.question?.text;
      return {
        kind: 'contradicting-settings', subject: { finding: finding.code, ...(finding.subject?.step ? { step: finding.subject.step } : {}) },
        title: finding.title,
        why: [finding.detail, finding.fix?.text].filter(Boolean).join(' '),
        location: finding.location ?? null,
        moves: move ? [move] : [],
        ...(move ? {} : { notOffered: decides ? `A person decides: ${finding.fix.data.question.text}`
          : `No build move changes this setting; ${finding.fix?.text ? `${finding.fix.text.charAt(0).toLowerCase()}${finding.fix.text.slice(1)}` : 'change it in Workflow Studio.'}` })
      };
    });
}

/** A team step whose template the kernel cannot read, where a shipped step writes the same kind of document. */
function templateCandidates({ workflow, model, labelOf, findings, definition, packaged }) {
  if (!definition) return [];
  const planned = plannedSteps(workflow);
  const refs = references(workflow);
  const byStep = new Map();
  for (const finding of findings.filter((entry) => /^CHECK_TEMPLATE_/u.test(entry.code) && entry.severity !== 'note' && entry.subject?.step)) {
    byStep.set(finding.subject.step, [...(byStep.get(finding.subject.step) ?? []), finding]);
  }
  const candidates = [];
  for (const [id, found] of byStep) {
    const step = workflow.steps.find((entry) => entry.id === id);
    const kind = definition.phases?.[id]?.artifact?.kind;
    if (!step || packaged.has(id) || !kind) continue;
    const shipped = [...packaged].find((other) => other !== id && !workflow.phases.includes(other) && definition.phases?.[other]?.artifact?.kind === kind
      && model.phases.find((phase) => phase.id === other)?.output === step.output);
    if (!shipped) continue;
    const routed = refs.routedTo(id);
    const notOffered = planned.has(id) ? `The workflow's planned claims name ${labelOf(id)}, and no build move changes planned claims: fix its template instead (/sf-fix-workflow drafts that).`
      : routed.length || refs.decisionAfter(id) ? `A decision is attached to ${labelOf(id)}; move it in Workflow Studio first.` : null;
    const shippedLabel = model.phases.find((phase) => phase.id === shipped)?.label ?? shipped;
    candidates.push({
      kind: 'shipped-template', subject: { step: id, shipped },
      title: `${labelOf(id)} could use the shipped ${shippedLabel} step`,
      why: `${found.map((entry) => entry.title).join('; ')}. The shipped ${shippedLabel} step (${shipped}) writes the same kind of document (${kind}) with a template the kernel reads; in this workflow it takes ${labelOf(id)}'s place, reads what it read and is signed off as it was, drafted by its own agent (${model.phases.find((phase) => phase.id === shipped)?.agent ?? 'its default agent'}).`,
      location: found[0].location ?? null,
      moves: notOffered ? [] : [
        { move: 'step.add', id: shipped, after: id },
        { move: 'step.change', id: shipped, reads: [...(step.inputs ?? [])],
          signOff: step.approval?.mode === 'none' ? 'none' : { groups: [...step.approval.authorities], minimum: step.approval.minimum || 1,
            sendBackTo: unique((step.sendBackTo ?? []).map((target) => (target === id ? shipped : target))) } },
        { move: 'step.remove', id },
        ...repointMoves(workflow, id, shipped)
      ],
      ...(notOffered ? { notOffered } : {})
    });
  }
  return candidates;
}

/** Repository findings for agents, skills and instructions nothing uses, as candidates on the build's items. */
function unusedCandidates({ repositoryFindings }) {
  return repositoryFindings.filter((finding) => UNUSED[finding.code]).map((finding) => {
    const kind = UNUSED[finding.code];
    const id = finding.subject?.[kind];
    return {
      kind: 'unused-asset', subject: { [kind]: id },
      title: finding.title,
      why: `${finding.detail} The simpler workflow does not carry it. Removing the file from the repository is a change of its own: ${finding.fix?.text ?? 'remove it in Workflow Studio.'}`,
      location: finding.location ?? null,
      items: [unusedItemId(kind, id)],
      moves: [{ move: 'item.leaveOut', item: unusedItemId(kind, id), reason: `Nothing uses it: ${finding.detail}`.slice(0, 600) }]
    };
  });
}

export const unusedItemId = (kind, id) => `i-unused-${kind}-${id}`;

/** The build items for what nothing uses, so a candidate can leave each out with its reason. */
export function unusedAssetItems(repositoryFindings, model) {
  return repositoryFindings.filter((finding) => UNUSED[finding.code] && finding.subject?.[UNUSED[finding.code]]).map((finding) => {
    const kind = UNUSED[finding.code];
    const id = finding.subject[kind];
    const asset = (kind === 'agent' ? model.agents : kind === 'skill' ? model.skills ?? [] : model.instructions ?? []).find((entry) => entry.id === id);
    return { id: unusedItemId(kind, id), kind, name: asset?.label ?? id, detail: finding.detail,
      evidence: finding.location ? [{ path: `configuration:${finding.location.file}`, sha256: null, startLine: finding.location.line ?? 1, endLine: finding.location.line ?? 1 }] : [],
      foundBy: 'workflow', certainty: 'stated', status: 'open', [kind]: id, unused: true };
  });
}

/**
 * Every candidate the platform can see for `workflow` (an entry of the Studio model), in a fixed
 * order: by kind, then by where it is in the workflow. `findings` are `workflow check`'s for this
 * workflow, `repositoryFindings` its repository findings; `locate` is yamlLocator on workflow.yml.
 */
export function simplificationCandidates({ model, workflow, findings = [], repositoryFindings = [], locate = () => null, definition = null, packaged = new Set() }) {
  const labelOf = (id) => workflow.steps.find((step) => step.id === id)?.label ?? model.phases.find((phase) => phase.id === id)?.label ?? id;
  const groupLabel = (id) => model.groups.find((group) => group.id === id)?.label ?? id;
  const templateOf = (step) => step.template ?? model.phases.find((phase) => phase.id === step.id)?.template ?? null;
  const resolved = (() => { try { return definition ? resolveWorkType(definition, workflow.id) : null; } catch { return null; } })();
  const policyOf = (id) => resolved?.phases?.find((phase) => phase.id === id)?.clarification ?? null;
  const context = { workflow, model, labelOf, groupLabel, templateOf, locate, findings, repositoryFindings, definition, packaged, policyOf };
  const duplicates = duplicateCandidates(context);
  const all = [...loopCandidates(context), ...duplicates, ...unneededCandidates({ ...context, skip: new Set(duplicates.map((entry) => entry.subject.step)) }),
    ...groupCandidates(context), ...settingsCandidates(context), ...templateCandidates(context), ...unusedCandidates(context)];
  return all.map((candidate) => ({ id: candidateId(candidate.kind, candidate.subject), ...candidate, location: candidate.location ?? null,
    items: candidate.items ?? [], notOffered: candidate.notOffered ?? null }));
}

/** The step IDs the packaged workflow.yml defines: shipped steps a team step could use instead. */
export async function packagedPhaseIds() {
  const { PACKAGE_ROOT } = await import('../package-root.mjs');
  const YAML = (await import('yaml')).default;
  try { return new Set(Object.keys(YAML.parse(await readFile(path.join(PACKAGE_ROOT, 'templates', 'workflow.yml'), 'utf8'))?.phases ?? {})); }
  catch { return new Set(); }
}

/** What `workflow check` finds, by what it is about, so a candidate's check can say what it would add. */
const problemKey = (finding) => JSON.stringify([finding.code, finding.subject?.step ?? null, finding.subject?.decision ?? null, finding.subject?.template ?? null, finding.subject?.group ?? null]);

/** The problems `workflow check` finds in the workflow a draft makes, and whether the original stays as it was. */
async function draftProblems(repository, draft, model, originalId) {
  const { checkWorkflowConfiguration } = await import('../workflow-check.mjs');
  const { buildStudioModel } = await import('../workflow-studio.mjs');
  const { plan } = await planFor(repository, draft, model, { inspect: async (candidate) => ({
    check: await checkWorkflowConfiguration(candidate, { workflows: [draft.workflow.id] }),
    original: originalId ? workflowFingerprint((await buildStudioModel(candidate)).workflows.find((workflow) => workflow.id === originalId)) : null
  }) });
  if (!plan.valid) return { valid: false, message: plan.problems[0]?.message ?? 'Workflow Studio cannot save it.', problems: [] };
  const check = plan.inspection?.check;
  return { valid: true, original: plan.inspection?.original ?? null,
    problems: [...(check?.workflows?.[0]?.findings ?? []), ...(check?.repository?.findings ?? []).filter((entry) => entry.blocksStart)].filter((entry) => entry.severity === 'problem') };
}

/**
 * Why a candidate's moves cannot be offered against `draft`, or null when they can: they must be
 * moves that change only the copy, fit the draft like any proposal, leave a configuration Studio can
 * save, add no problem, and leave the original workflow exactly as it was.
 */
export async function candidateRefusal({ repository, model, draft, moves, originalId, baseline }) {
  const foreign = moves.find((move) => !copyOnlyMove(move, model));
  if (foreign) return `${foreign.move} ${foreign.id ?? ''} would change a step other workflows use too; a simpler copy changes only itself.`.replace(/ {2}/u, ' ');
  const findings = validateMoves(moves, { model, draft });
  if (findings.length) return `Its moves do not fit the workflow as it is now: ${findings[0].message}`;
  if (moves.every((move) => move.move.startsWith('item.'))) return null;
  const before = baseline ?? await draftProblems(repository, draft, model, originalId);
  const after = await draftProblems(repository, applyMoves(draft, moves), model, originalId);
  if (!after.valid) return `Workflow Studio could not save the workflow it leaves: ${after.message}`;
  if (originalId && before.original && after.original !== before.original) return 'It would change the original workflow too.';
  const known = new Set(before.problems.map(problemKey));
  const added = after.problems.filter((entry) => !known.has(problemKey(entry)));
  return added.length ? `It would add a problem: ${added[0].title}${added.length > 1 ? `, and ${added.length - 1} more` : ''}.` : null;
}

function turn(by, kind, text, extra = {}) {
  return { at: new Date().toISOString(), by, kind, text, ...extra };
}

/**
 * Find the candidates for a simplify build's workflow, check each one, and record the ones that
 * pass as pending proposals by SFlow. Run once, when the build starts; the record is saved.
 */
export async function offerSimplifications(record, { root = null, env = process.env } = {}) {
  const repository = repositoryOf(record, root);
  const originalId = record.goal.simplify.from;
  const { checkWorkflowConfiguration, yamlLocator } = await import('../workflow-check.mjs');
  const { configurationReadRoot } = await import('../configuration-read-scope.mjs');
  const { loadDefinition, WORKFLOW_PATH } = await import('../config.mjs');
  const packaged = await packagedPhaseIds();
  let basis = null;
  const offered = await withRepository(repository, async (model) => {
    record.goal.workflow = targetWorkflow(record, model);
    const workflow = model.workflows.find((entry) => entry.id === originalId);
    if (!workflow) fail('WORKFLOW_UNKNOWN', `There is no workflow '${originalId}'.`);
    const check = await checkWorkflowConfiguration(repository, { workflows: [originalId] });
    // What nothing uses becomes an item of the build, so a candidate can leave it out with its reason.
    const known = new Set(record.items.map((item) => item.id));
    for (const item of unusedAssetItems(check.repository?.findings ?? [], model)) if (!known.has(item.id)) record.items.push(item);
    const text = await readFile(path.join(configurationReadRoot(repository), WORKFLOW_PATH), 'utf8').catch(() => '');
    const definition = await loadDefinition(repository).catch(() => null);
    const candidates = simplificationCandidates({ model, workflow, findings: check.workflows?.[0]?.findings ?? [], repositoryFindings: check.repository?.findings ?? [],
      locate: yamlLocator(text, WORKFLOW_PATH), definition, packaged });
    const draft = draftOf(record, model);
    basis = checkBasis(record, model);
    const baseline = await draftProblems(repository, draft, model, originalId);
    for (const candidate of candidates) {
      if (candidate.notOffered || !candidate.moves.length) continue;
      const refusal = await candidateRefusal({ repository, model, draft, moves: candidate.moves, originalId, baseline });
      if (refusal) candidate.notOffered = refusal;
    }
    return candidates;
  });
  const now = new Date().toISOString();
  for (const candidate of offered.filter((entry) => !entry.notOffered && entry.moves.length)) {
    const proposal = { id: `p-${record.proposals.length + 1}`, by: 'sflow', title: candidate.title, why: candidate.why, moves: candidate.moves,
      evidence: [], items: candidate.items, status: 'pending', createdAt: now, candidate: candidate.id, checkedWith: basis };
    record.proposals.push(proposal);
    candidate.proposal = proposal.id;
  }
  record.simplify = { from: originalId, checkedAt: now, candidates: offered.map((entry) => ({ ...entry, proposal: entry.proposal ?? null })) };
  const ready = offered.filter((entry) => entry.proposal);
  const waiting = offered.filter((entry) => !entry.proposal);
  record.conversation.push(turn('sflow', 'simplify', offered.length
    ? `Found ${offered.length} way${offered.length === 1 ? '' : 's'} to make it simpler. ${ready.length ? `Checked and offered, each for you to accept or decline: ${ready.map((entry) => `${entry.proposal} ${entry.title}`).join('; ')}.` : ''}`
      + `${waiting.length ? ` Not offered, with why: ${waiting.map((entry) => `${entry.title} (${entry.notOffered})`).join('; ')}` : ''}`.trim()
    : 'Found nothing the platform can see to leave out or merge.'));
  return saveWorkflowBuild(record, { env });
}

/** What a candidate was checked against: the proposals accepted so far and the configuration they apply to. */
function checkBasis(record, model) {
  const accepted = record.proposals.filter((proposal) => proposal.status === 'accepted').map((proposal) => proposal.id);
  return `sha256:${createHash('sha256').update(JSON.stringify([accepted, model.base ?? null])).digest('hex')}`;
}

/**
 * Whether an SFlow candidate still fits and adds no problem, against what the build has accepted
 * since it was offered: null when it does, else why (decideInBuild marks it stale). Checked when it
 * was offered, it is not checked again until something else was accepted or the configuration
 * changed. Its moves change only the copy (copyOnlyMove), and `verifyBuild` compares the original
 * workflow itself before the build finishes.
 */
export async function candidateStillFits(record, proposal, { repository, model }) {
  if (proposal.checkedWith && proposal.checkedWith === checkBasis(record, model)) return null;
  return candidateRefusal({ repository, model, draft: draftOf(record, model), moves: proposal.moves, originalId: null });
}

// ---------------------------------------------------------------------------------------------
// Verification: `workflow validate` (and `workflow walk`) on the workflow as the build leaves it.

/**
 * What `workflow walk` (src/workflow-walk/walk.mjs, result schemaVersion 1) leaves in the way for
 * `workflowId`, as `[{ id, step, title, detail, kind }]`. Fields used: `workflows[]` (the entry whose
 * `id` is the workflow: its `outcome` and `reason`, and its `steps[].notJudged[]` with `code` and
 * `message`), and its `stops[]` (or the result's own `stops[]`) with `step`, `code`, `command`,
 * `message` and `cause`; a stop with `personDecision: true` is a person's real decision and is not
 * counted. A stop's ID comes from its step, code and command, so the one `verify` shows is the one
 * `finish --accept-problem` names.
 */
export function walkStops(result, workflowId) {
  const entry = Array.isArray(result?.workflows) ? result.workflows.find((item) => item?.id === workflowId) : null;
  const stops = Array.isArray(entry?.stops) ? entry.stops : Array.isArray(result?.stops) ? result.stops : [];
  const idOf = (basis) => `walk-${createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 10)}`;
  // A refusal's message can name the walk's own temporary folder; the ID never depends on it.
  const steady = (text) => String(text ?? '').replace(/\S*sflow-workflow-walk-\S*/gu, '<walk>');
  const found = stops.filter((stop) => stop && stop.personDecision !== true).map((stop) => {
    const step = stop.step ?? stop.at ?? stop.phase ?? null;
    const title = String(stop.title ?? stop.message ?? stop.reason ?? `A Story stops${step ? ` at ${step}` : ''}`);
    const id = typeof stop.id === 'string' && stop.id ? stop.id : idOf(stop.code ? [step, stop.code, stop.command ?? null] : [step, steady(title)]);
    return { id, step, title, detail: stop.cause ?? stop.detail ?? null, kind: 'stop', ...(stop.code ? { code: stop.code } : {}) };
  });
  // A step the walk could not judge, or a workflow it did not walk, is not a pass either.
  for (const step of entry?.steps ?? []) {
    for (const item of step?.notJudged ?? []) {
      found.push({ id: idOf([step.id, 'not-judged', item.code ?? null]), step: step.id, title: `The walk could not judge ${step.label ?? step.id}: ${item.message ?? item.code ?? 'no reason given'}`,
        detail: null, kind: 'not-judged', ...(item.code ? { code: item.code } : {}) });
    }
  }
  if (entry?.outcome === 'not-walked') found.push({ id: idOf([workflowId, 'not-walked']), step: null, title: `The walk did not walk ${entry.label ?? workflowId}: ${entry.reason ?? 'no reason given'}`, detail: null, kind: 'not-judged' });
  return found;
}

/**
 * `workflow walk` on the workflow as the build leaves it, when this SFlow has the command:
 * feature-detected in the command registry (operation `workflow.walk`). It runs the walk's own module
 * in this process with `configurationRoot` set to the staged copy the build's change set makes, so it
 * walks the new workflow, which the repository does not have yet; the walk copies that configuration
 * into its own throwaway folder and touches nothing else. Without the command the result says so and
 * only `workflow validate` decides.
 */
export async function walkCandidate({ repository, candidate, workflow }) {
  const { operationById } = await import('../command-registry.mjs');
  if (!operationById('workflow.walk')) return { available: false, reason: 'This SFlow has no `workflow walk`, so only `workflow validate` checked the result.', stops: [] };
  const command = `singularity-flow workflow walk ${workflow} --json`;
  try {
    const { walkWorkflows } = await import('../workflow-walk/walk.mjs');
    const result = await walkWorkflows(repository, { workflow, configurationRoot: candidate, totalSeconds: WALK_TOTAL_SECONDS });
    return { available: true, command, outcome: result.workflows?.[0]?.outcome ?? null, stops: walkStops(result, workflow) };
  } catch (error) {
    return { available: true, command, error: error.message, outcome: null,
      stops: [{ id: 'walk-failed', step: null, title: `The walk could not run: ${error.message}`, detail: null, kind: 'not-judged' }] };
  }
}
// One workflow, walked once per verification (and kept for finishing while the build is unchanged).
const WALK_TOTAL_SECONDS = 1800;

/**
 * The problems a validation reports for one workflow: its own findings, and anything that stops the
 * configuration from loading. A problem whose fix the builder can make carries that `move`.
 */
function validationProblems(validation, workflowId, policyOf = () => null) {
  const own = validation.workflows.find((entry) => entry.id === workflowId);
  const seen = new Set();
  const problems = [...(own?.findings ?? []), ...(validation.repository?.findings ?? []).filter((entry) => entry.blocksStart)]
    .filter((entry) => entry.severity === 'problem' && !seen.has(entry.id) && seen.add(entry.id));
  const items = problems.map((entry) => ({ id: entry.id, source: 'validate', code: entry.code, title: entry.title, detail: entry.detail ?? null,
    location: entry.location ?? null, ...(entry.fix?.text ? { fix: entry.fix.text } : {}),
    ...((entry.fix?.move ?? clarifyMoveOf(entry, policyOf)) ? { move: entry.fix?.move ?? clarifyMoveOf(entry, policyOf) } : {}), acceptable: true }));
  if (own && !own.valid && !items.length) {
    items.push({ id: 'validate-not-valid', source: 'validate', code: own.status, title: own.reason ?? `workflow validate says ${own.label ?? workflowId} is not valid`, detail: null, location: null, acceptable: true });
  }
  return items;
}

/**
 * Verify what a build would propose: `workflow validate`'s own engine (validateWorkflows, the JSON
 * `workflow validate --json` prints) and `workflow walk` (when present) on the configuration as the
 * build's change set leaves it, and the original workflow unchanged. `remaining` lists every problem
 * and stop, each by ID; one that changes the original can never be accepted. A walk takes minutes,
 * so the build keeps its last one, keyed by the exact change set (the configuration's own digests
 * included): finishing an unchanged build reuses it rather than walking again.
 */
export async function verifyBuild(id, { root = null, env = process.env, walk = walkCandidate, accepted = [] } = {}) {
  const record = await readWorkflowBuild(id, { env });
  const repository = repositoryOf(record, root);
  const { validateWorkflows } = await import('../workflow-validation.mjs');
  const { buildStudioModel } = await import('../workflow-studio.mjs');
  const originalId = record.goal.simplify?.from ?? record.goal.startedFrom.find((entry) => entry.kind === 'workflow' && !entry.change)?.id ?? null;
  const outcome = await withRepository(repository, async (model) => {
    record.goal.workflow = targetWorkflow(record, model);
    const draft = draftOf(record, model);
    const workflowId = draft.workflow.id;
    const before = originalId ? workflowFingerprint(model.workflows.find((workflow) => workflow.id === originalId)) : null;
    const walkKey = `sha256:${createHash('sha256').update(JSON.stringify(lowerDraft(draft, model))).digest('hex')}`;
    const kept = walk === walkCandidate && record.verification?.walkKept?.key === walkKey ? record.verification.walkKept.walk : null;
    const { changeSet, plan } = await planFor(repository, draft, model, { inspect: async (candidate) => {
      const validation = await validateWorkflows(candidate, { workflow: workflowId, env });
      const { loadDefinition } = await import('../config.mjs');
      const resolved = await loadDefinition(candidate).then((definition) => resolveWorkType(definition, workflowId), () => null);
      const policies = Object.fromEntries((resolved?.phases ?? []).map((phase) => [phase.id, phase.clarification ?? null]));
      return { validation, policies, walk: kept ? { ...kept, reused: true } : await walk({ repository, candidate, workflow: workflowId }),
        original: originalId ? workflowFingerprint((await buildStudioModel(candidate)).workflows.find((workflow) => workflow.id === originalId)) : null };
    } });
    return { workflowId, label: draft.workflow.label, changeSet, plan, before, walkKey };
  });
  const { workflowId, changeSet, plan, before, walkKey } = outcome;
  const inspection = plan.inspection ?? null;
  const remaining = [];
  if (!plan.valid) remaining.push(...plan.problems.map((problem, index) => ({ id: `plan-${index + 1}`, source: 'plan', code: problem.code, title: problem.message, detail: null, location: null, acceptable: false })));
  if (!changeSet.changes.length) remaining.push({ id: 'nothing-changed', source: 'plan', code: 'WORKFLOW_BUILD_NOT_READY', title: 'The build changes nothing yet.', detail: null, location: null, acceptable: false });
  const { fixDraft, nextAction, ...validation } = inspection?.validation ?? {};
  if (inspection?.validation) remaining.push(...validationProblems(inspection.validation, workflowId, (step) => inspection.policies?.[step] ?? null));
  const walked = inspection?.walk ?? { available: false, reason: 'The workflow could not be staged, so it was not walked.', stops: [] };
  remaining.push(...(walked.stops ?? []).map((stop) => ({ ...stop, source: 'walk', acceptable: true })));
  if (originalId && inspection && inspection.original !== before) {
    remaining.push({ id: 'original-changed', source: 'original', code: 'WORKFLOW_SIMPLIFY_ORIGINAL_CHANGED', title: `The change set would also change ${originalId}; a simpler workflow is a new one and leaves the original as it is.`, detail: null, location: null, acceptable: false });
  }
  const acceptedIds = new Set(accepted);
  const open = remaining.filter((entry) => !(entry.acceptable && acceptedIds.has(entry.id)));
  // A problem no build move fixes comes from the workflow the build copies (its templates, its shared
  // steps): fixing that workflow is /sf-fix-workflow's, and this build's draft picks the fix up.
  const unfixable = open.some((entry) => entry.source === 'validate' && !entry.move);
  const fixRoute = unfixable && originalId ? (await import('../safe-command-guidance.mjs')).safeCommandGuidance({ command: `singularity-flow workflow validate ${originalId}`, skill: '/sf-fix-workflow' }) : null;
  const result = {
    schemaVersion: 1, resultType: 'workflow-build-verification',
    build: { id: record.id, label: record.goal.label, workflow: workflowId, ...(originalId ? { from: originalId } : {}) },
    validation: inspection?.validation ? validation : null,
    walk: { available: Boolean(walked.available), ...(walked.command ? { command: walked.command } : {}), ...(walked.outcome ? { outcome: walked.outcome } : {}),
      ...(walked.reused ? { reused: true } : {}), ...(walked.reason ? { reason: walked.reason } : {}), ...(walked.error ? { error: walked.error } : {}), stops: walked.stops ?? [] },
    remaining, accepted: remaining.filter((entry) => entry.acceptable && acceptedIds.has(entry.id)).map((entry) => entry.id),
    ready: !open.length,
    finish: `singularity-flow workflow build finish --build ${record.id} --propose`,
    ...(fixRoute ? { nextAction: { label: `Fix ${originalId} itself (this build picks the fix up)`, command: fixRoute.command, skill: '/sf-fix-workflow',
      copilotCommand: fixRoute.copilotCommand, modelFreeCommand: fixRoute.modelFreeCommand ?? null } } : {})
  };
  const { reused, ...walkResult } = walked;
  record.verification = { at: new Date().toISOString(), ready: result.ready, remaining: remaining.map((entry) => entry.id), walk: result.walk.available,
    // A real walk that ran is kept for this exact change set; a walk that failed to run is not.
    ...(walk === walkCandidate && walked.available && !walked.error ? { walkKept: { key: walkKey, walk: walkResult } } : {}) };
  await saveWorkflowBuild(record, { env });
  return result;
}
