/**
 * SF Guard's foreign-key alarm (SPEC-PSS-v1 REQ-023, M2): after a command a person ran in their own
 * terminal, in a repository that opted in, say so when the approved configuration pins a presence key
 * under their approver ID that this Mac's Secure Enclave does not hold. Someone may have registered a
 * key in their name; the alarm names the revoke route. It warns and never blocks: the command already
 * ran, and an approval with that key still needs its holder's touch.
 *
 * It runs only when a policy file exists, so a repository that never opted in pays one stat call.
 * Every failure is swallowed: the alarm is never the reason a command fails.
 */
import { approverId } from './chain.mjs';

/** Every approver the approved configuration names, by approver ID, with their email and login. */
function approvers(definition) {
  const rows = [];
  for (const authority of Object.values(definition?.approvalAuthorities ?? {})) {
    for (const member of authority?.members ?? []) {
      const id = approverId(member);
      if (id) rows.push({ approver: id, email: String(member.email ?? '').toLowerCase(), login: String(member.githubLogin ?? '').toLowerCase() });
    }
  }
  return rows;
}

/**
 * The alarm's finding for `root`, or null: `{ approver, keyId, seq }` when a key pinned for the person
 * running this is not held by this Mac. `dependencies` replaces the readers (tests only).
 */
export async function foreignPresenceKey(root, dependencies = {}) {
  const [{ readPresencePolicy }, { loadDefinition }, { withApprovedConfigurationRead }, git, keys] = await Promise.all([
    import('./store.mjs'), import('../config.mjs'), import('../approved-configuration-reader.mjs'), import('../git.mjs'), import('./local-keys.mjs')]);
  const { policy, definition } = await withApprovedConfigurationRead(root, async () => ({
    policy: await readPresencePolicy(root), definition: await loadDefinition(root)
  }), { preferAuthority: true });
  if (!policy.folded.enabled || !policy.folded.pins.size) return null;
  const who = (dependencies.identify ?? git.identity)(root, { offline: true });
  const email = String(who?.email ?? '').toLowerCase();
  const login = String(who?.login ?? '').toLowerCase();
  const me = approvers(definition).find((row) => (email && row.email === email) || (login && row.login === login));
  const pin = me ? policy.folded.pins.get(me.approver) : null;
  if (!pin) return null;
  const listing = (dependencies.listIdentities ?? keys.ctkIdentities)();
  if (!listing.available) return null;
  if (listing.identities.some((row) => row.keyId === pin.keyId)) return null;
  return { approver: me.approver, keyId: pin.keyId, seq: pin.since };
}

/** The alarm's words for one finding. */
export function foreignKeyWarning(finding) {
  return [
    '',
    `SF Guard (PSS_FOREIGN_KEY): the presence key pinned for you, ${finding.keyId} (policy event ${finding.seq}), is not held by this Mac.`,
    '  If you registered it on another Mac, take person steps there, or move to a key on this one: singularity-flow guard rotate --key <NEW-KEY-ID>.',
    `  If you never registered it, someone did in your name: revoke it now, singularity-flow guard revoke ${finding.approver} --reason "not my key" (any approver can), then singularity-flow guard status.`,
    ''
  ].join('\n');
}

/** Run the alarm for the repository holding `directory`, writing to `stderr`; never throws. */
export async function presenceAlarm(directory, { stderr = process.stderr } = {}) {
  try {
    const { repoRoot } = await import('../git-execution.mjs');
    const root = repoRoot(directory);
    const finding = await foreignPresenceKey(root);
    if (finding) stderr.write(`${foreignKeyWarning(finding)}\n`);
  } catch { /* the alarm never fails a command */ }
}
