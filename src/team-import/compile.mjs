/**
 * `workflow import-team compile`: check a candidate deterministically, build the bundle with the
 * one shared compiler, preview its import, and write it only when asked. [TAWI §8-§11]
 *
 * Deterministic checks decide the state; the model's own review never does:
 * - the candidate record is closed and every evidence span lies inside the capture;
 * - every reference resolves: phases to agents and templates, attachments to skills, steps and
 *   owners, instructions to the skill text that places them; no ID collides with the baseline;
 * - every interpreted source file has a mapping, and every unresolved reference is acknowledged;
 * - the staged configuration passes the engine's loader and validators, the routes simulate (pass,
 *   repair, exhaustion, unavailable evidence, rejection), and the bundle compiles and validates;
 * - the bundle imports cleanly into a fresh configuration, and into `--destination` when given.
 *
 * States: invalid > unsupported > needs-decision > portable-ready | ready-for-destination.
 * "Ready" never means approved, activated, executed, tested or reviewed.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { loadDefinition, resolveWorkType } from '../config.mjs';
import { simulateWorkflowRoutes } from '../workflow-route-simulation.mjs';
import { SingularityFlowError } from '../util.mjs';
import { captureTeamDirectory } from './capture.mjs';
import { validateCandidate } from './candidate.mjs';
import { readTeamImportSession, updateTeamImportSession } from './session.mjs';
import { stageCandidate } from './stage.mjs';

export const TEAM_IMPORT_REPAIR_LIMIT = 3;
const PLACED_INSTRUCTION = /<instruction>\s*([a-z0-9-]+)\s*<\/instruction>|<!--\s*sflow-instruction:\s*([a-z0-9-]+)\s*-->/gu;

function fail(code, message, details = undefined) {
  throw new SingularityFlowError(message, { code, details });
}

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

/** `id=choice` answers, each to a question the candidate asks, with one of its choices. */
export function parseAnswers(values) {
  return values.map((value) => {
    const at = String(value).indexOf('=');
    if (at < 1) fail('TEAM_IMPORT_ANSWER_INVALID', `--answer '${value}' must be <question-id>=<choice>.`);
    return { id: value.slice(0, at).trim(), choice: value.slice(at + 1).trim() };
  });
}

