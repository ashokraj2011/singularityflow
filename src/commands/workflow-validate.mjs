/**
 * `workflow validate [WORKFLOW] [--json] [--for-start]` — is each workflow correct as the platform
 * judges it (src/workflow-validation.mjs)? The table of clause steps and plan owners, then every
 * problem and warning with where it is, why it matters and how to fix it. Exits 1 when a workflow
 * is not valid, in text and JSON alike. Read-only; `--for-start` reads the configuration new Stories
 * start from.
 */
import { optionBoolean, table } from '../util.mjs';

export async function run(argv, { positionals, options }) {
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot();
  const { withApprovedConfigurationRead } = await import('../approved-configuration-reader.mjs');
  const { validateWorkflows, validationFindingLines } = await import('../workflow-validation.mjs');
  const result = await withApprovedConfigurationRead(root, () => validateWorkflows(root, { workflow: positionals[2] ?? null }),
    { preferAuthority: optionBoolean(options, 'for-start') });
  // The one file a live /sf-fix-workflow turn may write: its change set draft, with its folder made
  // (a host create tool makes no parent folder). A paused Copilot gets none.
  if (result.fixDraft) {
    await import('../workflow-build/store.mjs').then(({ preparePrivateStateFile }) => preparePrivateStateFile(result.fixDraft.changeSetPath)).catch(() => null);
    await import('../copilot-mutation-guard.mjs').then(({ issueFixWorkflowStaging }) => issueFixWorkflowStaging(result.fixDraft.changeSetPath, { root })).catch(() => 0);
  }
  if (!result.valid) process.exitCode = 1;
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  if (result.workflows.length) {
    console.log(table(result.workflows.map((workflow) => ({
      id: workflow.id,
      status: workflow.status,
      clauses: workflow.clausePhases.join(', ') || 'none',
      owners: Object.entries(workflow.owners).map(([code, owner]) => `${code}←${owner}`).join(', ') || 'none',
      reason: workflow.reason ?? ''
    })), [
      { key: 'id', label: 'WORKFLOW' }, { key: 'status', label: 'PLANNED CLAIMS' },
      { key: 'clauses', label: 'CLAUSE PHASES' }, { key: 'owners', label: 'CODE ← PLAN OWNER' },
      { key: 'reason', label: 'REASON' }
    ]));
  }
  const lines = validationFindingLines(result, { people: Boolean(positionals[2]) });
  for (const line of lines) console.log(line);
  console.log(`${result.workflows.length || lines.length ? '\n' : ''}Validated ${result.workflows.length} Story workflow(s): ${result.valid ? 'valid' : 'not valid'}.`);
  if (!result.valid) {
    console.log(`Copilot can draft the fixes with ${result.nextAction.copilotCommand} as one reviewed configuration proposal (Workflow Studio's Check shows the same findings); nothing changes until it is reviewed and activated.`);
  }
}
