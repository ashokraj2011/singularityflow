/**
 * `workflow archive|restore|delete` (docs/SPEC-WORKFLOW-RETIREMENT-v1.md). Archive and restore change
 * only the archive list; delete previews an exact plan, and its confirmation saves a backup bundle,
 * checks the Stories that use the workflow, and proposes the removal for review.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SingularityFlowError, optionBoolean, optionString } from '../util.mjs';

function requireSelector(positionals, subcommand) {
  const selector = positionals[2];
  if (!selector) throw new SingularityFlowError(`Name the workflow: singularity-flow workflow ${subcommand} <[story|initiative:]ID>.`, {
    code: 'WORKFLOW_SELECTOR_REQUIRED'
  });
  return selector;
}

const lines = {
  removed: (entry) => `${entry.kind} ${entry.id ?? entry.path}${entry.path && entry.id ? ` (${entry.path})` : ''}`,
  kept: (entry) => `${entry.kind} ${entry.id ?? entry.path}: ${entry.usedBy?.length ? `used by ${entry.usedBy.join(', ')}` : entry.reason}`,
  trimmed: (entry) => `agent ${entry.id} loses ${entry.steps.join(', ')}`,
  cleanups: (entry) => `${entry.kind}${entry.steps ? `: ${entry.steps.join(', ')}` : entry.to ? `: ${entry.from} → ${entry.to}` : ''}`
};

function printDeletePlan(plan, stories) {
  console.log(`Delete preview: ${plan.selector}. Nothing is changed until you confirm and the proposal is activated.`);
  for (const [key, label] of [['removed', 'Removed'], ['kept', 'Kept'], ['trimmed', 'Trimmed'], ['cleanups', 'References cleaned']]) {
    if (!plan[key].length) continue;
    console.log(`  ${label} (${plan[key].length}):`);
    for (const entry of plan[key]) console.log(`    ${lines[key](entry)}`);
  }
  for (const entry of plan.unreadableWorkflows) console.log(`  Could not read ${entry.workflow}; every dependency is kept: ${entry.message}`);
  if (stories?.status === 'checked') {
    if (stories.pinned.length) console.log(`  Stories that keep running on their pinned copy: ${stories.pinned.map((story) => story.id).join(', ')}`);
    if (stories.unchecked.length) console.log(`  Stories whose copy could not be checked here: ${stories.unchecked.map((story) => story.id).join(', ')}`);
    if (stories.unpinned.length) console.log(`  Blocking: unfinished Stories with no pinned copy: ${stories.unpinned.map((story) => story.id).join(', ')}`);
  } else if (stories) console.log(`  Stories were not checked: ${stories.reason}`);
  console.log(`  Confirm plan: ${plan.planSha256}`);
}

async function deleteStories(root, plan) {
  if (plan.governs !== 'story') return { status: 'not-applicable', pinned: [], unpinned: [], unchecked: [] };
  const [{ loadDefinition }, { workflowDeleteStories }] = await Promise.all([import('../config.mjs'), import('../workflow-retirement.mjs')]);
  const definition = await loadDefinition(root).catch(() => ({}));
  return workflowDeleteStories(root, definition, plan.workflowId);
}

/** A machine-local backup of the workflow's complete export bundle, written before the proposal. */
async function backupBundle(root, plan) {
  const [{ exportWorkflowBundle }, { workflowBuildStateRoot }, { realpathSync }] = await Promise.all([
    import('../workflow-transfer.mjs'), import('../workflow-build/store.mjs'), import('node:fs')]);
  let resolved = path.resolve(root);
  try { resolved = realpathSync(resolved); } catch { /* the path as given */ }
  const repository = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const file = path.join(workflowBuildStateRoot(), 'workflow-backups', repository,
    `${plan.governs}-${plan.workflowId}-${stamp}.sflow-workflows.json`);
  const exported = await exportWorkflowBundle(root, [plan.selector], file);
  return { path: exported.outputPath, bundleSha256: exported.bundleSha256 };
}

export async function run(root, positionals, options, { author, printProposal, withApprovedConfigurationRead }) {
  const subcommand = positionals[1];
  const selector = requireSelector(positionals, subcommand);
  const json = optionBoolean(options, 'json');
  const newDefault = optionString(options, 'new-default') ?? null;
  const retirement = await import('../workflow-retirement.mjs');

  if (subcommand === 'archive' || subcommand === 'restore') {
    const restore = subcommand === 'restore';
    const reason = optionString(options, 'reason') ?? null;
    const result = await author({
      operation: `${subcommand}-workflow`, subject: selector.replace(/^(?:story|initiative):/u, ''),
      message: `[configuration] ${subcommand} workflow ${selector}`,
      mutate: (target) => retirement.archiveWorkflowIn(target, { selector, reason, newDefault, restore })
    });
    if (json) return console.log(JSON.stringify(result, null, 2));
    if (printProposal(result)) return;
    console.log(result.changed
      ? `${restore ? 'Restored' : 'Archived'} workflow ${result.governs}:${result.workflowId}${restore ? '' : '; new Stories cannot choose it'}.`
      : `Workflow ${result.governs}:${result.workflowId} is ${restore ? 'not archived' : 'already archived'}; nothing changed.`);
    return;
  }

  const plan = await withApprovedConfigurationRead(root, () =>
    retirement.planWorkflowDelete(root, { selector, newDefault }), { preferAuthority: true });
  const stories = await deleteStories(root, plan);
  if (optionBoolean(options, 'dry-run')) {
    if (json) return console.log(JSON.stringify({ ...plan, stories }, null, 2));
    return printDeletePlan(plan, stories);
  }
  const expectedPlanSha256 = optionString(options, 'confirm');
  if (!expectedPlanSha256) {
    throw new SingularityFlowError(`Preview the delete first with singularity-flow workflow delete ${selector} --dry-run --json, then pass its --confirm plan SHA-256.`, {
      code: 'WORKFLOW_DELETE_CONFIRMATION_REQUIRED', details: { nextAction: { command: `singularity-flow workflow delete ${selector} --dry-run --json` } }
    });
  }
  if (plan.planSha256 !== expectedPlanSha256) {
    throw new SingularityFlowError(`The delete plan changed since its preview. Preview again and confirm exact plan ${plan.planSha256}.`, {
      code: 'WORKFLOW_DELETE_PLAN_STALE', details: { expected: expectedPlanSha256, actual: plan.planSha256,
        nextAction: { command: `singularity-flow workflow delete ${selector} --dry-run --json` } }
    });
  }
  retirement.assertDeleteStoriesClear(stories, plan.workflowId);
  const backup = await withApprovedConfigurationRead(root, () => backupBundle(root, plan), { preferAuthority: true });
  // The proposal is checked with the deletions applied, so a dangling reference fails before review.
  const proposal = retirement.workflowDeleteProposal(plan, { expectedPlanSha256, requireApprovedDestination: optionBoolean(options, 'propose'),
    validate: async (target) => (await import('../editor.mjs')).validateEditorConfiguration(target) });
  const result = await author({
    operation: 'delete-workflow', subject: plan.workflowId, message: `[configuration] delete workflow ${plan.selector}`,
    requireExpectedRemoteAuthority: true, ...proposal
  });
  const output = { ...result, backup, stories };
  if (json) return console.log(JSON.stringify(output, null, 2));
  console.log(`Backup of ${plan.selector}: ${backup.path} (restore it with singularity-flow workflow import "${backup.path}" --dry-run).`);
  if (printProposal(result)) return;
  console.log(`Deleted workflow ${plan.selector}: ${plan.removed.length} objects removed, ${plan.kept.length} kept.`);
}
