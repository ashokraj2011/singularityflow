/**
 * Resolve the reusable World-Model state authority from approved repository configuration.
 *
 * The ledger owns state publication. `git.remote` is the application-code transport and may point
 * at a different server, so it is only the final configured fallback. Keeping this one pure join
 * prevents read-only UI, gateway, workspace, and planning surfaces from selecting different refs.
 */
export function worldModelStateAuthority(definition = {}, {
  branch: fallbackBranch = null,
  remote: fallbackRemote = null
} = {}) {
  const branch = definition.worldModel?.stateBranch
    ?? fallbackBranch
    ?? definition.ledger?.branch
    ?? 'state';
  const remote = definition.ledger?.remote
    ?? definition.worldModel?.remote
    ?? fallbackRemote
    ?? definition.git?.remote
    ?? 'origin';
  return Object.freeze({ branch, remote });
}
