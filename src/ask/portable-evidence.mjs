import { typedRevision } from '../git-access.mjs';
import { branch as checkoutBranch, GitRemoteSession } from '../git-execution.mjs';
import { configuredRemoteAuthority, configuredRemoteIdentity } from '../git-remote-diagnostics.mjs';
import { fetchRemote, isAncestor } from '../git.mjs';
import { normalizeLedgerConfig } from '../ledger-config.mjs';
import { recordSha256 } from '../records.mjs';
import { isGitRefName } from '../util.mjs';
import { failure, repositoryScope } from './shared-contract.mjs';

const unavailable = () => failure('ASK_SHARED_SOURCE_UNAVAILABLE', 'The published source could not be verified in this checkout.');
const localOnly = () => failure('ASK_EVIDENCE_LOCAL_ONLY', 'This evidence is available only on the device and checkout where it was saved.');
const gitBranch = name => typeof name === 'string' && isGitRefName(name) && !name.startsWith('refs/');

export function askRemote(root, remote, env) {
  const identity = configuredRemoteIdentity(root, remote, { direction: 'fetch', env });
  const url = configuredRemoteAuthority(root, remote, { direction: 'fetch', env }).url;
  if (!identity.configured || identity.ambiguous || !url) throw unavailable();
  const repository = repositoryScope(identity.url);
  if (repository !== repositoryScope(url)) throw unavailable();
  return { remote, url, repository };
}

async function workStateAt(root, ref, tip) {
  const { retainedSubjectAtCommit } = await import('./retained-history.mjs');
  const proof = retainedSubjectAtCommit(root, { kind: ref.workKind, id: ref.workId, commit: tip });
  if (proof.status !== 'present') throw unavailable();
  return proof.entry;
}

export async function workAt(root, ref, tip) {
  const { state, location, canonicalBranch } = await workStateAt(root, ref, tip);
  const phase = state.currentPhase ?? null;
  const active = state.phases?.[phase];
  return { id: ref.workId, kind: ref.workKind, branch: canonicalBranch, phase, phaseLabel: active?.label ?? phase,
    title: state.workItem?.title ?? state.initiative?.title ?? ref.workId,
    status: active?.status ?? null, workStatus: state.state ?? state.status ?? state.workItem?.status ?? state.initiative?.status ?? null,
    generation: active?.generation ?? 0, blockers: [], recordPath: location.path, recordCommit: tip, recordSha256: recordSha256(state) };
}