/** References between candidate sections, unused carried items, and collisions with the baseline. */
function crossReferences(candidate, baseline) {
  const findings = [];
  const add = (at, code, message, owner = 'model') => findings.push({ at, code, message, owner });
  const ids = (list) => new Set(list.map((entry) => entry.id));
  const phases = ids(candidate.phases);
  const agents = ids(candidate.agents);
  const skills = ids(candidate.skills);
  const authorities = new Set([...candidate.authorities.map((entry) => entry.id), ...baseline.authority]);
  const templates = new Set(candidate.templates.map((entry) => entry.ref));
  const order = candidate.workflow.phases;
  if (order.length !== new Set(order).size || order.length !== phases.size || order.some((id) => !phases.has(id))) {
    add('$.workflow.phases', 'TEAM_IMPORT_WORKFLOW_PHASES', 'workflow.phases lists every declared phase exactly once, in order.');
  }
  for (const [index, phase] of candidate.phases.entries()) {
    const at = `$.phases[${index}]`;
    if (!agents.has(phase.agent)) add(`${at}.agent`, 'TEAM_IMPORT_REFERENCE', `Phase '${phase.id}' names agent '${phase.agent}', which the candidate does not carry.`);
    if (!templates.has(phase.template)) add(`${at}.template`, 'TEAM_IMPORT_REFERENCE', `Phase '${phase.id}' names template '${phase.template}', which the candidate does not carry.`);
    const position = order.indexOf(phase.id);
    for (const input of phase.inputs ?? []) {
      const source = typeof input === 'string' ? input : input?.phase;
      if (!phases.has(source) || order.indexOf(source) >= position) add(`${at}.inputs`, 'TEAM_IMPORT_REFERENCE', `Phase '${phase.id}' reads '${source}', which is not an earlier phase of this workflow.`);
    }
    if (phase.approval !== 'none') {
      for (const group of phase.approval?.authorities ?? []) {
        if (!authorities.has(group)) add(`${at}.approval.authorities`, 'TEAM_IMPORT_AUTHORITY_UNKNOWN', `Phase '${phase.id}' is approved by '${group}', which is neither a candidate authority nor a baseline one. Who approves is the destination's call: declare a prerequisite and ask.`, 'person');
      }
    }
    if (phase.code === true && !phase.qualityCommands?.length && !candidate.prerequisites.some((entry) => entry.kind === 'quality-command')) {
      add(`${at}.qualityCommands`, 'TEAM_IMPORT_QUALITY_COMMAND_MISSING', `Code phase '${phase.id}' has no quality command from the source. Declare a quality-command prerequisite; never invent argv. [TAWI-REQ-010]`, 'person');
    }
  }
  const review = candidate.workflow.sourceReview;
  if (review && !agents.has(review.reviewerAgent)) add('$.workflow.sourceReview.reviewerAgent', 'TEAM_IMPORT_REFERENCE', `sourceReview names agent '${review.reviewerAgent}', which the candidate does not carry.`);
  if (review) {
    const authored = candidate.phases.filter((phase) => phase.agent === review.reviewerAgent).map((phase) => phase.id);
    if (authored.length) {
      add('$.workflow.sourceReview.reviewerAgent', 'TEAM_IMPORT_REVIEWER_AUTHORS', `'${review.reviewerAgent}' authors ${authored.join(', ')}, but a source reviewer is review-only. Use a separate reviewer agent for sourceReview, or drop sourceReview and keep the review as its own phase.`);
    }
    const reviewable = new Set(['requirements', 'implementation-spec', 'implementation-plan', 'delivery-plan']);
    for (const step of review.phases) {
      const kind = candidate.phases.find((phase) => phase.id === step)?.artifact?.kind;
      if (kind && !reviewable.has(kind)) add('$.workflow.sourceReview.phases', 'TEAM_IMPORT_SOURCE_REVIEW_SCOPE', `sourceReview covers only steps that define requirements or plan claims (artifact kinds ${[...reviewable].join(', ')}); '${step}' produces '${kind}'.`);
    }
  }
  for (const [index, agent] of candidate.agents.entries()) {
    if (!candidate.phases.some((phase) => phase.agent === agent.id) && review?.reviewerAgent !== agent.id) {
      add(`$.agents[${index}]`, 'TEAM_IMPORT_UNUSED', `Agent '${agent.id}' is the default for no phase and reviews nothing, so the bundle would drop it. Remove it, or map its source as excluded.`);
    }
  }
  const attached = new Set(candidate.attachments.map((entry) => entry.skill));
  for (const [index, skill] of candidate.skills.entries()) {
    if (!attached.has(skill.id)) add(`$.skills[${index}]`, 'TEAM_IMPORT_UNUSED', `Skill '${skill.id}' is attached to no agent or workflow, so the bundle would drop it.`);
  }
  const placed = new Set(candidate.skills.flatMap((skill) => [...skill.body.matchAll(PLACED_INSTRUCTION)].map((match) => match[1] ?? match[2])));
  for (const [index, instruction] of candidate.instructions.entries()) {
    if (!placed.has(instruction.id)) {
      add(`$.instructions[${index}]`, 'TEAM_IMPORT_INSTRUCTION_UNPLACED', `Instruction '${instruction.id}' is placed in no skill. Place it with <instruction>${instruction.id}</instruction> at its point of use; an instruction an agent referenced directly goes in an agent-scoped guidance skill. [TAWI-REQ-013, -014]`);
    }
  }
  for (const [index, template] of candidate.templates.entries()) {
    if (!candidate.phases.some((phase) => phase.template === template.ref)) add(`$.templates[${index}]`, 'TEAM_IMPORT_UNUSED', `Template '${template.ref}' is used by no phase.`);
  }
  for (const [kind, list] of [['workflow', [candidate.workflow]], ['phase', candidate.phases], ['agent', candidate.agents],
    ['skill', candidate.skills], ['instruction', candidate.instructions], ['authority', candidate.authorities]]) {
    const taken = new Set((baseline[kind] ?? []).map((id) => id.toLowerCase()));
    for (const entry of list) {
      if (taken.has(String(entry.id).toLowerCase())) add(`${kind}:${entry.id}`, 'TEAM_IMPORT_ID_COLLISION', `${kind} '${entry.id}' already exists in every SFlow configuration; choose another namespace. [TAWI-REQ-016]`);
    }
  }
  return findings;
}

