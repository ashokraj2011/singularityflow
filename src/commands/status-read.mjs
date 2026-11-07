/** Compatibility exports; command and warm worker share the registered native status reader. */
export { galStatusBranchCandidate, galStatusBranch, galStatusRepositoryRoot, galStatusSelection,
  retainedStoryPublication, readStatus } from '../engine-compatibility/git-story-status.mjs';
