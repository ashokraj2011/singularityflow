import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { authoringSkillCatalog, parseAuthoringSkills } from '../src/authoring-skills.mjs';
import { authoringRoute, deterministicOnlyGeneration, generationSkillForPhase, legacyAuthoringSkill, stepOutputKind } from '../src/code-delivery-policy.mjs';
import { phaseAuthoringSummary } from '../src/cli.mjs';
import { attachContinuation } from '../src/narration/continuation.mjs';
import { plannedAction } from '../src/narration/command-result.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { loadDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { pinnedResolutionVerification } from '../src/state.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { authoringSkillContractErrors } from '../scripts/skill-policy.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const starter = () => YAML.parse(readFileSync(path.join(packageRoot, 'templates', 'workflow.yml'), 'utf8'));

function refusal(mutate) {
  const definition = starter();
  mutate(definition);
  try {
    validateDefinition(definition);
  } catch (error) {
    return error;
  }
  return null;
}

test('the authoring-skill catalog is declared once, checked strictly, and names only packaged skills', async () => {
  const catalog = authoringSkillCatalog();
  assert.deepEqual(catalog.map((entry) => entry.id), ['sf-phase', 'sf-code', 'sf-requirements', 'sf-design', 'sf-release']);
  assert.deepEqual(catalog.find((entry) => entry.id === 'sf-design').legacyPhases, ['design']);
  assert.deepEqual(catalog.find((entry) => entry.id === 'sf-release').produces, ['document']);
  assert.deepEqual(catalog.find((entry) => entry.id === 'sf-code').produces, ['code']);
  const registered = new Set(Object.keys(YAML.parse(await readFile(path.join(packageRoot, 'plugin', 'skills', 'registry.yml'), 'utf8')).skills));
  for (const entry of catalog) assert.ok(registered.has(entry.sourceId), `${entry.sourceId} is a registered skill`);
  const declaration = { 'sflow-design': { produces: ['document'], legacyPhases: ['design'] } };
  assert.deepEqual(parseAuthoringSkills(declaration, { registeredSkills: new Set(['sflow-design']) }),
    [{ id: 'sf-design', sourceId: 'sflow-design', produces: ['document'], legacyPhases: ['design'] }]);
  for (const [section, message] of [
    [{ 'sflow-design': { produces: ['document'], extra: true } }, /unknown field 'extra'/],
    [{ 'sflow-design': { produces: ['none'] } }, /produces must list distinct values/],
    [{ 'sflow-ghost': { produces: ['document'] } }, /not a registered skill/],
    [{ 'sf-design': { produces: ['document'] } }, /packaged sflow-\* skill/]
  ]) assert.throws(() => parseAuthoringSkills(section, { registeredSkills: new Set(['sflow-design']) }), message);
});

test('one engine classification decides what a step produces, whatever its write scope', () => {
  const definition = validateDefinition(starter());
  const step = (workType, id) => resolveWorkType(definition, workType).phases.find((phase) => phase.id === id);
  assert.equal(stepOutputKind(step('feature', 'implementation')), 'code');
  assert.equal(stepOutputKind(step('feature', 'design')), 'document');
  // Write scope never implies code: these steps write against source without delivering it.
  assert.equal(step('feature', 'verification').writeScope, 'source-and-artifact');
  assert.equal(stepOutputKind(step('feature', 'verification')), 'document');
  assert.equal(stepOutputKind(step('chore', 'implementation')), 'analysis');
  assert.equal(stepOutputKind({ id: 'sign', generation: { requirement: 'none' } }), 'none');
  assert.equal(stepOutputKind({ id: 'sign', generation: 'none' }), 'none');
});

