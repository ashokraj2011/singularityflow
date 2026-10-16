/** One pause-aware native Copilot intake preview. Choices are advisory, never creation authority. */
import { copilotModePresentation, readCopilotMode } from '../copilot-mode.mjs';
import { activeWorkspaceFile, readActiveWorkspaceContext, workspaceRegistryFile } from '../workspace-context.mjs';
import { changes, repoRoot } from '../git.mjs';
import { versionLine } from '../build-info.mjs';
import { optionString, SingularityFlowError } from '../util.mjs';
import { validatePortableWorkId } from '../work-id.mjs';
import { resolvePersonalization } from '../personalization.mjs';

export async function readIntakeEntry(options = {}) {
  const mode = readCopilotMode();
  if (mode.paused) return { resultType: 'intake-entry', status: 'paused', paused: true,
    agentInstruction: copilotModePresentation(mode).agentInstruction };
  const workId = optionString(options, 'work-id') ?? optionString(options, 'preflight-story');
  if (!workId) throw new SingularityFlowError('Intake entry requires --work-id or --preflight-story.');
  if (optionString(options, 'work-id') && optionString(options, 'preflight-story')) {
    throw new SingularityFlowError('Choose --work-id for initial choices or --preflight-story for selected-base readiness, not both.');
  }
  validatePortableWorkId(workId);
  const workspace = await readActiveWorkspaceContext(activeWorkspaceFile(), workspaceRegistryFile());
  const base = { resultType: 'intake-entry', workId, paused: false,
    build: versionLine(), workspace: workspace ?? null, creationAuthorized: false };
  if (workspace?.repositoryState && workspace.repositoryState !== 'ready') return { ...base, status: 'workspace-repair-required',
    ready: false, commandGuidance: { copilotCommand: '/sf-workspace',
      command: 'singularity-flow workspace repair --help', modelFreeCommand: null } };
  const root = repoRoot(workspace?.repositoryPath ?? process.cwd());
  base.personalization = resolvePersonalization({ root });
  const dirty = changes(root);
  if (dirty.length) return { ...base, status: 'worktree-review-required', ready: false,
    repositoryPath: root, changes: dirty };
  const { readWorkspaceBranches } = await import('./workspace-branches.mjs');
  const catalog = await readWorkspaceBranches({ ...options, intake: true }, { root });
  return { ...base, ...catalog, resultType: 'intake-entry',
    status: catalog.existingWork && catalog.existingWork.status !== 'new'
      ? 'existing-work' : catalog.preflight?.passed === false ? 'correction-required'
        : catalog.preflight?.passed === true ? 'preflight-ready' : 'choices-ready',
    ready: (!catalog.existingWork || catalog.existingWork.status === 'new') && catalog.preflight?.passed !== false,
    repositoryPath: root, creationAuthorized: false,
    agentInstruction: 'Reuse this packet for pause, workspace, build, clean-tree and catalog facts. Use personalization.replyName literally in replies, never artifacts or approval identity. Ask for explicit base/workflow and policy choices. Do not repeat those lookups. Run selected-base preflight once; Story creation revalidates live authority and repository deltas.' };
}

export async function run(options) { console.log(JSON.stringify(await readIntakeEntry(options), null, 2)); }
