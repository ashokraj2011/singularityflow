/** Dispatch status-only JSON without importing submission or human presentation code. */
import { galStatusRepositoryRoot, readStatus } from './status-read.mjs';
import { optionBoolean } from '../util.mjs';
export { galStatusBranchCandidate, galStatusBranch, galStatusRepositoryRoot, galStatusSelection, readStatus } from './status-read.mjs';
const ordinary = options => optionBoolean(options, 'json') && !optionBoolean(options, 'submission-readiness')
  && !optionBoolean(options, 'submit-if-ready') && !optionBoolean(options, 'git-shadow');
export async function load({ options }) {
  if (!ordinary(options)) await import('./status-details.mjs');
}
export async function run(argv, request) {
  if (!ordinary(request.options)) return (await import('./status-details.mjs')).run(argv, request);
  console.log(JSON.stringify(await readStatus(galStatusRepositoryRoot(), request.positionals[1]), null, 2));
}