test('routing follows deterministic convergence, then the configured skill, then code, then /sf-phase', () => {
  const document = { id: 'vendor-analysis', generation: { task: 'analyze' }, authoringSkill: 'sf-phase' };
  assert.deepEqual(authoringRoute(document), { authoringSkill: 'sf-phase', effectiveAuthoringSkill: '/sf-phase', authoringSkillSource: 'configured' });
  assert.equal(generationSkillForPhase(document), '/sflow-phase');
  const code = { id: 'build-api', generation: { task: 'code' } };
  assert.deepEqual(authoringRoute(code), { authoringSkill: null, effectiveAuthoringSkill: '/sf-code', authoringSkillSource: 'automatic' });
  assert.deepEqual(authoringRoute({ id: 'sign', generation: { requirement: 'none' } }).authoringSkillSource, 'none');
  const convergence = { id: 'convergence', generationPolicy: { requirement: 'required', defaultProducer: 'deterministic', allowedProducers: ['deterministic'] } };
  assert.deepEqual(authoringRoute(convergence), { authoringSkill: null, effectiveAuthoringSkill: '/sf-converge', authoringSkillSource: 'fixed' });
  assert.equal(generationSkillForPhase(convergence), '/sflow-converge');

  // A pinned value this build does not list, or one that cannot draft the step, falls back.
  const unlisted = authoringRoute({ id: 'vendor-analysis', authoringSkill: 'sf-jira-board' });
  assert.equal(unlisted.effectiveAuthoringSkill, '/sf-phase');
  assert.equal(unlisted.authoringSkillSource, 'automatic');
  assert.match(unlisted.authoringSkillWarning, /does not list/);
  const mismatch = authoringRoute({ id: 'build-api', generation: { task: 'code' }, authoringSkill: 'sf-phase' });
  assert.equal(mismatch.effectiveAuthoringSkill, '/sf-code');
  assert.match(mismatch.authoringSkillWarning, /cannot draft a code step/);
});

test('steps only the engine generates are fixed, and compiled skill steps ignore a pinned skill', () => {
  const definition = validateDefinition(starter());
  const resolved = (workType, id) => resolveWorkType(definition, workType).phases.find((phase) => phase.id === id);
  // Configuration-shaped and raw convergence route as a Story's does, without throwing.
  assert.equal(generationSkillForPhase(resolved('spec-driven-standard', 'convergence')), '/sflow-converge');
  assert.equal(authoringRoute({ id: 'convergence', generation: { requirement: 'required', producer: 'deterministic', task: 'analyze' } }).effectiveAuthoringSkill, '/sf-converge');
  // Any other step only the deterministic generator produces keeps its automatic route and is fixed.
  for (const [workType, id, route] of [['poc-lite', 'poc-lite-plan', '/sf-phase'], ['poc-lite', 'poc-lite-act', '/sf-code'], ['quick-fix', 'verify', '/sf-phase']]) {
    assert.ok(deterministicOnlyGeneration(resolved(workType, id)), `${workType}/${id} is generated by the engine`);
    assert.deepEqual(authoringRoute(resolved(workType, id)), { authoringSkill: null, effectiveAuthoringSkill: route, authoringSkillSource: 'fixed' });
  }
  // A value pinned by an older build is ignored, with a warning, rather than routed.
  const pinned = authoringRoute({ ...resolved('poc-lite', 'poc-lite-plan'), authoringSkill: 'sf-design' });
  assert.equal(pinned.effectiveAuthoringSkill, '/sf-phase');
  assert.match(pinned.authoringSkillWarning, /only the deterministic generator produces it/);
  const compiled = authoringRoute({ id: 'skill-step', kind: 'skill', generation: { task: 'analyze' }, authoringSkill: 'sf-design' });
  assert.equal(compiled.effectiveAuthoringSkill, '/sf-phase');
  assert.equal(compiled.authoringSkillSource, 'automatic');
  assert.match(compiled.authoringSkillWarning, /compiled skill binding/);
  const signOff = authoringRoute({ id: 'sign', generation: { requirement: 'none' }, authoringSkill: 'sf-design' });
  assert.deepEqual([signOff.effectiveAuthoringSkill, signOff.authoringSkillSource], [null, 'none']);
  assert.match(signOff.authoringSkillWarning, /drafts nothing/);
});

test('in a Story the configured skill comes from the pinned resolution, never the mutable step state', () => {
  const workflow = {
    resolution: { phases: [{ id: 'vendor-analysis', authoringSkill: 'sf-phase' }, { id: 'design' }] },
    phases: {}
  };
  // Step state carries no setting; a hand-edited one is ignored once the Story is known.
  const state = { id: 'design', generationPolicy: { requirement: 'required' }, authoringSkill: 'sf-jira-board' };
  assert.deepEqual(authoringRoute(state, workflow), { authoringSkill: null, effectiveAuthoringSkill: '/sf-phase', authoringSkillSource: 'automatic' });
  assert.equal(authoringRoute({ id: 'vendor-analysis', generationPolicy: { requirement: 'required' } }, workflow).authoringSkillSource, 'configured');
});