/**
 * Coverage: every interpreted file the interpretation used has a mapping, and every reference that
 * did not resolve is acknowledged with a disposition. [TAWI-REQ-011, -024, -025]
 */
function coverage(candidate, session) {
  const findings = [];
  const mapped = new Map();
  for (const mapping of candidate.mappings) {
    for (const key of [mapping.sourceItem, ...mapping.evidence.map((span) => span.path)]) {
      if (!mapped.has(key)) mapped.set(key, []);
      mapped.get(key).push(mapping);
    }
  }
  const closure = new Set(session.closure.map((entry) => entry.path));
  const items = session.capture.files.filter((file) => closure.has(file.path) && file.format);
  for (const item of items) {
    if (!mapped.has(item.path) && !mapped.has(item.id)) {
      findings.push({ at: `capture:${item.path}`, code: 'TEAM_IMPORT_COVERAGE_MISSING', owner: 'model',
        message: `Source '${item.path}' (${item.format}) has no mapping. Map what it contributes, or map it as excluded with a reason.` });
    }
  }
  const unresolved = session.capture.references.filter((reference) => closure.has(reference.from) && reference.status !== 'resolved');
  const acknowledgements = [];
  for (const reference of unresolved) {
    const keys = [reference.written, reference.target].filter(Boolean);
    const acknowledged = keys.flatMap((key) => mapped.get(key) ?? []).find((mapping) => mapping.disposition !== 'mapped');
    if (!acknowledged) {
      findings.push({ at: `reference:${reference.from}:${reference.line}`, code: 'TEAM_IMPORT_REFERENCE_UNRESOLVED', owner: 'person',
        message: `'${reference.from}' line ${reference.line} refers to '${reference.written}', which is ${reference.status}${reference.reason ? ` (${reference.reason})` : ''}. Acknowledge it with a mapping whose sourceItem is '${reference.written}' (excluded, unsupported or unresolved), or ask who can supply it.` });
    } else acknowledgements.push({ reference: reference.written, disposition: acknowledged.disposition });
  }
  return { findings, items: items.length, acknowledgements };
}

/** Refuse writing into a repository's governed configuration, or over a source file. [TAWI-REQ-023] */
async function assertOutputLocation(target, session) {
  for (const root of session.capture.roots) {
    if ((target + path.sep).startsWith(root.path + path.sep)) fail('TEAM_IMPORT_OUTPUT_UNSAFE', `Write the bundle outside the team directory (${root.path}); conversion never changes its source.`);
  }
  for (let directory = path.dirname(target); ; directory = path.dirname(directory)) {
    if (await lstat(path.join(directory, '.git')).catch(() => null)) {
      const relative = path.relative(directory, target).split(path.sep);
      if (['singularity', '.github', 'sflow'].includes(relative[0])) {
        fail('TEAM_IMPORT_OUTPUT_UNSAFE', `Do not write the bundle into ${relative[0]}/ of ${directory}: configuration changes only through workflow import and its review.`);
      }
      break;
    }
    if (path.dirname(directory) === directory) break;
  }
  if (!target.endsWith('.json')) fail('TEAM_IMPORT_OUTPUT_UNSAFE', 'The bundle file name ends in .json (for example <workflow>.sflow-workflows.json), so Workflow Studio can import it.');
}

function stateOf({ findings, candidate, answers, simulation, bundle, fresh, destination }) {
  const blocking = findings.filter((finding) => finding.severity !== 'warning');
  if (blocking.some((finding) => finding.owner === 'model') || !candidate || !bundle || simulation?.status === 'failed'
      || fresh?.status === 'failed') return 'invalid';
  if (candidate.mappings.some((mapping) => mapping.disposition === 'unsupported')) return 'unsupported';
  const answered = new Set(answers.map((answer) => answer.id));
  const openQuestions = candidate.decisionsNeeded.filter((question) => question.blocking && !answered.has(question.id));
  const openMaterial = candidate.mappings.filter((mapping) => mapping.material === true && mapping.kind === 'inferred' && !answered.has(mapping.decision));
  if (blocking.length || openQuestions.length || openMaterial.length
      || candidate.mappings.some((mapping) => mapping.disposition === 'unresolved')) return 'needs-decision';
  if (destination) return destination.status === 'ready' ? 'ready-for-destination' : 'needs-decision';
  return 'portable-ready';
}