/** Publication proofs live for one user action. Cached tracking refs are never access proofs. */
export function portableSources(root, primary, env) {
  const session = new GitRemoteSession({ cwd: root, env });
  const tips = new Map();
  const verified = new Map();
  let ledger;
  let defaultBranch;
  async function observe(remote, name) {
    const key = JSON.stringify([remote.url, name]);
    if (!tips.has(key)) tips.set(key, (async () => {
      const ref = 'refs/heads/' + name;
      const observed = await session.observeAsync(remote.url, { refs: [ref], includeHead: false });
      if (!observed.ok) throw unavailable();
      const tip = observed.refs.get(ref);
      if (!tip) return null;
      if (!typedRevision(root, tip)) {
        await fetchRemote(root, remote.remote, { branches: [name], transportRemote: remote.url });
        if (!typedRevision(root, tip)) throw unavailable();
      }
      return tip;
    })());
    return tips.get(key);
  }
  const contains = (commit, tip) => Boolean(tip && commit && (commit === tip || isAncestor(root, commit, tip)));
  async function currentLedger() {
    ledger ??= (async () => {
      const { definitionLedgerConfig } = await import('../subject-identity-records.mjs');
      const config = normalizeLedgerConfig(await definitionLedgerConfig(root));
      const remote = config.remote === primary.remote ? primary : askRemote(root, config.remote, env);
      if (remote.repository !== primary.repository || !gitBranch(config.branch)) throw unavailable();
      return { remote, config };
    })();
    return ledger;
  }
  async function stateBinding(namespace) {
    const { remote, config } = await currentLedger();
    if (namespace && (!config.enabled || namespace !== config.remote + '/' + config.branch)) throw unavailable();
    return { kind: 'state', remote: config.remote, branch: config.branch, repository: remote.repository };
  }
  async function stateTip(source, snapshot) {
    const { remote, config } = await currentLedger();
    if (source.remote !== config.remote || source.branch !== config.branch || source.repository !== remote.repository) throw unavailable();
    const tip = await observe(remote, source.branch);
    if (!tip || (snapshot && !contains(snapshot, tip))) throw unavailable();
    return tip;
  }
  async function readSpecification(_root, reference, { pin } = {}) {
    const [source, library, ids] = await Promise.all([
      stateBinding(), import('../spec-library/library.mjs'), import('../spec-library/ids.mjs')
    ]);
    const { specId, revision } = ids.parseSpecReference(reference);
    const tip = await stateTip(source, pin?.stateCommit);
    const read = (commit, exactRevision) => {
      const view = exactRevision === null ? library.specificationSnapshot(root, commit, { specId })
        : { commit, status: 'available', specs: new Map([[specId, [exactRevision]]]) };
      return library.resolveRevision(root, view, specId, exactRevision, { env: { ...env, GIT_NO_LAZY_FETCH: '1' } });
    };
    const current = read(tip, revision);
    if (!pin) return current;
    if (revision === null || current.manifestSha256 !== pin.manifestSha256 ||
        (pin.contentSha256 && current.manifest.files['spec.md'] !== pin.contentSha256)) throw unavailable();
    const exact = pin.stateCommit === tip ? current : read(pin.stateCommit, revision);
    if (exact.manifestSha256 !== current.manifestSha256) throw unavailable();
    return exact;
  }
  async function names(reference) {
    let name = reference === 'HEAD' ? checkoutBranch(root) : reference;
    if (typeof name === 'string') {
      if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
      if (name.startsWith('refs/remotes/')) name = name.slice('refs/remotes/'.length);
      if (name.startsWith(primary.remote + '/')) name = name.slice(primary.remote.length + 1);
    }
    if (gitBranch(name) && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(name) && name !== 'HEAD') return [name];
    defaultBranch ??= session.observeAsync(primary.url).then(observed => {
      if (!observed.ok || !gitBranch(observed.defaultBranch)) throw unavailable();
      return observed.defaultBranch;
    });
    const primaryBranch = await defaultBranch;
    const active = checkoutBranch(root);
    return [...new Set([...(gitBranch(active) && active !== 'HEAD' ? [active] : []), primaryBranch])];
  }
  async function gitBinding(commits, hints) {
    const branches = [];
    for (const [index, commit] of commits.entries()) {
      const candidates = await names(hints[index]);
      let found;
      for (const candidate of candidates) {
        if (contains(commit, await observe(primary, candidate))) { found = candidate; break; }
      }
      if (!found) return null;
      branches.push(found);
    }
    return { kind: 'git-refs', branches };
  }
  async function gitTips(source, commits) {
    if (source.branches.length !== commits.length) throw unavailable();
    return Promise.all(source.branches.map(async (name, index) => {
      const tip = await observe(primary, name);
      if (!contains(commits[index], tip)) throw unavailable();
      return tip;
    }));
  }
  // Cache proof results within this action; failed or missing results never become access on the next device or request.
  async function verify(link) {
    const { ref, source } = link;
    if (ref.kind === 'local') throw localOnly();
    if (ref.kind === 'unavailable') throw unavailable();
    if (link.local || ref.kind === 'help') return {};
    const key = JSON.stringify([ref, source]);
    if (!verified.has(key)) verified.set(key, (async () => {
      if (ref.kind === 'spec') {
        const expected = await stateBinding();
        if (source.remote !== expected.remote || source.branch !== expected.branch || source.repository !== expected.repository) throw unavailable();
        return { specification: await readSpecification(root, ref.reference, { pin: ref }) };
      }
      if (ref.kind === 'event') {
        const { retainedEventAtSnapshot } = await import('./retained-history.mjs');
        const tip = await stateTip(source, ref.snapshot);
        if (!await retainedEventAtSnapshot(root, { ...ref, snapshot: tip })) throw unavailable();
        return {};
      }
      if (ref.kind === 'diff') { await gitTips(source, [ref.left, ref.right]); return {}; }
      const [tip] = await gitTips(source, [ref.commit]);
      if (ref.kind === 'work') return { currentWork: await workAt(root, ref, tip) };
      return {};
    })());
    return verified.get(key);
  }
  async function bind(link, value) {
    const { ref } = link;
    if (ref.kind === 'help') return link;
    if (ref.kind === 'work' && !ref.commit) {
      const name = value?.work?.branch;
      if (!gitBranch(name)) return null;
      const tip = await observe(primary, name);
      if (!tip) return null;
      let work;
      try { work = await workAt(root, ref, tip); }
      catch { return null; }
      if (work.recordPath !== ref.path || work.recordSha256 !== ref.sha256) return null;
      return { id: link.id, ref: { ...ref, commit: tip }, source: { kind: 'git-refs', branches: [name] } };
    }
    if (ref.kind === 'spec' || ref.kind === 'event') {
      try {
        const bound = { ...link, source: await stateBinding(ref.namespace) };
        await verify(bound);
        return bound;
      } catch { return { id: link.id, ref: { kind: 'unavailable' } }; }
    }
    const candidates = ref.kind === 'diff' ? [value?.comparison?.left.reference, value?.comparison?.right.reference]
      : [ref.kind === 'work' ? value?.work?.branch : value?.history?.scope?.reference];
    const commits = ref.kind === 'diff' ? [ref.left, ref.right] : [ref.commit];
    const source = await gitBinding(commits, candidates);
    if (!source) return ref.kind === 'work' ? { id: link.id, ref: { kind: 'unavailable' } } : null;
    return { ...link, source };
  }
  async function bindHistory(history) {
    const { start, intent } = history;
    if (intent.kind === 'work-history') {
      try {
        const source = await stateBinding(start.namespace);
        await stateTip(source, start.snapshot);
        return { ...history, intent: { kind: intent.kind, mode: intent.mode, workKind: intent.workKind ?? null, workId: intent.workId }, source };
      } catch { return { unavailable: true }; }
    }
    const commits = intent.kind === 'comparison' ? [start.left, start.right] : [start.revision];
    const names = intent.kind === 'comparison' ? [intent.left, intent.right] : [intent.revision];
    const source = await gitBinding(commits, names);
    const normalized = intent.kind === 'commits' ? { kind: intent.kind, revision: intent.revision }
      : { kind: intent.kind, left: intent.left, right: intent.right, path: intent.path ?? null, patch: Boolean(intent.patch) };
    return source ? { ...history, intent: normalized, source } : null;
  }
  async function verifyHistory(history) {
    if (history.unavailable) throw unavailable();
    if (!history.source) return;
    const { start, source } = history;
    if (source.kind === 'state') await stateTip(source, start.snapshot);
    else await gitTips(source, start.revision ? [start.revision] : [start.left, start.right]);
  }
  async function taskPublication(task) {
    const { workId, outcome } = task;
    if (task.status !== 'accepted' || !gitBranch(outcome?.branch) || !workId || !outcome.revision ||
        task.request.target.remote !== primary.remote) return null;
    const ref = { kind: 'work', workKind: 'story', workId, commit: outcome.revision };
    const source = { kind: 'git-refs', branches: [outcome.branch] };
    await gitTips(source, [ref.commit]);
    const { state, location, canonicalBranch } = await workStateAt(root, ref, ref.commit);
    if (canonicalBranch !== outcome.branch || state.executionOrigin?.mode !== 'itw-handoff' ||
        state.executionOrigin.admissionId !== task.id || state.executionOrigin.workId !== workId ||
        state.executionOrigin.requestSha256 !== task.requestSha256) throw unavailable();
    ref.path = location.path;
    ref.sha256 = recordSha256(state);
    return { id: 'ev-' + recordSha256(ref).slice(0, 24), ref, source };
  }
  return { bind, verify, bindHistory, verifyHistory, taskPublication, readSpecification };
}
