/** Catalog reads do not load the legacy model/authoring dispatcher. */
import { repoRoot } from '../git.mjs';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { workflowCatalog } from '../workflow-catalog.mjs';
import { listWorkflows } from '../workflow-authoring.mjs';
import { listWorkflowConfigurationProposals } from '../configuration-proposal.mjs';
import { optionBoolean, table } from '../util.mjs';

export async function run({ options }) {
  const root = repoRoot();
  return withApprovedConfigurationRead(root, async () => {
    const catalog = (await workflowCatalog(root)).map(item => ({ ...item, governs: 'story' }));
    const initiatives = (await listWorkflows(root, 'initiative').catch(() => []))
      .map(workflow => ({ ...workflow, status: 'current' }));
    // Pending intent stays visible but non-selectable. Start reads only approved configuration.
    const pending = optionBoolean(options, 'for-start') ? []
      : await listWorkflowConfigurationProposals(root, { includeDiff: false }).catch(() => []);
    const proposed = pending.flatMap(proposal => (proposal.workflows ?? [])
      .filter(workflow => workflow.change === 'added')
      .map(workflow => ({ ...workflow, status: 'pending-review', installed: false,
        proposalBranch: proposal.branch, proposalCommit: proposal.proposalCommit })));
    const both = [...catalog, ...initiatives, ...proposed];
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(both, null, 2));
    return console.log(table(both.map(item => ({
      id: item.id, label: item.label, governs: item.governs, phases: item.phases.length, status: item.status
    })), [
      { key: 'id', label: 'WORKFLOW' }, { key: 'label', label: 'LABEL' },
      { key: 'governs', label: 'GOVERNS' }, { key: 'phases', label: 'PHASES' }, { key: 'status', label: 'STATUS' }
    ]));
  }, { preferAuthority: optionBoolean(options, 'for-start') });
}