test('configuration refuses an authoring skill the step cannot use, with a code for each reason', () => {
  assert.equal(refusal(() => {}), null, 'the packaged workflows are valid without the setting');
  assert.equal(refusal((definition) => { definition.phases.design.authoringSkill = 'sf-phase'; }), null);
  // A specialised skill on a document step, and a release skill on a step that writes a document.
  assert.equal(refusal((definition) => { definition.phases.intake.authoringSkill = 'sf-design'; }), null);
  assert.equal(refusal((definition) => { definition.phases.requirements.authoringSkill = 'sf-release'; }), null);
  const cases = [
    [(definition) => { definition.phases.design.authoringSkill = '/sf-phase'; }, 'PHASE_AUTHORING_SKILL_UNKNOWN', /Write it as 'sf-phase'/],
    [(definition) => { definition.phases.design.authoringSkill = 'sf-jira-board'; }, 'PHASE_AUTHORING_SKILL_UNKNOWN', /Choose one of: sf-phase, sf-code, sf-requirements, sf-design, sf-release\./],
    [(definition) => { definition.phases.design.authoringSkill = 'sf-code'; }, 'PHASE_AUTHORING_SKILL_OUTPUT_MISMATCH', /drafts only code steps/],
    [(definition) => { definition.phases.implementation.authoringSkill = 'sf-phase'; }, 'PHASE_AUTHORING_SKILL_OUTPUT_MISMATCH', /produces code/],
    // The shared implementation step is an analysis in the chore workflow, so sf-code fails there.
    [(definition) => { definition.phases.implementation.authoringSkill = 'sf-code'; }, 'PHASE_AUTHORING_SKILL_OUTPUT_MISMATCH', /'chore' phase 'implementation' produces an analysis/],
    [(definition) => { definition.phases.convergence.authoringSkill = 'sf-phase'; }, 'PHASE_AUTHORING_SKILL_NOT_APPLICABLE', /always uses \/sf-converge/],
    [(definition) => { definition.phases['poc-lite-plan'].authoringSkill = 'sf-design'; }, 'PHASE_AUTHORING_SKILL_NOT_APPLICABLE', /only producer is deterministic/],
    [(definition) => { definition.phases.verify.authoringSkill = 'sf-requirements'; }, 'PHASE_AUTHORING_SKILL_NOT_APPLICABLE', /only producer is deterministic/],
    // A step no workflow uses is checked too, so it cannot carry a value that fails once it is added.
    [(definition) => { definition.phases['vendor-notes'] = { label: 'Vendor notes', authoringSkill: 'sf-verify' }; }, 'PHASE_AUTHORING_SKILL_UNKNOWN', /Phase 'vendor-notes' names authoring skill 'sf-verify'/],
    [(definition) => { definition.phases['vendor-sign-off'] = { label: 'Vendor sign-off', generation: { requirement: 'none' }, authoringSkill: 'sf-release' }; }, 'PHASE_AUTHORING_SKILL_NOT_APPLICABLE', /Phase 'vendor-sign-off' drafts nothing/],
    [(definition) => { definition.phases['vendor-scan'] = { label: 'Vendor scan', generation: { task: 'analyze' }, authoringSkill: 'sf-release' }; }, 'PHASE_AUTHORING_SKILL_OUTPUT_MISMATCH', /Phase 'vendor-scan' produces an analysis/],
    [(definition) => {
      definition.workTypes.feature.phaseOverrides = { ...(definition.workTypes.feature.phaseOverrides ?? {}), design: { ...(definition.workTypes.feature.phaseOverrides?.design ?? {}), authoringSkill: 'sf-code' } };
    }, 'PHASE_AUTHORING_SKILL_OUTPUT_MISMATCH', /'feature' phase 'design' produces a document/]
  ];
  for (const [mutate, code, message] of cases) {
    const error = refusal(mutate);
    assert.ok(error, `expected ${code}`);
    assert.equal(error.code, code);
    assert.match(error.message, message);
  }
  // The reserved compiled-skill key is still refused exactly as before.
  assert.equal(refusal((definition) => { definition.phases.design.skill = 'sf-design'; }).code, 'SKP_PHASE_PRODUCER_UNSUPPORTED');
});

