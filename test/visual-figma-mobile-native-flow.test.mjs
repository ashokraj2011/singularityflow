/**
 * A phone-only app through the figma-mobile workflow, from the terminal.
 *
 * figma-mobile enforces coverage of a phone and a tablet profile and pins only Playwright and
 * Figma tools. The phone screenshot comes from a simulator, so it is recorded as a native capture
 * (`visual record`), never under an MCP tool. The app has no tablet layout, so a person who approves
 * visual-verification records that the tablet does not apply (`decision visual-profile`) when the
 * step opens, before anything is drafted, so the decision commit is that one decision; an approver of
 * another group cannot. Prepublish names, and publication refuses, the phone while it has no capture,
 * so no generation is published that submission would refuse; after the capture the Story completes
 * and its final gate passes, with the tablet listed as not applicable and never as passed. No
 * simulator runs: the test writes fixture PNGs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { slowLane } from './helpers/slow-lane.mjs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { encodePngRgba8 } from '../src/png-rgba8.mjs';

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const REVIEWER = 'Mobile Reviewer One';

function execute(command, args, cwd, { allowFailure = false, selection, actor = 'Singularity Flow Test' } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: actor };
  if (selection) env.SINGULARITY_FLOW_TEST_SELECTION = JSON.stringify(selection);
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: 180_000 });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options = {}) => execute(process.execPath, [bin, ...args], cwd, options);

async function repository(base) {
  const root = path.join(base, 'repo');
  await mkdir(root);
  execute('git', ['init', '-b', 'main'], root);
  execute('git', ['config', 'user.name', 'Singularity Flow Test'], root);
  execute('git', ['config', 'user.email', 'singularity-flow@example.invalid'], root);
  await writeFile(path.join(root, 'README.md'), '# Test\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.approvalSecurity = { profile: 'poc' };
  config.repositoryReadiness = { ...config.repositoryReadiness, requiredBeforeStory: false };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Only the named reviewer approves design and quality: the visual step's groups.
  for (const id of ['design-reviewers', 'quality-reviewers']) {
    config.approvalAuthorities[id] = { label: config.approvalAuthorities[id].label, allowAnyGitIdentity: false,
      members: [{ email: `${REVIEWER.toLowerCase().replace(/\s+/gu, '.')}@example.com` }] };
  }
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', 'README.md', 'singularity', '.github/agents'], root);
  execute('git', ['commit', '-m', 'initial'], root);
  execute('git', ['init', '--bare', '-b', 'main', path.join(base, 'remote.git')], root);
  execute('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')], root);
  execute('git', ['push', '-u', 'origin', 'main'], root);
  return { root, configPath };
}

async function completeArtifact(root, workflow, phaseId) {
  const phase = workflow.phases[phaseId];
  const file = path.join(root, 'singularity/work-items', workflow.workItem.id, phase.requiredArtifact.path);
  let text = await readFile(file, 'utf8');
  text = text.replace(/TODO:[^\n]*/g, 'matched evidence for AC-001 and SPEC-001 with exact file references and complete operational detail.');
  text = text.replace(/\bTODO\b/g, 'matched evidence');
  if (phaseId === 'conformance') {
    if (workflow.resolution?.spec?.conformanceRows === 'qualified') {
      text = text.split('\n').filter((line) => !/^\|.*matched\/partial\/missing\/deviated\/unplanned.*\|\s*$/u.test(line)).join('\n');
      const clauseIds = new Set();
      for (const source of Object.values(workflow.phases)) {
        if (!source.specIndex?.path) continue;
        const index = JSON.parse(await readFile(path.join(root, source.specIndex.path), 'utf8'));
        for (const clause of index.clauses ?? []) clauseIds.add(clause.id);
      }
      if (clauseIds.size) {
        text += '\n## Exact qualified clause comparison\n\n| Clause ID | Requirement | Code evidence | Test evidence | Verdict |\n|---|---|---|---|---|\n'
          + [...clauseIds].map((id) => `| \`${id}\` | approved | src/mobile.mjs | tests/mobile.test.mjs | matched |`).join('\n') + '\n';
      }
    }
    text += '\nSelf approvals: none; every step was approved by a reviewer other than its author.\n';
  }
  await writeFile(file, text);
  return file;
}

