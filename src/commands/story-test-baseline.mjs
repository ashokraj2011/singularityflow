/** Pre-Story baseline capture is an explicit execution, never a risk acceptance. */
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { resolveWorkType } from '../config.mjs';
import { loadStoryConfigurationSnapshot } from '../configuration-branch.mjs';
import { head } from '../git.mjs';
import { GitRemoteSession } from '../git-execution.mjs';
import { fosStoryConfigurationAuthority } from '../onboard.mjs';
import { loadConfig } from '../state.mjs';
import { prepareStoryWorktree, preparedStoryWorktreePath, samePlatformPath, storyWorktreePath } from '../story-worktree.mjs';
import { normalizeTestRecoveryPolicy } from '../test-recovery-intake.mjs';
import { trpDigest } from '../test-recovery-policy.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { validatePortableWorkId } from '../work-id.mjs';

async function canonicalTarget(target) {
  let existing = path.resolve(target); const missing = [];
  for (;;) {
    try { return path.join(await realpath(existing), ...missing.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(existing) === existing) throw error;
      missing.push(path.basename(existing)); existing = path.dirname(existing);
    }
  }
}

export async function run(positionals, { root, options = {} }) {
  const workId = positionals[0] ?? optionString(options, 'work-id');
  validatePortableWorkId(workId);
  const authority = await fosStoryConfigurationAuthority(root);
  const snapshot = authority ? await loadStoryConfigurationSnapshot(authority, {
    session: new GitRemoteSession({ cwd: root }), useObjectCache: true
  }) : null;
  const config = snapshot?.definition ?? await loadConfig(root);
  const policy = normalizeTestRecoveryPolicy(config.testRecovery);
  if (!policy?.enabled || !policy.enabledRiskCategories.includes('known-test-failure')) throw new SingularityFlowError(
    'The selected approved workflow must enable known-test-failure review and an independent testcase inventory.', { code: 'TRP_NOT_ENABLED' });
  const phaseId = optionString(options, 'phase');
  const repositoryId = optionString(options, 'repository', 'lifecycle');
  const baseCommit = optionString(options, 'base', head(root));
  const availableWorkTypes = Object.keys(config.workTypes ?? {});
  const workType = optionString(options, 'work-type') ?? (availableWorkTypes.length === 1 ? availableWorkTypes[0] : null);
  if (!workType || !config.workTypes?.[workType]?.phases?.includes(phaseId) || !/^[a-f0-9]{40,64}$/u.test(baseCommit ?? '')) throw new SingularityFlowError(
    'Select an exact base commit and a code-delivery phase in the requested work type.', { code: 'TRP_INTAKE_BASELINE_INVALID' });
  const phase = resolveWorkType(config, workType).phases.find(entry => entry.id === phaseId);
  const isolatedWorktree = optionBoolean(options, 'isolated-worktree');
  const targetRepository = await canonicalTarget(isolatedWorktree
    ? await preparedStoryWorktreePath(root, workId, { baseCommit }) ?? await storyWorktreePath(root, workId)
    : root);
  const plan = { schemaVersion: 1, workId, workType, phaseId, repositoryId, baseCommit,
    isolatedWorktree, targetRepository,
    command: phase.qualityCommands, policySha256: trpDigest(policy),
    evidencePurpose: 'baseline-admission-only', observedOutcome: 'not-run' };
  const confirmation = trpDigest(plan);
  const args = ['test-policy', 'baseline', workId, '--phase', phaseId, '--repository', repositoryId,
    '--base', baseCommit, '--work-type', workType, ...(isolatedWorktree ? ['--isolated-worktree'] : []),
    '--run', '--confirm', confirmation, '--json'];
  let result = { ...plan, resultType: 'story-test-baseline-plan', confirmation, executed: false, stateChanged: false,
    legalActions: [{ id: 'capture-baseline', label: 'Run the exact pre-feature test baseline; no risk is accepted', command: 'story', args }] };
  if (optionBoolean(options, 'run')) {
    if (optionString(options, 'confirm') !== confirmation) throw new SingularityFlowError(
      'Review the exact baseline command plan and pass its confirmation with --run.', { code: 'TRP_INTAKE_CONFIRMATION_REQUIRED', details: result });
    const { captureTrpIntakeBaseline } = await import('../test-recovery-runtime.mjs');
    let prepared = null; let captured;
    try {
      if (isolatedWorktree) {
        prepared = await prepareStoryWorktree(root, workId, { base: baseCommit });
        if (!samePlatformPath(await realpath(prepared.repositoryPath), targetRepository) || prepared.initialHead !== baseCommit
          || head(prepared.repositoryPath) !== baseCommit) throw new SingularityFlowError(
          'The managed target or its exact base differs from the reviewed baseline plan. The checkout is retained for inspection.',
          { code: 'TRP_INTAKE_BASELINE_INVALID' });
      }
      captured = await captureTrpIntakeBaseline(targetRepository, config, { workId, workType, phaseId, repositoryId, baseCommit });
    } catch (error) {
      if (prepared) {
        error.message += ` The managed baseline checkout was retained at ${prepared.repositoryPath}; no Story was created and no evidence was copied from another checkout.`;
        error.details = { ...(error.details ?? {}), targetRepository: prepared.repositoryPath,
          worktreeRetained: true, storyChanged: false,
          recovery: 'The managed checkout and any native baseline output were retained. Inspect the original failure, then retry the same isolated baseline or Story start flow; no evidence was copied from another checkout.' };
      }
      throw error;
    }
    result = { ...result, ...captured, resultType: 'story-test-baseline-capture', executed: true,
      stateChanged: true, filesChanged: true, storyChanged: false,
      ...(prepared ? { worktree: prepared,
        resumeInstruction: `Resume the same Story start with --isolated-worktree --test-baseline-record ${captured.recordSha256}; review the fresh intake confirmation in this managed checkout. The baseline is bound to ${targetRepository} and cannot be transferred to another checkout.` } : {}),
      message: 'Captured local baseline reports and the private host evidence journal. No Story, risk acceptance, commit or publication was created.',
      legalActions: [] };
  }
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else console.log(result.executed ? `${result.message}\nBaseline: ${result.recordSha256}` : `Review the exact baseline execution plan:\n${JSON.stringify(result, null, 2)}`);
  return result;
}