test('a specialised skill a step chose is routed, kept in guidance, and checks the step before working', async () => {
  const chosen = { id: 'vendor-analysis', generation: { task: 'analyze' }, authoringSkill: 'sf-design' };
  assert.deepEqual(authoringRoute(chosen), { authoringSkill: 'sf-design', effectiveAuthoringSkill: '/sf-design', authoringSkillSource: 'configured' });
  assert.equal(generationSkillForPhase(chosen), '/sflow-design');
  // The release skill drafts documents only, so an analysis step that names it falls back.
  assert.match(authoringRoute({ ...chosen, authoringSkill: 'sf-release' }).authoringSkillWarning, /cannot draft an analysis step/);
  assert.equal(safeCommandGuidance({ command: 'singularity-flow prepare vendor-analysis', skill: '/sf-design' }).copilotCommand, '/sf-design');
  assert.equal(safeCommandGuidance({ command: 'singularity-flow phase draft-check vendor-analysis --json', skill: '/sf-release' }).skill, '/sf-release');
  for (const entry of authoringSkillCatalog()) {
    const body = await readFile(path.join(packageRoot, 'plugin', 'skills', entry.sourceId, 'SKILL.md'), 'utf8');
    assert.deepEqual(authoringSkillContractErrors(entry, body), [], `${entry.sourceId} keeps the authoring contract`);
    if (!entry.legacyPhases.length) continue;
    assert.match(body, /singularity-flow clarification status <phase> --json/, `${entry.sourceId} follows the step's clarification mode`);
    assert.doesNotMatch(body, /\/sf-submit (?:requirements|design|release)\b/, `${entry.sourceId} no longer hard-codes its submit handoff`);
  }
});

test('the authoring contract audit checks the route, the built-in steps and the handoff, not just words', async () => {
  const design = authoringSkillCatalog().find((entry) => entry.id === 'sf-design');
  const body = await readFile(path.join(packageRoot, 'plugin', 'skills', 'sflow-design', 'SKILL.md'), 'utf8');
  const errors = (text, entry = design) => authoringSkillContractErrors(entry, text);
  assert.deepEqual(errors(body), []);
  // Moving the selection check out of step 1 leaves the skill working before it re-reads its route.
  const [firstStep] = body.match(/^1\. .*$/m);
  assert.ok(errors(body.replace(firstStep, '1. Read the inputs.').replace(/^2\. /m, `2. ${firstStep.slice(3)} `)).some((error) => error.startsWith('step 1')));
  assert.ok(errors(body.replace('show `policyReason`; stop', 'stop')).some((error) => error.includes('policyReason')));
  // Continuing on a built-in step whatever its route, or on the wrong built-in step, is refused.
  assert.ok(errors(body.replace('`effectiveAuthoringSkill` is `/sf-design`', '`authoringSkill` is `sf-design`')).length);
  assert.ok(errors(body.replace('`<phase>` = `design`', '`<phase>` = `requirements`')).some((error) => error.includes('built-in steps')));
  // A literal built-in step id in any command, including a hard-coded handoff, is refused.
  for (const literal of ['`singularity-flow submit design`', '`/sf-submit design`', '`singularity-flow wm compose --phase=design`', '`singularity-flow review-source status design`']) {
    assert.ok(errors(`${body}\n\nAlso run ${literal}.`).some((error) => error.includes("built-in step id 'design'")), literal);
  }
  assert.deepEqual(errors(`${body}\n\nAlso run \`singularity-flow prepare design-review\`.`), [], 'a longer step id is not a built-in one');
  assert.ok(errors(body.replace(/End with each returned `handoff`.*$/m, 'End with `Next in Copilot: /sf-submit`.')).some((error) => error.includes('handoff')));
  // A future selectable skill without built-in steps is checked too.
  const future = { id: 'sf-review-plan', sourceId: 'sflow-review-plan', produces: ['document'], legacyPhases: [] };
  assert.ok(errors('1. Draft the document.\n2. Publish it.', future).length >= 3);
});

