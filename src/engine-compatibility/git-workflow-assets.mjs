/** Native closure capture. The compiler owns bodies/digests; the SDK receives only semantic names. */
import path from 'node:path';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { configurationReadScope } from '../configuration-read-scope.mjs';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { summarizeWorkflowAssets, workflowAssetInventory } from '../kernel/workflow-assets.mjs';

export function createGitWorkflowAssetsPort({ root, approved = false } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new SingularityFlowError(
    'Workflow asset capture requires an explicit absolute configuration root.', { code: 'ENGINE_INPUT_INVALID' });
  let captured = null;
  const port = Object.freeze({
    async load(inputs) {
      const capture = async () => {
        const { compileWorkflowBundle } = await import('../workflow-transfer.mjs');
        const bundle = await compileWorkflowBundle(root, inputs.workflowIds);
        const authority = configurationReadScope(root)?.authority;
        const source = ['approved-configuration-ref', 'verified-state-mirror'].includes(authority?.kind)
          && typeof authority.commit === 'string' && authority.commit.length > 0 ? { kind: 'approved-snapshot', revision: authority.commit }
          : { kind: 'working-configuration', revision: null };
        const context = { selection: { workflows: bundle.workflows.map(({ governs, id }) => ({ governs, id })),
          bundleSha256: bundle.bundleSha256, source }, bundle };
        captured = context;
        return context;
      };
      return approved ? withApprovedConfigurationRead(root, capture, { preferAuthority: true }) : capture();
    },
    async read(context) {
      return { bundleSha256: context.bundle.bundleSha256, dependencies: workflowAssetInventory(context.bundle),
        summary: summarizeWorkflowAssets(context.bundle) };
    }
  });
  return Object.freeze({ port, bundle: () => captured?.bundle ?? null });
}
