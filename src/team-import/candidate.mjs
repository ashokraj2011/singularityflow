/**
 * The `team-import-candidate` record: the only thing `workflow import-team compile` accepts from
 * the model. [TAWI §5]
 *
 * It is closed. Every object has a fixed field set, every generated ID carries the namespace,
 * every mapping cites evidence spans inside the capture, and nothing in it can claim a hash, an
 * approval, a validation result or a person's decision: compile computes those, and answers to
 * open questions are recorded by `compile --answer`, never written by the model.
 *
 * Validation collects every finding instead of stopping at the first, so one repair pass can fix
 * them together. Each finding names the field (`at`), the code, and who can fix it (`model` for
 * a candidate error, `person` for a missing fact).
 */
import { readRecord } from '../schema-migrations.mjs';

export const CANDIDATE_KIND = 'team-import-candidate';
export const DISPOSITIONS = Object.freeze(['mapped', 'approximated', 'unresolved', 'unsupported', 'excluded']);
export const MAPPING_KINDS = Object.freeze(['explicit', 'inferred', 'destination-policy']);
export const PREREQUISITE_KINDS = Object.freeze(['authority', 'quality-command', 'environment', 'tool', 'script', 'other']);
const ID = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u;
const NAMESPACE = /^[a-z][a-z0-9]{1,15}$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const TEMPLATE_REF = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\.md$/u;
const ARTIFACT_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,200}\.md$/u;

const FIELDS = Object.freeze({
  candidate: ['schemaVersion', 'kind', 'sessionId', 'captureSha256', 'namespace', 'workflow', 'authorities', 'phases',
    'agents', 'skills', 'instructions', 'templates', 'attachments', 'mappings', 'prerequisites', 'decisionsNeeded'],
  workflow: ['id', 'label', 'phases', 'decisions', 'sourceReview', 'omits'],
  authority: ['id', 'label', 'kind', 'evidence'],
  phase: ['id', 'label', 'agent', 'template', 'artifact', 'inputs', 'writeScope', 'code', 'qualityCommands', 'approval'],
  artifact: ['path', 'kind'],
  qualityCommand: ['argv', 'evidence'],
  approval: ['mode', 'authorities', 'minimum', 'allowSelfApproval'],
  sourceReview: ['phases', 'reviewerAgent'],
  agent: ['id', 'label', 'description', 'tools', 'body'],
  skill: ['id', 'description', 'loading', 'body'],
  instruction: ['id', 'description', 'body'],
  template: ['ref', 'body'],
  attachment: ['skill', 'agent', 'workflow', 'steps', 'use'],
  mapping: ['sourceItem', 'evidence', 'target', 'disposition', 'kind', 'material', 'decision', 'reason'],
  evidence: ['path', 'sha256', 'startLine', 'endLine'],
  prerequisite: ['id', 'kind', 'description', 'evidence'],
  decisionNeeded: ['id', 'question', 'choices', 'blocking']
});
const OPTIONAL = Object.freeze({
  phase: ['inputs', 'qualityCommands', 'code'],
  approval: ['allowSelfApproval'],
  agent: ['tools'],
  skill: ['loading'],
  attachment: ['agent', 'workflow', 'steps', 'use'],
  mapping: ['material', 'decision', 'reason'],
  authority: ['evidence'],
  workflow: ['decisions', 'sourceReview', 'omits']
});
const LIMITS = Object.freeze({ phases: 30, agents: 40, skills: 64, instructions: 64, templates: 40, mappings: 2000, body: 30_000 });

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Check a candidate against the capture it interprets. Returns `{ findings, candidate }`, where
 * `candidate` is the parsed record (or null when it is not even a record of this family).
 */