test('guidance renders verified code routes regardless of the phase name and drops unlisted skills', () => {
  assert.equal(safeCommandGuidance({ command: 'singularity-flow prepare vendor-analysis', skill: '/sf-jira-board' }), null);
  const definition = starter();
  definition.workTypes.feature.phaseOverrides = {
    ...(definition.workTypes.feature.phaseOverrides ?? {}),
    design: { inputs: ['requirements'], writeScope: 'source-and-artifact', generation: { requirement: 'required', producer: 'agent', task: 'code' }, authoringSkill: 'sf-code' }
  };
  definition.workTypes.feature.plannedClaims.owners.design = 'requirements';
  const phase = resolveWorkType(validateDefinition(definition), 'feature').phases.find((entry) => entry.id === 'design');
  assert.equal(generationSkillForPhase(phase), '/sflow-code');
  assert.equal(safeCommandGuidance({ command: 'singularity-flow prepare design', skill: generationSkillForPhase(phase) }).copilotCommand, '/sf-code');
  assert.equal(safeCommandGuidance({ command: 'singularity-flow prepare build-api', skill: '/sf-code' }).copilotCommand, '/sf-code');
  assert.equal(safeCommandGuidance({ command: 'singularity-flow next', skill: '/sf-code' }), null,
    'a phase authoring route must not be asserted for the generic router');
  // Only the deterministic generator produces convergence, so no code or chosen skill is shown for it.
  assert.equal(safeCommandGuidance({ command: 'singularity-flow prepare convergence', skill: '/sf-code' }), null);
  assert.equal(safeCommandGuidance({ command: 'singularity-flow prepare convergence', skill: '/sf-design' }), null);
  assert.equal(safeCommandGuidance({ command: 'singularity-flow prepare convergence', skill: '/sf-converge' }).copilotCommand, '/sf-converge');
  // A narrated next action keeps a safe planned skill and falls back to the command's own skill.
  const fields = { id: 'prepare', label: 'Prepare', command: 'singularity-flow prepare vendor-analysis' };
  assert.equal(plannedAction(fields, '/sf-design').skill, '/sf-design');
  assert.equal(plannedAction(fields, '/sf-jira-board').skill, '/sf-phase');
  assert.equal(plannedAction(fields, null).skill, '/sf-phase');
  // A refusal that names the step's skill keeps it in its recovery step.
  const refusal = refusalRemediationPlan(new SingularityFlowError('Clarification is off.', {
    code: 'CLARIFICATION_MODE_OFF',
    details: { phase: 'vendor-analysis', remediation: { command: 'singularity-flow prepare vendor-analysis', skill: '/sf-design' } }
  }), ['clarification', 'record', 'vendor-analysis']);
  const continueStep = JSON.stringify(refusal).match(/"command":"singularity-flow prepare vendor-analysis"[^}]*/)?.[0] ?? '';
  assert.match(continueStep, /"skill":"\/sf-design"/);
});

test('a built-in step goes back to its specialised skill only on its automatic document route', () => {
  const definition = starter();
  definition.workTypes.feature.phaseOverrides = {
    ...(definition.workTypes.feature.phaseOverrides ?? {}),
    design: { inputs: ['requirements'], writeScope: 'source-and-artifact', generation: { requirement: 'required', producer: 'agent', task: 'code' } }
  };
  definition.workTypes.feature.plannedClaims.owners.design = 'requirements';
  const feature = resolveWorkType(validateDefinition(definition), 'feature').phases;
  assert.equal(legacyAuthoringSkill(feature.find((phase) => phase.id === 'requirements')), 'sf-requirements');
  assert.equal(legacyAuthoringSkill(feature.find((phase) => phase.id === 'design')), null, 'a design step changed into code goes to /sf-code');
  assert.equal(legacyAuthoringSkill({ id: 'release', generation: { requirement: 'none' } }), null, 'a sign-off-only release drafts nothing');
  assert.equal(legacyAuthoringSkill({ id: 'release', authoringSkill: 'sf-phase' }), null, 'a step that chose a skill keeps it');
  assert.equal(legacyAuthoringSkill({ id: 'release' }), 'sf-release');
  assert.equal(legacyAuthoringSkill({ id: 'vendor-analysis' }), null);
});

function execute(command, args, cwd, { allowFailure = false, agent = null } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Authoring Tester' };
  if (agent) env.SINGULARITY_FLOW_TEST_SELECTION = JSON.stringify({ workType: 'authoring-demo', agent });
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options) => execute(process.execPath, [bin, ...args], cwd, options);

