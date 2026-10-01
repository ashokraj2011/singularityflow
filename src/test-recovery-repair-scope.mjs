/** Conservative readiness-only pilot; path inference never grants product-edit authority. */
import path from 'node:path';
import { isAllowedTestAutomationPath, isTestSourceName } from './code-delivery-tests.mjs';
import { approvedConfigurationMaterializations } from './configuration-materialization.mjs';
import { exactFileAtObject } from './git.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { buildRepositoryTreeChangeSet } from './repository-change-set.mjs';
import { trpDigest } from './test-recovery-policy.mjs';
import { SingularityFlowError } from './util.mjs';

const documentation = value => /^(?:README|CHANGELOG|CONTRIBUTING|LICENSE|NOTICE)(?:\.(?:md|markdown|rst|adoc|txt))?$/iu.test(value);
const testPath = value => isAllowedTestAutomationPath(value) || isTestSourceName(value);
const isRegular = mode => ['100644', '100755'].includes(mode);
const inRoot = (value, root) => value === root || value.startsWith(`${root}/`);
const fail = message => { throw new SingularityFlowError(message, { code: 'TRP_REPAIR_COHORT_UNAVAILABLE' }); };

function dependencyOnly(before, after) {
  if (!before || !after) return false;
  try {
    const previous = JSON.parse(before.toString('utf8'));
    const current = JSON.parse(after.toString('utf8'));
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (Object.keys(previous[key] ?? {}).some(name => !Object.hasOwn(current[key] ?? {}, name))) return false;
      delete previous[key]; delete current[key];
    }
    return trpDigest(previous) === trpDigest(current);
  } catch { return false; }
}

/** Both Git endpoints, modes and objects are shown and bound by the caller's confirmation. */
export function inspectTrpRepairScope(root, { workflow, workRoot, baseCommit, repairCommit,
  changeSet = null, readFileAt = exactFileAtObject } = {}) {
  const changed = changeSet ?? buildRepositoryTreeChangeSet(root, { baseTree: baseCommit, targetTree: repairCommit,
    env: { ...withoutGitProcessOverrides(), GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' } });
  const ownedRoot = path.relative(root, workRoot).split(path.sep).join('/');
  if (!ownedRoot || ownedRoot.startsWith('../') || path.posix.isAbsolute(ownedRoot)) {
    throw new SingularityFlowError('Readiness repair requires the exact Story-owned root.', { code: 'TRP_REPAIR_SCOPE_UNAVAILABLE' });
  }
  const projected = approvedConfigurationMaterializations(changed, workflow);
  const entries = changed.entries.map(entry => {
    const name = entry.newPath ?? entry.oldPath;
    const paths = [entry.oldPath, entry.newPath].filter(Boolean);
    let disposition = 'scope-review-required';
    let reason = 'Product, runner or unclassified changes need a separate governed scope; this pilot cannot authorize them.';
    if ((entry.oldPath && !isRegular(entry.oldMode)) || (entry.newPath && !isRegular(entry.newMode))) {
      reason = 'Symlink, submodule or non-regular changes cannot qualify readiness repair.';
    } else if (paths.every(value => projected.has(value))) {
      disposition = 'approved-configuration-input'; reason = 'Exact pinned configuration projection, not repair output.';
    } else if (paths.every(value => inRoot(value, ownedRoot))) {
      disposition = 'story-owned-evidence'; reason = 'Story metadata remains subject to its snapshot and governed transaction checks.';
    } else if (paths.every(documentation)) {
      disposition = 'documentation'; reason = 'Conventional top-level project notes.';
    } else if (paths.some(testPath)) {
      if (entry.status === 'added' && isTestSourceName(name)) {
        disposition = 'added-test'; reason = 'New executable test; existing test sources remain byte-identical.';
      } else reason = 'Changing, deleting, moving or replacing baseline tests/fixtures could weaken their meaning; exact governed scope review is unavailable in this pilot.';
    } else if (path.posix.basename(name) === 'package.json' && entry.status === 'modified'
      && dependencyOnly(readFileAt(root, baseCommit, name), readFileAt(root, repairCommit, name))) {
      disposition = 'dependency-configuration'; reason = 'Only dependency values/additions changed; scripts and all other manifest fields are unchanged.';
    } else if (['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'].includes(path.posix.basename(name))
      && ['added', 'modified'].includes(entry.status)) {
      const manifest = path.posix.join(path.posix.dirname(name), 'package.json');
      if (dependencyOnly(readFileAt(root, baseCommit, manifest), readFileAt(root, repairCommit, manifest))) {
        disposition = 'dependency-lock'; reason = 'Lock repair retains the manifest execution contract; the reviewed runner uses its frozen install.';
      }
    }
    return { ...entry, disposition, reason };
  });
  const blockers = entries.filter(entry => entry.disposition === 'scope-review-required');
  return { schemaVersion: 1, baseCommit, repairCommit, changeSetSha256: changed.digest,
    status: blockers.length ? 'scope-review-required' : 'bounded-readiness-repair', entries, blockers,
    testSourceRetention: blockers.some(entry => [entry.oldPath, entry.newPath].filter(Boolean).some(testPath))
      ? 'unavailable' : 'existing-sources-byte-identical' };
}

/** Baseline identities must survive as identities, not merely matching counts. */
export function assertTrpRepairCohortRetained(originalBaseline, current, { preview = false } = {}) {
  if (!originalBaseline) return { status: 'original-cohort-unknown', basis: 'unchanged-source-and-command-scope' };
  const tools = originalBaseline.testTools;
  const original = originalBaseline.testObservations;
  const contract = current.structuredTestContract?.commands;
  if (!Array.isArray(tools) || !tools.length || !Array.isArray(contract)
    || trpDigest(tools) !== trpDigest(contract)) fail('The original test execution contract is not preserved; reviewed command amendment is unavailable in this repair pilot.');
  if (!Array.isArray(original) || !original.length || original.some(observation =>
    observation.status !== 'available' || observation.testIdentitiesComplete !== true
    || observation.testCasesTruncated || !observation.testCases?.length)) {
    fail('The original baseline cohort is incomplete or ambiguous; this pilot cannot prove that its tests were retained.');
  }
  if (preview) return { status: 'complete-original-cohort', commands: tools.map(tool => tool.id),
    testIds: original.flatMap(observation => observation.testCases.map(test => test.id)) };
  for (const observation of original) {
    const match = (current.testObservations ?? []).filter(row => row.commandId === observation.commandId);
    if (match.length !== 1 || match[0].testIdentitiesComplete !== true || match[0].testCasesTruncated) {
      fail('The repaired report cannot establish retention of the original cohort.');
    }
    const cases = match[0].testCases ?? [];
    for (const test of observation.testCases) {
      const retained = cases.filter(row => row.id === test.id);
      if (retained.length !== 1 || (test.outcome !== 'skipped' && retained[0].outcome !== 'passed')) {
        fail('An original testcase disappeared, became ambiguous or was skipped instead of passing.');
      }
    }
  }
  return { status: 'original-cohort-retained' };
}
