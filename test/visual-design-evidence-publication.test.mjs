/**
 * Design-source and visual-capture evidence is checked where it is bound: at the publication that
 * commits it, and named by prepublish first [gate parity].
 *
 * Walking figma-mobile without Figma or a device found three dead ends. design-intake's prepublish
 * said ready while publication refused DESIGN_SOURCE_REQUIRED, naming only recover, and the uploaded
 * export the template asked for did not count. visual-verification published with no capture, so
 * submission refused; a capture recorded then belonged to the next generation, and every route led
 * back to "capture it". And `visual compare` could not read the DOC-nnn and vnc-... IDs the template
 * and coverage name. One-step workflows stand in for figma-mobile so each check runs alone; fixture
 * PNGs stand in for screenshots, and no model, simulator or Figma host runs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { encodePngRgba8 } from '../src/png-rgba8.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const OMITTED = 'This test workflow checks one step and delivers nothing else.';

function execute(command, args, cwd, { allowFailure = false, selection } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Singularity Flow Test' };
  if (selection) env.SINGULARITY_FLOW_TEST_SELECTION = JSON.stringify(selection);
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: childTimeout(180_000) });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const json = (result) => JSON.parse(result.stdout);

/** A repository whose one-step workflows reuse figma-mobile's design-source and coverage policy. */
async function story(t, workType, agent, workId) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-visual-design-evidence-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await mkdir(root);
  execute('git', ['init', '-b', 'main'], root);
  execute('git', ['config', 'user.name', 'Singularity Flow Test'], root);
  execute('git', ['config', 'user.email', 'singularity-flow@example.invalid'], root);
  await writeFile(path.join(root, 'README.md'), '# Test\n');
  execute(process.execPath, [bin, 'init'], root);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.approvalSecurity = { profile: 'poc' };
  config.repositoryReadiness = { ...config.repositoryReadiness, requiredBeforeStory: false };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  const mobile = config.workTypes['figma-mobile'];
  const omits = (list) => list.map((responsibility) => ({ responsibility, reason: OMITTED, authority: 'quality-reviewers' }));
  config.workTypes['visual-only'] = { label: 'Visual check', phases: ['visual-verification'], verification: mobile.verification,
    templateOverrides: { 'visual-verification': mobile.templateOverrides['visual-verification'] },
    documents: { allowedPhases: ['visual-verification'] }, omits: omits(['scope', 'plan', 'implement']),
    phaseOverrides: { 'visual-verification': { writeScope: 'artifact-only' } } };
  config.workTypes['design-only'] = { label: 'Design intake', phases: ['design-intake'], designSources: { ...mobile.designSources, consumeIn: [] },
    templateOverrides: { 'design-intake': mobile.templateOverrides['design-intake'] },
    documents: { allowedPhases: ['design-intake'] }, omits: omits(['scope', 'plan', 'implement', 'verify', 'review']) };
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', '-A'], root);
  execute('git', ['commit', '-m', 'initial'], root);
  execute('git', ['init', '--bare', '-b', 'main', path.join(base, 'remote.git')], root);
  execute('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')], root);
  execute('git', ['push', '-u', 'origin', 'main'], root);
  const selection = { workType, agent };
  const flow = (args, options = {}) => execute(process.execPath, [bin, ...args], root, { selection, ...options });
  flow(['start', workId, '--from-branch', 'main', '--title', 'Check the approved screens']);
  const phaseId = config.workTypes[workType].phases[0];
  flow(['prepare', phaseId]);
  flow(['resume', workId]);
  const workflowFile = path.join(root, 'singularity/work-items', workId, 'workflow.json');
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  const artifact = path.join(root, 'singularity/work-items', workId, workflow.phases[phaseId].requiredArtifact.path);
  const text = (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'matched evidence with exact file references and complete operational detail.')
    .replace(/\bTODO\b/gu, 'matched evidence');
  await writeFile(artifact, text);
  return { base, root, flow, phaseId, workflowFile };
}