test('a phone-only figma-mobile Story completes with a native phone capture and a not-applicable tablet', slowLane({ timeout: 600_000 }), async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-visual-native-flow-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const { root, configPath } = await repository(base);
  const workId = 'MOBILE-201';
  const selection = (agent) => ({ selection: { workType: 'figma-mobile', agent } });
  flow(root, ['start', workId, '--from-branch', 'main', '--title', 'Build the approved phone screens'], selection('product-designer'));
  const workflowFile = path.join(root, 'singularity/work-items', workId, 'workflow.json');
  const agents = { 'design-intake': 'product-designer', 'design-inventory': 'product-designer', 'component-mapping': 'mobile-architect',
    'mobile-spec': 'mobile-architect', implementation: 'developer', 'visual-verification': 'qa', conformance: 'qa' };
  const json = (result) => JSON.parse(result.stdout);
  for (const phaseId of Object.keys(agents)) {
    let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
    assert.equal(workflow.currentPhase, phaseId);
    if (phaseId === 'visual-verification') {
      // Only the visual step's approvers decide it (the Story's starter is enrolled in every group, so the
      // outsider is a third identity). It is decided as the step opens, so its commit is that decision alone.
      const reason = 'This release ships to phones only; the app has no tablet layout to verify.';
      const decision = ['decision', 'visual-profile', workId, '--phase', phaseId, '--profile', 'tablet-834x1194', '--not-applicable', '--reason', reason];
      const outsider = flow(root, [...decision, '--json'], { actor: 'Other Engineer', allowFailure: true });
      assert.notEqual(outsider.status, 0);
      assert.equal(json(outsider).error.code, 'APPROVAL_IDENTITY_NOT_AUTHORIZED', outsider.stdout);
      const lastProfile = flow(root, ['decision', 'visual-profile', workId, '--phase', phaseId, '--profile', 'watch-198x242', '--not-applicable', '--reason', reason, '--json'],
        { actor: REVIEWER, allowFailure: true });
      assert.equal(json(lastProfile).error.code, 'VISUAL_PROFILE_UNKNOWN');
      const beforeDecision = execute('git', ['rev-parse', 'HEAD'], root).stdout.trim();
      const accepted = json(flow(root, [...decision, '--json'], { actor: REVIEWER }));
      assert.equal(accepted.data.record.id, 'VPD-001');
      assert.equal(accepted.data.record.actor, 'mobile.reviewer.one@example.com');
      assert.equal(accepted.data.record.authorityGroup, 'design-reviewers');
      assert.match(execute('git', ['log', '-1', '--format=%s'], root).stdout, /^\[MOBILE-201\]\[visual-profile:not-applicable\] visual-verification tablet-834x1194/u);
      const decisionCommit = execute('git', ['rev-parse', 'HEAD'], root).stdout.trim();
      const stored = JSON.parse(await readFile(workflowFile, 'utf8'));
      assert.deepEqual(stored.visualProfileDecisions, [accepted.data.record], 'recorded append-only in workflow.json');
      assert.equal(stored.history.at(-1).event, 'visual_profile_decided');
      const { onlyHumanDecisionCommits } = await import('../src/state.mjs');
      assert.deepEqual(onlyHumanDecisionCommits(root, YAML.parse(await readFile(configPath, 'utf8')), stored, beforeDecision, decisionCommit), [decisionCommit],
        'the decision commit is one person\'s decision');
      // The phone cannot be decided away too: it is the last profile left to evidence.
      const last = flow(root, ['decision', 'visual-profile', workId, '--phase', phaseId, '--profile', 'phone-390x844', '--not-applicable', '--reason', reason, '--json'],
        { actor: REVIEWER, allowFailure: true });
      assert.equal(json(last).error.code, 'VISUAL_PROFILE_LAST_REQUIRED');
    }
    flow(root, ['prepare', phaseId], selection(agents[phaseId]));
    flow(root, ['resume', workId], selection(agents[phaseId]));
    workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
    const artifact = await completeArtifact(root, workflow, phaseId);
    if (phaseId === 'mobile-spec') {
      await writeFile(artifact, `${await readFile(artifact, 'utf8')}\n## Reviewed exact planned evidence\n\n| Clause | Expected paths | Planned tests |\n|---|---|---|\n`
        + `| \`${workId}:AC-001\` | \`src/mobile.mjs\` | \`tests/mobile.test.mjs\` |\n| \`${workId}:IFC-001\` | \`src/mobile.mjs\` | \`tests/mobile.test.mjs\` |\n`);
    }
    if (phaseId === 'design-intake') {
      await writeFile(path.join(root, 'figma-metadata.xml'), '<figma><frame id="1:3" name="Checkout" /></figma>\n');
      flow(root, ['mcp', 'record', 'figma', '--kind', 'design-source', '--tool', 'get_metadata', '--phase', phaseId,
        '--output', 'figma-metadata.xml', '--file-key', 'checkout-mobile', '--file-version', 'v1', '--node', '1:3'], selection(agents[phaseId]));
      await unlink(path.join(root, 'figma-metadata.xml'));
    }
    if (phaseId === 'implementation') {
      await mkdir(path.join(root, 'src'), { recursive: true }); await mkdir(path.join(root, 'tests'), { recursive: true });
      await writeFile(path.join(root, 'src/mobile.mjs'), ['// @clause:MOBILE-201:AC-001 renders the designed screen',
        '// @clause:MOBILE-201:IFC-001 exposes the screen component', 'export const mobile = true; // SPEC-001', ''].join('\n'));
      await writeFile(path.join(root, 'tests/mobile.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
        '// @ac:MOBILE-201:AC-001 SPEC-001', "test('mobile', () => assert.ok(true));", ''].join('\n'));
    }
    if (phaseId === 'visual-verification') {
      const { profiles } = workflow.resolution.verification;
      assert.deepEqual(profiles.map((profile) => profile.id), ['phone-390x844', 'tablet-834x1194'], 'the packaged figma-mobile profiles');
      const record = (profileId, file, extra = []) => ['visual', 'record', '--phase', phaseId, '--profile-id', profileId, '--screen-id', 'checkout',
        '--state-id', 'default', '--file', file, '--source', 'simulator', '--device', 'iPhone 15', '--os-version', '17.5', ...extra];
      await writeFile(path.join(root, 'phone.png'), encodePngRgba8({ width: 390, height: 844, data: Buffer.alloc(390 * 844 * 4, 255) }));
      // A phone-size image is no tablet capture.
      const mismatch = flow(root, [...record('tablet-834x1194', 'phone.png'), '--json'], { ...selection('qa'), allowFailure: true });
      assert.notEqual(mismatch.status, 0);
      assert.equal(json(mismatch).error.code, 'VISUAL_CAPTURE_DIMENSIONS_MISMATCH', mismatch.stdout);
      assert.deepEqual(json(mismatch).error.details.capture, { profileId: 'tablet-834x1194', expected: { width: 834, height: 1194 }, actual: { width: 390, height: 844 } });

      // The phone, the profile left to evidence, has no capture yet: prepublish names it and publication
      // is refused naming the capture, so no generation is published that submission would refuse.
      const prepublished = json(flow(root, ['phase', 'prepublish', phaseId, '--json'], { ...selection('qa'), allowFailure: true }));
      assert.notEqual(prepublished.status, 'ready');
      assert.ok(prepublished.findings.some((finding) => finding.details?.sourceCode === 'VISUAL_COVERAGE_FAILED'
        && /phone-390x844/u.test(finding.message)), JSON.stringify(prepublished.findings));
      const refused = flow(root, ['phase', 'publish', phaseId, '--json'], { ...selection('qa'), allowFailure: true });
      assert.notEqual(refused.status, 0);
      const refusal = json(refused);
      assert.equal(refusal.error.code, 'VISUAL_COVERAGE_FAILED', refused.stdout);
      assert.deepEqual(refusal.error.details.uncoveredProfiles, ['phone-390x844']);
      const routes = refusal.remediationPlan.steps.map((step) => step.command);
      assert.ok(routes[0]?.startsWith('singularity-flow visual record --phase visual-verification --profile-id phone-390x844 '), JSON.stringify(routes));
      assert.ok(!routes.some((command) => command?.startsWith('singularity-flow decision visual-profile')), 'the last profile left to evidence cannot be decided away');
      assert.equal(JSON.parse(await readFile(workflowFile, 'utf8')).phases[phaseId].generation ?? 0, 0, 'nothing was published');

      const captured = flow(root, record('phone-390x844', 'phone.png'), selection('qa'));
      assert.match(captured.stdout, /Recorded native capture vnc-[0-9a-f-]+ for phone-390x844: 390×844 from simulator iPhone 15 \(17\.5\)\./u);
      await unlink(path.join(root, 'phone.png'));
      const reason = 'This release ships to phones only; the app has no tablet layout to verify.';

      const status = json(flow(root, ['visual', 'status', '--json']));
      assert.equal(status.coverage.status, 'warn');
      assert.deepEqual(status.coverage.uncovered, []);
      assert.deepEqual(status.coverage.covered.map((entry) => [entry.profileId, entry.method, entry.source.device]), [['phone-390x844', 'native-capture', 'iPhone 15']]);
      assert.deepEqual(status.coverage.notApplicable.map((entry) => [entry.profileId, entry.decisionId, entry.reason]), [['tablet-834x1194', 'VPD-001', reason]]);
      const text = flow(root, ['visual', 'status']);
      assert.match(text.stdout, /Not applicable: tablet-834x1194 \(VPD-001, decided by mobile\.reviewer\.one@example\.com through design-reviewers\)/u);
      assert.match(text.stdout, /Native capture: phone-390x844 vnc-/u);
    }
    flow(root, ['phase', 'publish', phaseId], selection(agents[phaseId]));
    flow(root, ['submit'], selection(agents[phaseId]));
    flow(root, ['approve', '--yes'], { actor: REVIEWER, ...selection(agents[phaseId]) });
  }
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.status, 'closed');
  assert.equal(workflow.phases['visual-verification'].approvals.filter((approval) => approval.decision === 'approved').length, 1);
  const gate = flow(root, ['gate', '--terminal', '--json']);
  assert.equal(gate.status, 0);
  const tracked = execute('git', ['ls-files', `singularity/work-items/${workId}/context/visual/captures`], root).stdout.trim().split('\n');
  assert.equal(tracked.filter((file) => file.endsWith('.json')).length, 1, 'the native capture record is committed');
  assert.equal(tracked.filter((file) => file.endsWith('.png')).length, 1, 'and its image');
  assert.equal(execute('git', ['ls-files', `singularity/work-items/${workId}/context/mcp/records`], root).stdout.trim().split('\n').length, 1,
    'the only MCP record is the Figma design source; no MCP record claims the simulator capture');
});
