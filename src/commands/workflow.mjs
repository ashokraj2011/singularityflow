/** Small read entry points; authoring and activation keep their original mutation dispatcher. */
import { repoRoot } from '../git.mjs';
import { optionBoolean, requirePositional } from '../util.mjs';
import { configurationReadFromWorker } from '../configuration-read-worker-client.mjs';

export async function run(argv, { positionals, options }) {
  const method = positionals[1];
  if (!['proposals', 'proposal'].includes(method)) return (await import('./legacy.mjs')).run(argv);
  const root = repoRoot();
  const parameters = method === 'proposal'
    ? { branch: requirePositional(positionals, 2, 'workflow proposal branch') }
    : { includeMerged: optionBoolean(options, 'all') };
  const worker = await configurationReadFromWorker(root, method, parameters);
  let value;
  if (worker) value = worker.value;
  else {
    const api = await import('../configuration-proposal.mjs');
    value = method === 'proposal' ? await api.inspectWorkflowConfigurationProposal(root, parameters.branch)
      : await api.listWorkflowConfigurationProposals(root, { includeMerged: parameters.includeMerged, includeDiff: false });
  }
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(value, null, 2));
  if (method === 'proposals') {
    if (!value.length) return console.log('No workflow configuration proposals are waiting.');
    for (const proposal of value) {
      const subjects = (proposal.workflows ?? []).map(entry => `${entry.id} (${entry.change})`).join(', ');
      console.log(`${proposal.branch}  ${proposal.proposalCommit.slice(0, 12)}  ${proposal.merged ? 'merged' : proposal.valid ? 'pending review' : 'blocked'}`);
      if (subjects) console.log(`  workflows: ${subjects}`);
      if (proposal.failure?.message) console.log(`  blocked: ${proposal.failure.message}`);
    }
    return;
  }
  console.log(`${value.branch} (${value.proposalCommit})`);
  console.log(`  target: ${value.targetBranch}@${value.targetCommit}`);
  console.log(`  status: ${value.merged ? 'already merged' : value.valid ? 'ready for review' : 'invalid'}`);
  for (const workflow of value.workflows) console.log(`  ${workflow.change.padEnd(8)} ${workflow.governs} workflow ${workflow.id}`);
  for (const file of value.changedFiles) console.log(`  ${file.status.padEnd(4)} ${file.paths.join(' -> ')}`);
  if (value.invalidFiles.length) console.log(`  refused files: ${value.invalidFiles.join(', ')}`);
}