async function storyRepository(configure = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-authoring-'));
  execute('git', ['init', '-b', 'main'], root);
  execute('git', ['config', 'user.name', 'Authoring Tester'], root);
  execute('git', ['config', 'user.email', 'authoring@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Authoring\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  config.repositoryReadiness = { ...(config.repositoryReadiness ?? {}), requiredBeforeStory: false };
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.phases.intake.authoringSkill = 'sf-phase';
  config.workTypes['authoring-demo'] = {
    label: 'Authoring demo', phases: ['intake', 'design'],
    phaseOverrides: { design: { inputs: ['intake'] } }
  };
  await configure(config, root);
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', 'README.md', 'singularity', '.github/agents'], root);
  execute('git', ['commit', '-m', 'initial'], root);
  const remote = `${root}.git`;
  execute('git', ['init', '--bare', '-b', 'main', remote], root);
  execute('git', ['remote', 'add', 'origin', remote], root);
  execute('git', ['push', '-u', 'origin', 'main'], root);
  return root;
}

test('a Story pins the step setting, routes from it, verifies it, and keeps its record format', async () => {
  const root = await storyRepository();
  flow(root, ['start', 'AUT-1', '--from-branch', 'main'], { agent: 'product-owner' });
  const workflowFile = path.join(root, 'singularity/work-items/AUT-1/workflow.json');
  const stored = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(stored.resolution.phases.find((phase) => phase.id === 'intake').authoringSkill, 'sf-phase');
  assert.equal(Object.hasOwn(stored.phases.intake, 'authoringSkill'), false, 'step state carries no copy of the setting');

  // Pinning the setting in the resolution keeps the operational policy comparison intact.
  assert.match(flow(root, ['validate']).stdout, /workflow is valid/);

  const shown = JSON.parse(flow(root, ['phase', 'show', 'intake', '--json']).stdout);
  assert.equal(shown.authoringSkill, 'sf-phase');
  assert.equal(shown.effectiveAuthoringSkill, '/sf-phase');
  assert.equal(shown.authoringSkillSource, 'configured');
  assert.equal(shown.policyVerified, true);
  assert.equal(shown.handoff.at(-1).skill, '/sf-submit');
  assert.match(shown.handoff.at(-1).command, /^singularity-flow submit intake/);

  const status = JSON.parse(flow(root, ['status', '--json']).stdout);
  assert.equal(status.authoringRoutes.intake.authoringSkillSource, 'configured');
  assert.equal(status.authoringRoutes.design.authoringSkillSource, 'automatic');
  assert.equal(status.authoringRoutes.design.effectiveAuthoringSkill, '/sf-phase');

  // A hand-edited resolution no longer matches its anchors. An enrolled Story refuses to load it at
  // all; the creation-anchor check behind policyVerified catches it for Stories without a snapshot.
  stored.resolution.phases.find((phase) => phase.id === 'intake').authoringSkill = 'sf-code';
  await writeFile(workflowFile, `${JSON.stringify(stored, null, 2)}\n`);
  const refused = flow(root, ['phase', 'show', 'intake', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /WFA_SNAPSHOT_INVALID/);
  const anchor = await pinnedResolutionVerification(root, await loadDefinition(root), stored);
  assert.deepEqual(anchor, { verified: false, reason: 'Resolved Story policy differs from the immutable creation commit. Run singularity-flow validate to see the difference.' });
  assert.notEqual(flow(root, ['validate'], { allowFailure: true }).status, 0, 'publication-time validation refuses it too');
  // An unverified route is withheld whole: no configured value, source or handoff to act on.
  const unenrolled = { ...stored, workflowSnapshot: undefined };
  assert.deepEqual(await phaseAuthoringSummary(root, await loadDefinition(root), unenrolled, unenrolled.phases.intake), {
    authoringSkill: null, effectiveAuthoringSkill: null, authoringSkillSource: 'unverified', policyVerified: false,
    policyReason: 'Resolved Story policy differs from the immutable creation commit. Run singularity-flow validate to see the difference.',
    handoff: []
  });
});

test('phase show reports the handoff only while the step is in progress, and a shallow clone cannot verify', async () => {
  const root = await storyRepository();
  flow(root, ['start', 'AUT-3', '--from-branch', 'main'], { agent: 'product-owner' });
  const design = JSON.parse(flow(root, ['phase', 'show', 'design', '--json']).stdout);
  assert.equal(design.policyVerified, true);
  assert.equal(design.effectiveAuthoringSkill, '/sf-phase');
  assert.deepEqual(design.handoff, [], 'nothing follows a publication the step has not started');
  assert.ok(JSON.parse(flow(root, ['phase', 'show', 'intake', '--json']).stdout).handoff.length);
  const text = flow(root, ['phase', 'show', 'intake']).stdout;
  assert.match(text, /Drafting skill: \/sf-phase \(configured\)/);
  assert.doesNotMatch(text, /Drafted with/);

  // In a shallow clone the oldest commit that adds the Story record is only the clone's boundary.
  const shallow = `${root}-shallow`;
  execute('git', ['clone', '--quiet', '--depth', '1', `file://${root}`, shallow], os.tmpdir());
  const stored = JSON.parse(await readFile(path.join(shallow, 'singularity/work-items/AUT-3/workflow.json'), 'utf8'));
  const verification = await pinnedResolutionVerification(shallow, await loadDefinition(shallow), { ...stored, workflowSnapshot: undefined });
  assert.equal(verification.verified, false);
  assert.match(verification.reason, /history is shallow/);
});

test('a new step that chose /sf-design is offered it by the engine once the step before it is done', async () => {
  const root = await storyRepository(async (config, repository) => {
    config.phases.intake.authoringSkill = 'sf-requirements';
    config.phases['vendor-analysis'] = {
      ...structuredClone(config.phases.design),
      label: 'Vendor analysis',
      artifact: { ...config.phases.design.artifact, path: 'artifacts/vendor-analysis/vendor-analysis.md', kind: 'vendor-analysis' },
      authoringSkill: 'sf-design'
    };
    config.workTypes['authoring-demo'] = {
      label: 'Authoring demo', phases: ['intake', 'vendor-analysis'],
      phaseOverrides: { 'vendor-analysis': { inputs: ['intake'] } }
    };
    // The architect drafts the new step, as Workflow Studio records it in the agent's own file.
    const agentFile = path.join(repository, '.github/agents/architect.agent.md');
    const agent = await readFile(agentFile, 'utf8');
    await writeFile(agentFile, agent
      .replace('sflow-phases: "design,', 'sflow-phases: "vendor-analysis,design,')
      .replace('sflow-default-for: "design,', 'sflow-default-for: "vendor-analysis,design,'));
  });
  const started = JSON.parse(flow(root, ['start', 'AUT-2', '--from-branch', 'main', '--json'], { agent: 'product-owner' }).stdout);
  // Every surface names the step's own skill: start, the planner-backed trailers and the native prompt.
  const startPrepare = started.next.find((action) => action.id === 'start.prepare');
  assert.deepEqual([startPrepare.skill, startPrepare.copilotCommand], ['/sf-requirements', '/sf-requirements']);
  const stored = JSON.parse(await readFile(path.join(root, 'singularity/work-items/AUT-2/workflow.json'), 'utf8'));
  const continued = attachContinuation({
    next: [], restState: null, why: [], subject: { kind: 'story', id: 'AUT-2' }, outcome: { status: 'succeeded' }
  }, { postState: stored });
  assert.equal(continued.next.find((action) => action.command === 'singularity-flow prepare intake')?.skill, '/sf-requirements');
  const remediated = attachContinuation({
    next: [], restState: null, why: [{ code: 'artifact.missing', slots: { phase: 'intake' } }], subject: { kind: 'story', id: 'AUT-2' }, outcome: { status: 'refused' }
  }, { postState: stored });
  assert.equal(remediated.next[0].skill, '/sf-requirements');
  const prompt = flow(root, ['wm', 'show-prompt']).stdout;
  assert.match(prompt, /- Skill: `\/sflow-requirements`/);
  assert.match(prompt, /--- BEGIN plugin\/skills\/sflow-requirements\/SKILL\.md ---/);
  const shown = JSON.parse(flow(root, ['phase', 'show', 'vendor-analysis', '--json']).stdout);
  assert.equal(shown.effectiveAuthoringSkill, '/sf-design');
  assert.equal(shown.authoringSkillSource, 'configured');
  const next = JSON.parse(flow(root, ['nextsteps', '--json']).stdout);
  const prepare = next.actions.find((action) => action.command === 'singularity-flow prepare vendor-analysis');
  assert.ok(prepare, 'the next step is announced after intake');
  assert.equal(prepare.skill, '/sf-design');
  assert.equal(prepare.copilotCommand, '/sf-design');
});