/** Compile the session's candidate. See the module comment for what is checked and in which order. */
export async function compileTeamImport(sessionId, {
  out = null, destination = null, dryRun = false, answers: given = [], allowNotReady = false, env = process.env, cwd = process.cwd()
} = {}) {
  let session = await readTeamImportSession(sessionId, { env });
  const findings = [];
  // The source must still be the one interpreted: a re-capture compares the whole manifest.
  try {
    const [first, ...rest] = session.capture.roots.map((root) => root.path);
    const { capture } = await captureTeamDirectory(first, { roots: rest, bounds: session.capture.bounds });
    if (capture.sha256 !== session.capture.sha256) {
      const before = new Map(session.capture.files.map((file) => [file.path, file.sha256 ?? file.screening]));
      const after = new Map(capture.files.map((file) => [file.path, file.sha256 ?? file.screening]));
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key)).sort();
      findings.push({ at: 'source', code: 'TEAM_IMPORT_SOURCE_CHANGED', owner: 'model',
        message: `The team directory changed after inspect (${changed.slice(0, 8).join(', ') || 'listing'}${changed.length > 8 ? ', …' : ''}). Run inspect again and interpret the new capture.` });
    }
  } catch (error) {
    findings.push({ at: 'source', code: error.code ?? 'TEAM_IMPORT_SOURCE_MISSING', owner: 'model', message: `The team directory can no longer be captured: ${error.message}` });
  }
  let text;
  try { text = await readFile(session.candidatePath, 'utf8'); }
  catch {
    fail('TEAM_IMPORT_CANDIDATE_MISSING', `No candidate yet: write it to ${session.candidatePath} (the path inspect issued), then compile again.`,
      { candidatePath: session.candidatePath });
  }
  const { findings: candidateFindings, candidate } = validateCandidate(text, { session });
  findings.push(...candidateFindings);
  const answers = [...(session.answers ?? [])];
  for (const answer of parseAnswers(given)) {
    const question = candidate?.decisionsNeeded?.find((entry) => entry.id === answer.id);
    if (!question) fail('TEAM_IMPORT_ANSWER_INVALID', `--answer names '${answer.id}', which the candidate does not ask.`);
    const choice = question.choices.find((entry) => entry.toLowerCase() === answer.choice.toLowerCase());
    if (!choice) fail('TEAM_IMPORT_ANSWER_INVALID', `'${answer.choice}' is not one of ${question.choices.map((entry) => `'${entry}'`).join(', ')} for '${answer.id}'.`);
    const recorded = { id: answer.id, question: question.question, choice, at: new Date().toISOString() };
    const index = answers.findIndex((entry) => entry.id === answer.id);
    if (index >= 0) answers[index] = recorded; else answers.push(recorded);
  }
  let simulation = null;
  let bundle = null;
  let fresh = null;
  let destinationPlan = null;
  let coverageSummary = null;
  const candidateValid = candidate && !candidateFindings.length;
  if (candidateValid) {
    const staging = path.join(path.dirname(session.candidatePath), 'stage');
    const { baseline } = await stageCandidate(staging, candidate);
    findings.push(...crossReferences(candidate, baseline));
    const covered = coverage(candidate, session);
    findings.push(...covered.findings);
    coverageSummary = { items: covered.items, acknowledged: covered.acknowledgements.length };
    let definition = null;
    try { definition = await loadDefinition(staging); }
    catch (error) {
      findings.push({ at: 'configuration', code: error.code ?? 'TEAM_IMPORT_CONFIGURATION_INVALID', owner: 'model',
        message: `The staged configuration does not load: ${error.message}` });
    }
    if (definition) {
      try {
        const resolved = resolveWorkType(definition, candidate.workflow.id);
        // What every route guarantees: Story start refuses a workflow whose route drops scope, plan,
        // implementation, verification or review without a declared omission, or whose code steps
        // have no planned-claim contract. The loader keeps such a workflow readable, so check here.
        for (const finding of resolved.obligationGraph?.findings ?? []) {
          findings.push({ at: `responsibility:${finding.subject?.phase ?? 'workflow'}`, code: finding.code, owner: 'model',
            severity: finding.severity === 'error' ? undefined : 'warning', message: `${finding.message} ${finding.resolvingAction ?? ''}`.trim(),
            missing: finding.subject?.missing ?? [] });
        }
        if (resolved.plannedClaims?.mode === 'migration-required' || resolved.plannedClaims?.mode === 'retired-opt-out') {
          findings.push({ at: 'plannedClaims', code: 'TEAM_IMPORT_PLANNED_CLAIMS', owner: 'model',
            message: `Story start would refuse this workflow: ${String(resolved.plannedClaims.reason ?? resolved.plannedClaims.mode).replace(/\.+$/u, '')}. A code step needs an earlier step that defines requirement clauses (artifact kind requirements or implementation-spec) and plans them.` });
        }
        simulation = simulateWorkflowRoutes(resolved, { approvalAuthorities: definition.approvalAuthorities });
        for (const finding of simulation.findings) findings.push({ at: `route:${finding.decision ?? finding.phase ?? 'workflow'}`, code: finding.code, owner: 'model', message: finding.message, severity: finding.severity });
      } catch (error) {
        findings.push({ at: 'routes', code: error.code ?? 'TEAM_IMPORT_ROUTES_INVALID', owner: 'model', message: error.message });
      }
      try {
        const { compileWorkflowBundle, importResolutionOptions, planWorkflowImport } = await import('../workflow-transfer.mjs');
        bundle = await compileWorkflowBundle(staging, [candidate.workflow.id]);
        // Proof it imports: into a fresh configuration (every destination's baseline), and into
        // the named destination with the same planner Workflow Studio uses. Nothing is applied.
        const freshRoot = path.join(path.dirname(session.candidatePath), 'fresh');
        await rm(freshRoot, { recursive: true, force: true });
        await mkdir(freshRoot, { recursive: true, mode: 0o700 });
        const { initializeDefinition } = await import('../config.mjs');
        await initializeDefinition(freshRoot);
        const freshPlan = await planWorkflowImport(freshRoot, bundle, importResolutionOptions([], 'suggested'));
        fresh = { status: freshPlan.status === 'ready' ? 'passed' : 'failed', counts: freshPlan.counts, conflicts: freshPlan.conflicts };
        if (fresh.status === 'failed') findings.push({ at: 'import', code: 'TEAM_IMPORT_FRESH_IMPORT_BLOCKED', owner: 'model', message: `The bundle does not import into a fresh configuration: ${freshPlan.conflicts.map((entry) => entry.reason).join('; ')}` });
      } catch (error) {
        findings.push({ at: 'bundle', code: error.code ?? 'TEAM_IMPORT_BUNDLE_INVALID', owner: 'model', message: error.message });
      }
      if (bundle && destination) {
        // The destination is the person's repository: a preview it cannot give is theirs to fix,
        // never a defect of the candidate.
        const root = path.resolve(cwd, destination);
        try {
          const { importResolutionOptions, planWorkflowImport } = await import('../workflow-transfer.mjs');
          const { withApprovedConfigurationRead } = await import('../approved-configuration-reader.mjs');
          const plan = await withApprovedConfigurationRead(root, () => planWorkflowImport(root, bundle, importResolutionOptions([], 'suggested')), { preferAuthority: true });
          destinationPlan = { root, status: plan.status, planSha256: plan.planSha256, bundleSha256: plan.bundleSha256,
            counts: plan.counts, conflicts: plan.conflicts, renamed: plan.renamed ?? [] };
          if (plan.status !== 'ready') {
            findings.push({ at: 'destination', code: 'TEAM_IMPORT_DESTINATION_CONFLICT', owner: 'person',
              message: `Importing into ${root} needs choices: ${plan.conflicts.map((entry) => `${entry.kind} ${entry.id}: ${entry.reason}`).join('; ')}.` });
          }
        } catch (error) {
          destinationPlan = { root, status: 'unavailable', error: { code: error.code ?? null, message: error.message } };
          findings.push({ at: 'destination', code: 'TEAM_IMPORT_DESTINATION_UNAVAILABLE', owner: 'person',
            message: `The import into ${root} could not be previewed: ${error.message}` });
        }
      }
    }
  }
  const state = stateOf({ findings, candidate: candidateValid ? candidate : null, answers, simulation, bundle, fresh, destination: destinationPlan });
  // Bounded repair: a candidate whose findings did not change is not repaired again. [TAWI-REQ-031]
  const fingerprint = digest(JSON.stringify(findings.map((finding) => [finding.code, finding.at])));
  const previous = session.compiles.at(-1) ?? null;
  const notReady = !['portable-ready', 'ready-for-destination'].includes(state);
  // A person's answers are new information, so they start a fresh repair budget.
  const continuing = previous && !['portable-ready', 'ready-for-destination'].includes(previous.state) && !given.length;
  const attempt = notReady ? (continuing ? (previous.repairAttempt ?? 0) + 1 : 1) : 0;
  const unchanged = notReady && previous?.findingsSha256 === fingerprint;
  let written = null;
  if (out && !dryRun) {
    if (!bundle) fail('TEAM_IMPORT_NOT_COMPILED', 'There is no valid bundle to write; resolve the findings first.', { state, findings });
    if (notReady && !allowNotReady) {
      fail('TEAM_IMPORT_NOT_READY', `The conversion is ${state}; a bundle is written only when it is ready. Resolve the findings and questions, or pass --allow-not-ready to keep a file that is labelled not ready.`, { state });
    }
    const { readWorkflowBundle, writeWorkflowBundle } = await import('../workflow-transfer.mjs');
    const target = path.resolve(cwd, out);
    await assertOutputLocation(target, session);
    await writeWorkflowBundle(bundle, target);
    const reread = await readWorkflowBundle(target);
    if (reread.bundleSha256 !== bundle.bundleSha256) fail('TEAM_IMPORT_OUTPUT_UNVERIFIED', `${target} does not read back as the compiled bundle.`);
    written = { path: target, bundleSha256: bundle.bundleSha256, ready: !notReady };
  }
  session = await updateTeamImportSession({
    ...session, answers,
    compiles: [...session.compiles, {
      at: new Date().toISOString(), candidateSha256: digest(text), state, findingsSha256: fingerprint,
      repairAttempt: attempt, bundleSha256: bundle?.bundleSha256 ?? null, out: written?.path ?? null,
      destination: destinationPlan ? { root: destinationPlan.root, planSha256: destinationPlan.planSha256, status: destinationPlan.status } : null
    }].slice(-20)
  }, { env });
  const answered = new Set(answers.map((answer) => answer.id));
  return {
    schemaVersion: 1,
    resultType: 'team-import-compile',
    session: { id: session.id, expiresAt: session.expiresAt, candidatePath: session.candidatePath },
    state,
    bundleSha256: bundle?.bundleSha256 ?? null,
    workflow: candidateValid ? {
      id: candidate.workflow.id, label: candidate.workflow.label,
      phases: candidate.workflow.phases.map((id) => {
        const phase = candidate.phases.find((entry) => entry.id === id);
        return { id, label: phase?.label, agent: phase?.agent, code: phase?.code === true, approval: phase?.approval === 'none' ? 'none' : phase?.approval?.authorities ?? [] };
      }),
      decisions: (candidate.workflow.decisions ?? []).map((decision) => ({ id: decision.id, kind: decision.kind, after: decision.after }))
    } : null,
    counts: candidateValid ? { agents: candidate.agents.length, skills: candidate.skills.length, instructions: candidate.instructions.length,
      templates: candidate.templates.length, mappings: candidate.mappings.length } : null,
    dispositions: candidateValid ? candidate.mappings.filter((mapping) => mapping.disposition !== 'mapped')
      .map((mapping) => ({ sourceItem: mapping.sourceItem, disposition: mapping.disposition, kind: mapping.kind, reason: mapping.reason ?? null })) : [],
    destinationPolicy: candidateValid ? candidate.mappings.filter((mapping) => mapping.kind === 'destination-policy')
      .map((mapping) => ({ sourceItem: mapping.sourceItem, target: mapping.target, reason: mapping.reason ?? null })) : [],
    prerequisites: candidateValid ? candidate.prerequisites.map(({ id, kind, description }) => ({ id, kind, description })) : [],
    questions: candidateValid ? candidate.decisionsNeeded.filter((question) => !answered.has(question.id)) : [],
    answers,
    coverage: coverageSummary,
    findings,
    routeSimulation: simulation ? { status: simulation.status, counts: simulation.counts, coverage: simulation.coverage, findings: simulation.findings } : { status: 'not-run' },
    freshImport: fresh,
    destination: destinationPlan,
    repair: { attempt, limit: TEAM_IMPORT_REPAIR_LIMIT, unchanged, stop: notReady && (unchanged || attempt >= TEAM_IMPORT_REPAIR_LIMIT) },
    output: written,
    meaning: 'Ready means the bundle passed every deterministic check. It is not approved, activated, executed, tested or reviewed.'
  };
}