/** A fixture screenshot, written outside the repository's tracked paths until it is recorded. */
async function png(root, name, width, height, value = 255) {
  await mkdir(path.join(root, 'shots'), { recursive: true });
  await writeFile(path.join(root, 'shots', name), encodePngRgba8({ width, height, data: Buffer.alloc(width * height * 4, value) }));
  return `shots/${name}`;
}

test('design-intake names its missing design source before publication, and an uploaded export does not count', slowLane({ timeout: 300_000 }), async (t) => {
  const { base, root, flow, phaseId, workflowFile } = await story(t, 'design-only', 'product-designer', 'DESIGN-1');
  const exportDirectory = path.join(base, 'export');
  await mkdir(exportDirectory);
  await writeFile(path.join(exportDirectory, 'checkout.png'), encodePngRgba8({ width: 4, height: 4, data: Buffer.alloc(64, 200) }));
  flow(['documents', 'upload', exportDirectory, '--kind', 'figma-export', '--name', 'Checkout export']);
  const command = 'singularity-flow mcp record figma --kind design-source --tool get_metadata --phase design-intake --output <METADATA-XML-PATH> --file-key <FIGMA-FILE-KEY> --file-version <FIGMA-FILE-VERSION>';

  // Prepublish no longer says ready: it reports the refusal publication would raise, with its route. It is read
  // for the human publication this test makes; a Copilot-authored one also needs the step's clarification first.
  const prepublished = json(flow(['phase', 'prepublish', phaseId, '--no-model', '--json'], { allowFailure: true }));
  assert.notEqual(prepublished.status, 'ready');
  const finding = prepublished.findings.find((entry) => entry.details?.sourceCode === 'DESIGN_SOURCE_REQUIRED');
  assert.ok(finding, JSON.stringify(prepublished.findings));
  assert.match(finding.message, /an uploaded export \(documents upload --kind figma-export\) is the reviewed package, not a design source/u);
  assert.equal(prepublished.commands.next, command);

  const refused = flow(['phase', 'publish', phaseId, '--authored', 'human', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.equal(json(refused).error.code, 'DESIGN_SOURCE_REQUIRED', refused.stdout);
  const routes = json(refused).remediationPlan.steps.map((step) => step.command);
  assert.equal(routes[0], command, JSON.stringify(routes));
  assert.match(json(refused).remediationPlan.steps[0].label, /Without a figma MCP connection there is no design-source record to make/u);
  assert.equal(JSON.parse(await readFile(workflowFile, 'utf8')).phases[phaseId].generation ?? 0, 0, 'nothing was published');

  // The named route is the one that works.
  await writeFile(path.join(root, 'figma-metadata.xml'), '<figma><frame id="1:3" name="Checkout" /></figma>\n');
  flow(['mcp', 'record', 'figma', '--kind', 'design-source', '--tool', 'get_metadata', '--phase', phaseId, '--output', 'figma-metadata.xml',
    '--file-key', 'checkout-mobile', '--file-version', 'v1', '--node', '1:3']);
  await unlink(path.join(root, 'figma-metadata.xml'));
  const ready = json(flow(['phase', 'prepublish', phaseId, '--json'], { allowFailure: true }));
  assert.ok(!ready.findings.some((entry) => entry.details?.sourceCode === 'DESIGN_SOURCE_REQUIRED'), JSON.stringify(ready.findings));
  flow(['phase', 'publish', phaseId, '--authored', 'human']);
  const published = JSON.parse(await readFile(workflowFile, 'utf8')).phases[phaseId];
  assert.equal(published.generation, 1);
  assert.deepEqual(published.designSourceSets.map((set) => set.records.map((entry) => entry.fileVersion)), [['v1']]);
});

test('a visual step is not published uncovered, and a capture recorded after publication routes to the publication that opens its generation', slowLane({ timeout: 300_000 }), async (t) => {
  const { root, flow, phaseId, workflowFile } = await story(t, 'visual-only', 'qa', 'VISUAL-1');
  const record = async (profileId, width, height) => {
    const file = await png(root, `${profileId}.png`, width, height);
    const recorded = flow(['visual', 'record', '--phase', phaseId, '--profile-id', profileId, '--screen-id', 'checkout', '--state-id', 'default',
      '--file', file, '--source', 'simulator', '--device', 'iPhone 15', '--json']);
    await rm(path.join(root, 'shots'), { recursive: true, force: true });
    return json(recorded).record;
  };
  const reason = 'This release ships to phones only; the app has no tablet layout to verify.';
  // Nothing captured: prepublish names it, and publication refuses before any generation is written.
  const prepublished = json(flow(['phase', 'prepublish', phaseId, '--json'], { allowFailure: true }));
  assert.ok(prepublished.findings.some((entry) => entry.details?.sourceCode === 'VISUAL_COVERAGE_FAILED'), JSON.stringify(prepublished.findings));
  assert.match(prepublished.commands.next, /^singularity-flow visual record --phase visual-verification --profile-id phone-390x844 /u);
  const refused = flow(['phase', 'publish', phaseId, '--authored', 'human', '--json'], { allowFailure: true });
  assert.equal(json(refused).error.code, 'VISUAL_COVERAGE_FAILED', refused.stdout);
  assert.deepEqual(json(refused).error.details.uncoveredProfiles, ['phone-390x844', 'tablet-834x1194']);
  assert.match(json(refused).error.message, /without one there is no capture to record/u);
  const routes = json(refused).remediationPlan.steps.map((step) => step.command);
  assert.match(routes[0], /^singularity-flow visual record --phase visual-verification --profile-id phone-390x844 /u);
  assert.equal(routes[1], 'singularity-flow decision visual-profile VISUAL-1 --phase visual-verification --profile phone-390x844 --not-applicable --reason "<why this screen size does not apply to this Story>"');
  assert.equal(JSON.parse(await readFile(workflowFile, 'utf8')).phases[phaseId].generation ?? 0, 0, 'nothing was published');
  // Next steps offer the capture before the publication that commits it.
  const authoring = json(flow(['nextsteps', '--json'])).actions.map((entry) => entry.command ?? '');
  const capturing = authoring.findIndex((command) => command.startsWith('singularity-flow visual record --phase visual-verification '));
  assert.ok(capturing >= 0, authoring.join('\n'));
  const publishing = authoring.findIndex((command) => command.startsWith('singularity-flow phase publish visual-verification'));
  assert.ok(publishing < 0 || capturing < publishing, authoring.join('\n'));

  // Captured and decided before publishing: the decision commits only itself, publication commits the capture.
  const firstPhone = await record('phone-390x844', 390, 844);
  assert.equal(firstPhone.targetGeneration, 1);
  flow(['decision', 'visual-profile', 'VISUAL-1', '--phase', phaseId, '--profile', 'tablet-834x1194', '--not-applicable', '--reason', reason]);
  const decided = execute('git', ['show', '--name-only', '--format=', 'HEAD'], root).stdout.trim().split('\n');
  assert.ok(decided.every((file) => !file.includes('/artifacts/') && !file.includes('/context/visual/')), decided.join('\n'));
  flow(['phase', 'publish', phaseId, '--authored', 'human']);
  for (const responsibility of ['scope', 'plan', 'implement']) flow(['decision', 'applicability', '--responsibility', responsibility, '--reason', OMITTED]);

  // The tablet becomes required after publication; what is captured now belongs to generation 2.
  flow(['decision', 'visual-profile', 'VISUAL-1', '--revoke', 'VPD-001', '--reason', 'The tablet layout ships in this release after all.']);
  const tablet = await record('tablet-834x1194', 834, 1194);
  const phone = await record('phone-390x844', 390, 844);
  assert.deepEqual([tablet.targetGeneration, phone.targetGeneration], [2, 2]);
  const republish = 'singularity-flow phase publish visual-verification --authored human --channel manual-in-place';
  const submitted = flow(['submit', '--json'], { allowFailure: true });
  assert.equal(json(submitted).error.code, 'VISUAL_COVERAGE_FAILED', submitted.stdout);
  const steps = json(submitted).remediationPlan.steps;
  assert.equal(steps[0].command, republish, JSON.stringify(steps));
  assert.match(steps[0].label, /recorded after generation 1 was published, so they are committed by, and count for, generation 2/u);
  assert.doesNotMatch(JSON.stringify(steps), /visual record/u, 'never back into capturing what is already captured');
  const next = json(flow(['nextsteps', '--json']));
  assert.equal(next.actions[0].timing, 'now');
  assert.equal(next.actions[0].command, republish, JSON.stringify(next.actions));
  assert.ok(!next.actions.some((entry) => entry.timing === 'now' && entry.command?.startsWith('singularity-flow submit')), 'submitting waits for the publication');
  assert.equal(json(flow(['phase', 'prepublish', phaseId, '--json'], { allowFailure: true })).commands.next, republish);

  // Following the route opens generation 2, which the captures cover, and the step submits.
  flow(republish.split(' ').slice(1));
  flow(['submit']);
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.phases[phaseId].generation, 2);
  assert.equal(workflow.phases[phaseId].status, 'awaiting_approval');
  const status = json(flow(['visual', 'status', '--json']));
  assert.deepEqual(status.coverage.covered.map((entry) => entry.recordId).sort(), [phone.id, tablet.id].sort());
  assert.ok(status.coverage.stale.includes(firstPhone.id), 'the generation 1 capture stays recorded, counted for generation 1 only');
});

test('visual compare reads a design document and a native capture by the IDs the template and coverage name', slowLane({ timeout: 300_000 }), async (t) => {
  const { base, root, flow, phaseId } = await story(t, 'visual-only', 'qa', 'VISUAL-2');
  const design = path.join(base, 'checkout-design.png');
  const designed = Buffer.alloc(390 * 844 * 4, 255);
  designed.fill(0, 0, 4000);
  await writeFile(design, encodePngRgba8({ width: 390, height: 844, data: designed }));
  flow(['documents', 'upload', design, '--name', 'Checkout design']);
  const file = await png(root, 'phone.png', 390, 844);
  const capture = json(flow(['visual', 'record', '--phase', phaseId, '--profile-id', 'phone-390x844', '--screen-id', 'checkout', '--state-id', 'default',
    '--file', file, '--source', 'simulator', '--device', 'iPhone 15', '--json'])).record;
  await rm(path.join(root, 'shots'), { recursive: true, force: true });

  const compared = json(flow(['visual', 'compare', '--expected', 'DOC-001', '--actual', capture.id, '--json']));
  assert.equal(compared.expected.recordId, 'DOC-001');
  assert.equal(compared.actual.recordId, capture.id);
  assert.equal(compared.actual.path, capture.output.path);
  assert.equal(compared.actual.sha256, capture.outputSha256);
  assert.equal(compared.profileId, 'phone-390x844', 'the profile comes from the capture');
  assert.equal(compared.disposition, 'pixel-difference');
  assert.equal(compared.differingPixels, 1000);
  assert.ok(compared.diffImage?.path, 'a diff image is written');
  const evidence = await readdir(path.join(root, 'singularity/work-items/VISUAL-2/artifacts/visual-verification/evidence/phone-390x844'));
  assert.ok(evidence.includes(`${compared.id}.json`), evidence.join(', '));

  for (const [reference, code] of [['vnc-00000000-0000-0000-0000-000000000000', 'VISUAL_COMPARISON_INPUT_UNRESOLVED'], ['DOC-009', 'DOCUMENT_NOT_FOUND']]) {
    const refused = flow(['visual', 'compare', '--expected', reference, '--actual', capture.id, '--json'], { allowFailure: true });
    assert.notEqual(refused.status, 0);
    assert.equal(json(refused).error.code, code, refused.stdout);
  }
});