export function validateCandidate(text, { session }) {
  const findings = [];
  const add = (at, code, message, owner = 'model') => findings.push({ at, code, message, owner });
  let candidate;
  try {
    candidate = readRecord(CANDIDATE_KIND, text).record;
  } catch (error) {
    add('$', error.code ?? 'TEAM_IMPORT_CANDIDATE_INVALID', `The candidate is not a ${CANDIDATE_KIND} record: ${error.message}`);
    return { findings, candidate: null };
  }
  const closed = (value, kind, at) => {
    if (!plain(value)) { add(at, 'TEAM_IMPORT_CANDIDATE_SHAPE', `${at} must be an object.`); return false; }
    const allowed = FIELDS[kind];
    const optional = OPTIONAL[kind] ?? [];
    for (const field of Object.keys(value)) if (!allowed.includes(field)) add(`${at}.${field}`, 'TEAM_IMPORT_CANDIDATE_FIELD_UNKNOWN', `${at} has no field '${field}'.`);
    for (const field of allowed) if (!optional.includes(field) && !Object.hasOwn(value, field)) add(`${at}.${field}`, 'TEAM_IMPORT_CANDIDATE_FIELD_MISSING', `${at} needs '${field}'.`);
    return true;
  };
  const list = (value, at, limit = 500) => {
    if (!Array.isArray(value)) { add(at, 'TEAM_IMPORT_CANDIDATE_SHAPE', `${at} must be a list.`); return []; }
    if (value.length > limit) add(at, 'TEAM_IMPORT_CANDIDATE_LIMIT', `${at} has ${value.length} entries; the limit is ${limit}.`);
    return value.slice(0, limit);
  };
  const text1 = (value, at, max = 400) => {
    if (typeof value !== 'string' || !value.trim()) add(at, 'TEAM_IMPORT_CANDIDATE_SHAPE', `${at} must be non-empty text.`);
    else if (value.length > max) add(at, 'TEAM_IMPORT_CANDIDATE_LIMIT', `${at} is longer than ${max} characters.`);
  };
  if (!closed(candidate, 'candidate', '$')) return { findings, candidate: null };
  if (candidate.kind !== CANDIDATE_KIND) add('$.kind', 'TEAM_IMPORT_CANDIDATE_SHAPE', `kind must be '${CANDIDATE_KIND}'.`);
  if (candidate.sessionId !== session.id) add('$.sessionId', 'TEAM_IMPORT_CANDIDATE_SESSION', `The candidate names session '${candidate.sessionId}', not ${session.id}.`);
  if (!SHA.test(candidate.captureSha256 ?? '') || candidate.captureSha256 !== session.capture.sha256) {
    add('$.captureSha256', 'TEAM_IMPORT_CANDIDATE_STALE', `The candidate interprets capture ${candidate.captureSha256}; this session captured ${session.capture.sha256}. Copy captureSha256 from inspect.`);
  }
  const namespace = candidate.namespace;
  if (!NAMESPACE.test(namespace ?? '')) add('$.namespace', 'TEAM_IMPORT_CANDIDATE_NAMESPACE', 'namespace must be 2-16 lowercase letters or digits, starting with a letter.');
  const prefix = `${namespace}-`;
  const ids = new Map();
  const claim = (id, kind, at) => {
    if (typeof id !== 'string' || !ID.test(id)) { add(at, 'TEAM_IMPORT_CANDIDATE_ID', `${at} '${id}' is not a kebab-case ID.`); return; }
    if (NAMESPACE.test(namespace ?? '') && !id.startsWith(prefix)) add(at, 'TEAM_IMPORT_CANDIDATE_NAMESPACE', `${at} '${id}' must start with '${prefix}' so it cannot collide with a destination's own ${kind}.`);
    // Case-insensitive within a kind: Windows and macOS file systems cannot hold both. [TAWI-REQ-016]
    const key = `${kind}:${id.toLowerCase()}`;
    if (ids.has(key)) add(at, 'TEAM_IMPORT_CANDIDATE_ID_COLLISION', `${kind} '${id}' is declared twice (also at ${ids.get(key)}).`);
    else ids.set(key, at);
  };
  const files = new Map(session.capture.files.map((file) => [file.path, file]));
  const evidence = (value, at, required = true) => {
    const spans = list(value ?? [], at, 50);
    if (required && !spans.length) add(at, 'TEAM_IMPORT_EVIDENCE_MISSING', `${at} needs at least one evidence span from the capture.`);
    spans.forEach((span, index) => {
      const where = `${at}[${index}]`;
      if (!closed(span, 'evidence', where)) return;
      const file = files.get(span.path);
      if (!file) { add(where, 'TEAM_IMPORT_EVIDENCE_UNKNOWN', `${where} cites '${span.path}', which is not in the capture.`); return; }
      if (file.screening !== 'clean') add(where, 'TEAM_IMPORT_EVIDENCE_WITHHELD', `${where} cites '${span.path}', which was ${file.screening}; it cannot be evidence.`);
      if (span.sha256 !== file.sha256) add(where, 'TEAM_IMPORT_EVIDENCE_STALE', `${where} gives sha256 ${span.sha256} for '${span.path}'; the capture has ${file.sha256}.`);
      if (!Number.isInteger(span.startLine) || !Number.isInteger(span.endLine) || span.startLine < 1
          || span.endLine < span.startLine || span.endLine > (file.lines ?? 0)) {
        add(where, 'TEAM_IMPORT_EVIDENCE_SPAN', `${where} lines ${span.startLine}-${span.endLine} are not inside '${span.path}' (1-${file.lines ?? 0}).`);
      }
    });
  };

  const workflow = candidate.workflow;
  if (closed(workflow, 'workflow', '$.workflow')) {
    claim(workflow.id, 'workflow', '$.workflow.id');
    text1(workflow.label, '$.workflow.label', 80);
    list(workflow.phases, '$.workflow.phases', LIMITS.phases).forEach((id, index) => {
      if (typeof id !== 'string') add(`$.workflow.phases[${index}]`, 'TEAM_IMPORT_CANDIDATE_SHAPE', 'Workflow phases are phase IDs.');
    });
    if (Object.hasOwn(workflow, 'decisions')) list(workflow.decisions, '$.workflow.decisions', LIMITS.phases);
    // A responsibility the source genuinely lacks is declared, with why and who records it.
    if (Object.hasOwn(workflow, 'omits')) list(workflow.omits, '$.workflow.omits', 5);
  }
  list(candidate.authorities, '$.authorities', 20).forEach((authority, index) => {
    const at = `$.authorities[${index}]`;
    if (!closed(authority, 'authority', at)) return;
    claim(authority.id, 'authority', `${at}.id`);
    text1(authority.label, `${at}.label`, 80);
    if (!MAPPING_KINDS.includes(authority.kind)) add(`${at}.kind`, 'TEAM_IMPORT_CANDIDATE_SHAPE', `${at}.kind must be one of ${MAPPING_KINDS.join(', ')}.`);
    if (authority.kind === 'explicit') evidence(authority.evidence, `${at}.evidence`);
  });
  const phaseIds = new Set();
  list(candidate.phases, '$.phases', LIMITS.phases).forEach((phase, index) => {
    const at = `$.phases[${index}]`;
    if (!closed(phase, 'phase', at)) return;
    claim(phase.id, 'phase', `${at}.id`);
    phaseIds.add(phase.id);
    text1(phase.label, `${at}.label`, 80);
    if (typeof phase.agent !== 'string') add(`${at}.agent`, 'TEAM_IMPORT_CANDIDATE_SHAPE', `${at}.agent names the phase's default agent.`);
    if (!TEMPLATE_REF.test(phase.template ?? '') || !phase.template.startsWith(`${namespace}/`)) {
      add(`${at}.template`, 'TEAM_IMPORT_CANDIDATE_TEMPLATE', `${at}.template must be '${namespace}/<name>.md', a template the candidate carries.`);
    }
    if (closed(phase.artifact, 'artifact', `${at}.artifact`)) {
      if (!ARTIFACT_PATH.test(phase.artifact.path ?? '')) add(`${at}.artifact.path`, 'TEAM_IMPORT_CANDIDATE_SHAPE', 'artifact.path is a relative Markdown path inside the Story (artifacts/<phase>/<name>.md).');
      if (typeof phase.artifact.kind !== 'string' || !ID.test(phase.artifact.kind)) add(`${at}.artifact.kind`, 'TEAM_IMPORT_CANDIDATE_SHAPE', 'artifact.kind is a kebab-case word such as plan or test-report.');
    }
    if (!['artifact-only', 'source-and-artifact'].includes(phase.writeScope)) add(`${at}.writeScope`, 'TEAM_IMPORT_CANDIDATE_SHAPE', 'writeScope is artifact-only or source-and-artifact.');
    if (Object.hasOwn(phase, 'code') && typeof phase.code !== 'boolean') add(`${at}.code`, 'TEAM_IMPORT_CANDIDATE_SHAPE', 'code is true or false.');
    if (phase.code === true && phase.writeScope !== 'source-and-artifact') add(`${at}.writeScope`, 'TEAM_IMPORT_CODE_SCOPE', 'A code phase writes source: writeScope must be source-and-artifact.');
    if (phase.code !== true && phase.writeScope === 'source-and-artifact') add(`${at}.writeScope`, 'TEAM_IMPORT_CODE_SCOPE', 'Only a code phase may write source; planning or review phases stay artifact-only. [TAWI-REQ-009]');
    list(phase.inputs ?? [], `${at}.inputs`, LIMITS.phases);
    list(phase.qualityCommands ?? [], `${at}.qualityCommands`, 10).forEach((command, commandIndex) => {
      const where = `${at}.qualityCommands[${commandIndex}]`;
      if (!closed(command, 'qualityCommand', where)) return;
      if (!Array.isArray(command.argv) || !command.argv.length || command.argv.some((arg) => typeof arg !== 'string' || !arg)) {
        add(`${where}.argv`, 'TEAM_IMPORT_CANDIDATE_SHAPE', 'argv is the command exactly as the source writes it, one string per argument.');
      }
      // A quality command is taken verbatim from the source, never invented. [TAWI-REQ-010]
      evidence(command.evidence, `${where}.evidence`);
    });
    if (phase.approval !== 'none') {
      if (closed(phase.approval, 'approval', `${at}.approval`)) {
        if (phase.approval.mode !== 'required') add(`${at}.approval.mode`, 'TEAM_IMPORT_CANDIDATE_SHAPE', "approval is 'none' or { mode: required, authorities, minimum }.");
        list(phase.approval.authorities, `${at}.approval.authorities`, 5);
        if (!Number.isInteger(phase.approval.minimum) || phase.approval.minimum < 1) add(`${at}.approval.minimum`, 'TEAM_IMPORT_CANDIDATE_SHAPE', 'approval.minimum is at least 1.');
        if (Object.hasOwn(phase.approval, 'allowSelfApproval') && typeof phase.approval.allowSelfApproval !== 'boolean') {
          add(`${at}.approval.allowSelfApproval`, 'TEAM_IMPORT_CANDIDATE_SHAPE', 'approval.allowSelfApproval is true or false.');
        }
      }
    }
  });
  if (plain(workflow) && Object.hasOwn(workflow, 'sourceReview') && closed(workflow.sourceReview, 'sourceReview', '$.workflow.sourceReview')) {
    const review = workflow.sourceReview;
    if (typeof review.reviewerAgent !== 'string') add('$.workflow.sourceReview.reviewerAgent', 'TEAM_IMPORT_CANDIDATE_SHAPE', 'sourceReview.reviewerAgent names a carried agent.');
    for (const step of list(review.phases, '$.workflow.sourceReview.phases', LIMITS.phases)) {
      if (!phaseIds.has(step)) add('$.workflow.sourceReview.phases', 'TEAM_IMPORT_CANDIDATE_REFERENCE', `sourceReview names step '${step}', which the candidate does not declare.`);
      // Renaming the author does not make an independent reviewer. [TAWI-REQ-017]
      const author = candidate.phases.find((phase) => phase?.id === step)?.agent;
      if (author && author === review.reviewerAgent) {
        add('$.workflow.sourceReview.reviewerAgent', 'TEAM_IMPORT_REVIEWER_NOT_INDEPENDENT', `'${step}' is authored by '${author}', its own reviewer. Independent review needs a distinct reviewer agent, or the requirement stays unresolved.`, 'person');
      }
    }
  }
  const agentIds = new Set();
  list(candidate.agents, '$.agents', LIMITS.agents).forEach((agent, index) => {
    const at = `$.agents[${index}]`;
    if (!closed(agent, 'agent', at)) return;
    claim(agent.id, 'agent', `${at}.id`);
    agentIds.add(agent.id);
    text1(agent.label, `${at}.label`, 80);
    text1(agent.description, `${at}.description`, 600);
    text1(agent.body, `${at}.body`, LIMITS.body);
    if (Object.hasOwn(agent, 'tools') && (!Array.isArray(agent.tools) || agent.tools.some((tool) => typeof tool !== 'string' || !tool || tool.length > 80))) {
      add(`${at}.tools`, 'TEAM_IMPORT_CANDIDATE_SHAPE', 'tools lists tool names exactly as the source agent declares them.');
    }
  });
  const skillIds = new Set();
  list(candidate.skills, '$.skills', LIMITS.skills).forEach((skill, index) => {
    const at = `$.skills[${index}]`;
    if (!closed(skill, 'skill', at)) return;
    claim(skill.id, 'skill', `${at}.id`);
    skillIds.add(skill.id);
    text1(skill.description, `${at}.description`, 600);
    text1(skill.body, `${at}.body`, LIMITS.body);
    if (Object.hasOwn(skill, 'loading') && !['eager', 'on-demand'].includes(skill.loading)) add(`${at}.loading`, 'TEAM_IMPORT_CANDIDATE_SHAPE', 'loading is eager or on-demand.');
  });
  const instructionIds = new Set();
  list(candidate.instructions, '$.instructions', LIMITS.instructions).forEach((instruction, index) => {
    const at = `$.instructions[${index}]`;
    if (!closed(instruction, 'instruction', at)) return;
    claim(instruction.id, 'instruction', `${at}.id`);
    instructionIds.add(instruction.id);
    text1(instruction.description, `${at}.description`, 600);
    text1(instruction.body, `${at}.body`, 60_000);
  });
  const templateRefs = new Set();
  list(candidate.templates, '$.templates', LIMITS.templates).forEach((template, index) => {
    const at = `$.templates[${index}]`;
    if (!closed(template, 'template', at)) return;
    if (!TEMPLATE_REF.test(template.ref ?? '') || !template.ref.startsWith(`${namespace}/`)) add(`${at}.ref`, 'TEAM_IMPORT_CANDIDATE_TEMPLATE', `Template refs are '${namespace}/<name>.md'.`);
    if (templateRefs.has(String(template.ref).toLowerCase())) add(`${at}.ref`, 'TEAM_IMPORT_CANDIDATE_ID_COLLISION', `Template '${template.ref}' is declared twice.`);
    templateRefs.add(String(template.ref).toLowerCase());
    text1(template.body, `${at}.body`, 200_000);
  });
  list(candidate.attachments, '$.attachments', 200).forEach((attachment, index) => {
    const at = `$.attachments[${index}]`;
    if (!closed(attachment, 'attachment', at)) return;
    if (!skillIds.has(attachment.skill)) add(`${at}.skill`, 'TEAM_IMPORT_ATTACHMENT_UNRESOLVED', `${at} attaches skill '${attachment.skill}', which the candidate does not carry.`);
    const owners = ['agent', 'workflow'].filter((field) => Object.hasOwn(attachment, field));
    if (owners.length !== 1) add(at, 'TEAM_IMPORT_ATTACHMENT_UNRESOLVED', `${at} attaches to exactly one agent or the workflow.`);
    if (attachment.agent !== undefined && !agentIds.has(attachment.agent)) add(`${at}.agent`, 'TEAM_IMPORT_ATTACHMENT_UNRESOLVED', `${at} names agent '${attachment.agent}', which the candidate does not carry.`);
    if (attachment.workflow !== undefined && attachment.workflow !== workflow?.id) add(`${at}.workflow`, 'TEAM_IMPORT_ATTACHMENT_UNRESOLVED', `${at} names workflow '${attachment.workflow}'; a workflow-scoped skill attaches only to the imported workflow.`);
    for (const step of list(attachment.steps ?? [], `${at}.steps`, LIMITS.phases)) {
      if (!phaseIds.has(step)) add(`${at}.steps`, 'TEAM_IMPORT_ATTACHMENT_UNRESOLVED', `${at} restricts to step '${step}', which the candidate does not declare.`);
    }
    if (Object.hasOwn(attachment, 'use')) text1(attachment.use, `${at}.use`, 300);
  });
  const decisionIds = new Set();
  list(candidate.decisionsNeeded, '$.decisionsNeeded', 50).forEach((question, index) => {
    const at = `$.decisionsNeeded[${index}]`;
    if (!closed(question, 'decisionNeeded', at)) return;
    if (typeof question.id !== 'string' || !ID.test(question.id)) add(`${at}.id`, 'TEAM_IMPORT_CANDIDATE_ID', `${at}.id is a kebab-case ID.`);
    if (decisionIds.has(question.id)) add(`${at}.id`, 'TEAM_IMPORT_CANDIDATE_ID_COLLISION', `Question '${question.id}' is declared twice.`);
    decisionIds.add(question.id);
    text1(question.question, `${at}.question`, 400);
    const choices = list(question.choices, `${at}.choices`, 8);
    if (choices.length < 2 || choices.some((choice) => typeof choice !== 'string' || !choice.trim() || choice.length > 200)) {
      add(`${at}.choices`, 'TEAM_IMPORT_QUESTION_CHOICES', `${at} offers 2-8 concrete choices. [TAWI-REQ-032]`);
    }
    if (typeof question.blocking !== 'boolean') add(`${at}.blocking`, 'TEAM_IMPORT_CANDIDATE_SHAPE', 'blocking is true when the bundle cannot be ready without the answer.');
  });
  list(candidate.prerequisites, '$.prerequisites', 50).forEach((prerequisite, index) => {
    const at = `$.prerequisites[${index}]`;
    if (!closed(prerequisite, 'prerequisite', at)) return;
    if (typeof prerequisite.id !== 'string' || !ID.test(prerequisite.id)) add(`${at}.id`, 'TEAM_IMPORT_CANDIDATE_ID', `${at}.id is a kebab-case ID.`);
    if (!PREREQUISITE_KINDS.includes(prerequisite.kind)) add(`${at}.kind`, 'TEAM_IMPORT_CANDIDATE_SHAPE', `${at}.kind is one of ${PREREQUISITE_KINDS.join(', ')}.`);
    text1(prerequisite.description, `${at}.description`, 400);
    evidence(prerequisite.evidence, `${at}.evidence`, false);
  });
  list(candidate.mappings, '$.mappings', LIMITS.mappings).forEach((mapping, index) => {
    const at = `$.mappings[${index}]`;
    if (!closed(mapping, 'mapping', at)) return;
    text1(mapping.sourceItem, `${at}.sourceItem`, 200);
    if (!DISPOSITIONS.includes(mapping.disposition)) add(`${at}.disposition`, 'TEAM_IMPORT_CANDIDATE_SHAPE', `disposition is one of ${DISPOSITIONS.join(', ')}.`);
    if (!MAPPING_KINDS.includes(mapping.kind)) add(`${at}.kind`, 'TEAM_IMPORT_CANDIDATE_SHAPE', `kind is one of ${MAPPING_KINDS.join(', ')}.`);
    if (typeof mapping.target !== 'string' || !/^(?:workflow|phase|agent|skill|instruction|template|decision|authority|attachment|prerequisite):[a-z0-9/._-]+$|^none$/u.test(mapping.target)) {
      add(`${at}.target`, 'TEAM_IMPORT_CANDIDATE_SHAPE', "target is '<kind>:<id>' (workflow, phase, agent, skill, instruction, template, decision, authority, attachment, prerequisite) or 'none'.");
    }
    // Destination policy is SFlow's requirement, not the source's, so it cites no source evidence.
    evidence(mapping.evidence, `${at}.evidence`, mapping.kind !== 'destination-policy');
    if (mapping.disposition !== 'mapped' && (typeof mapping.reason !== 'string' || !mapping.reason.trim())) {
      add(`${at}.reason`, 'TEAM_IMPORT_MAPPING_REASON', `A ${mapping.disposition} mapping says why. [TAWI-REQ-011]`);
    }
    if (Object.hasOwn(mapping, 'material') && typeof mapping.material !== 'boolean') add(`${at}.material`, 'TEAM_IMPORT_CANDIDATE_SHAPE', 'material is true or false.');
    if (mapping.material === true && mapping.kind === 'inferred' && !decisionIds.has(mapping.decision)) {
      add(`${at}.decision`, 'TEAM_IMPORT_MATERIAL_INFERENCE', `${at} is a material inference; it names the decisionsNeeded question a person answers.`);
    }
  });
  return { findings, candidate };
}

/**
 * The candidate contract as data, returned by inspect so the model writes exactly what compile
 * checks (one source of truth instead of prose that drifts from the validator).
 */
export function candidateGuide() {
  return {
    kind: CANDIDATE_KIND,
    schemaVersion: 1,
    fields: FIELDS,
    optional: OPTIONAL,
    values: {
      disposition: DISPOSITIONS, mappingKind: MAPPING_KINDS, prerequisiteKind: PREREQUISITE_KINDS,
      writeScope: ['artifact-only', 'source-and-artifact'], approval: ["'none'", '{ mode: required, authorities, minimum, allowSelfApproval? }'],
      decisionKind: ['branch', 'loop', 'ask'], mappingTarget: '<workflow|phase|agent|skill|instruction|template|decision|authority|attachment|prerequisite>:<id> or none'
    },
    // Responsibilities come from structure (src/evidence/responsibilities.mjs): every route needs
    // scope, plan, implement, verify and review, or a workflow omits entry for what the source lacks.
    responsibilityArtifactKinds: { scope: ['requirements', 'implementation-spec'], plan: ['implementation-spec', 'delivery-plan', 'implementation-plan'], verify: ['test-evidence'] },
    rules: [
      'Every ID starts with "<namespace>-"; templates are "<namespace>/<name>.md".',
      'workflow.phases lists every phase once, in order; inputs name earlier phases only.',
      'Only a code phase (code: true) writes source (source-and-artifact); it needs qualityCommands taken verbatim from evidence, or a quality-command prerequisite.',
      'A code phase needs an earlier phase whose artifact kind defines requirement clauses (requirements or implementation-spec).',
      'Decisions use workflow.yml decision fields; a loop has goal, back, maxRounds 1-20 and by; going back needs approval mode required on the deciding phase.',
      'Running out of rounds always pauses for the by group; a source that escalates or skips instead maps as unsupported.',
      'Independent review is workflow.sourceReview with a reviewer agent distinct from the author; otherwise unresolved.',
      'Place each instruction in a skill body with <instruction>id</instruction>; every skill is attached; every agent defaults for a phase or reviews.',
      'Every interpreted source file has a mapping; evidence spans cite capture paths, their sha256 and line numbers.',
      'What SFlow requires but the source never said is kind destination-policy; a material inference names the decisionsNeeded question a person answers.',
      'Never write hashes, approvals, validation results or answers: compile computes them, and answers are recorded with --answer.'
    ]
  };
}
