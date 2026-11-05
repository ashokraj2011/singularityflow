/** A new request from a committed Story. No phase state or execution authority is copied. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { buildRepositorySubjectIndex, buildRepositorySubjectIndexFromRefs, resolveContext } from './repository-subject-index.mjs';
import { committedFilesAtRevisions, fetchMissingBlobs, fetchRemote, gitCommonDir, head, refHead } from './git.mjs';
import { normalizeWorkSource } from './work-source.mjs';
import { assertCredentialFreeRemote } from './git-remote-diagnostics.mjs';
import { SingularityFlowError } from './util.mjs';

export function storyCloneDraft(workflow, source, { commit, documents = [] } = {}) {
  if (!workflow?.workItem?.id || !source || typeof source !== 'object' || Array.isArray(source)) {
    throw new SingularityFlowError('The selected Story has no usable committed request.', { code: 'STORY_CLONE_SOURCE_UNAVAILABLE' });
  }
  const normalized = normalizeWorkSource(source);
  const { id, branch, workType, baseBranch, repositoryBases = [] } = workflow.workItem;
  const request = {
    ...normalized, type: 'manual', id: null, key: null, stableId: null, url: null,
    rawRef: null, fetchedAt: null, epicId: null, status: '', assignee: '', subtasks: []
  };
  delete request.contentSha256;
  delete request.attachments;
  request.acceptanceCriteria = normalized.acceptanceCriteria.map(text => `- ${text}`).join('\n');
  // A clone is a manual request, never another observation of the original tracker item.
  request.notes = [request.notes, `Request copied from Story ${id} at ${commit}.`,
    documents.length ? 'Supporting documents were not copied. Attach needed documents and images to this new Story.' : null
  ].filter(Boolean).join('\n\n');
  return {
    schemaVersion: 1, resultType: 'story-clone-draft', // schema-transient: editable intake data only
    source: { workId: id, branch, commit,
      sha256: createHash('sha256').update(JSON.stringify(source)).digest('hex') },
    request,
    defaults: { workType, baseBranch, repositoryBases: repositoryBases.map(entry => ({
      repositoryId: entry.repositoryId ?? entry.id ?? entry.repository, baseBranch: entry.baseBranch
    })).filter(entry => entry.repositoryId && entry.baseBranch),
    referenceRepositories: (workflow.resolution?.referenceRepositories ?? []).map(entry => ({
      id: entry.id, repository: assertCredentialFreeRemote(entry.repository), branch: entry.requestedBranch
    })),
    specifications: (source.specification ?? []).map(slice => `${slice.revision}=${slice.clauses.map(clause =>
      clause.anchor.replace(/^\[/u, '').replace(/\]$/u, '').split(':').slice(1).join(':')).join(',')}`),
    dependencyReason: (source.specification ?? []).map(slice => slice.partialDependency?.reason).filter(Boolean).join('; ') || null,
    targetUrl: source.targetOrigin ?? null },
    documents: documents.filter(entry => entry.status !== 'detached').map(entry => ({
      name: entry.name ?? entry.label ?? entry.sourceName ?? entry.id, store: entry.store ?? entry.storage ?? null
    })),
    notice: 'Starts a new Story at its first phase under current configuration. Review its name, ID, workflow and bases. Attach any required documents again; completed work, evidence, decisions and approvals stay with the original Story.'
  };
}

/**
 * A new workspace is a partial clone. Fetching a Story's branch brings its commits and trees, not its
 * files, and the index below reads without downloading, so Clone Story failed right after mapping.
 * Exactly the files this read uses come down: the two definitions and the Story's own records.
 */
function fetchStoryRecords(root, commit, workId) {
  const records = new Set(['workflow.json', 'source.json', 'documents.json'].map(file => `/${workId}/${file}`));
  fetchMissingBlobs(root, commit, file => file === 'singularity/workflow.yml' || file === 'singularity/portfolio.yml'
    || records.has(file.slice(file.lastIndexOf('/', file.lastIndexOf('/') - 1))));
}

export async function readStoryClone(root, reference, { expectedCommit = null } = {}) {
  const definitionText = await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8')
    .catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const definition = (definitionText ? YAML.parse(definitionText) : null) ?? {};
  let selected = resolveContext(await buildRepositorySubjectIndex(root, { definition }), { reference, kind: 'story', required: false });
  if (!selected) {
    // A catalog row can be remote-only. Read its state pointer, then that one committed Story;
    // never scan application branches, walk history, attach, or switch the launch checkout.
    const { ledgerStoryPointers } = await import('./ledger.mjs');
    const { normalizeLedgerConfig } = await import('./ledger-config.mjs');
    const ledger = normalizeLedgerConfig(definition.ledger ?? {});
    const roster = await ledgerStoryPointers(root, ledger, { offline: true });
    const matches = roster.items.filter(item => item.id === reference || item.branch === reference
      || item.story?.aliases?.includes(reference));
    if (matches.length !== 1) throw new SingularityFlowError(matches.length
      ? 'The original Story reference is ambiguous. Choose its exact Story ID.' : `Story '${reference}' is not in the state index. Refresh Stories and retry.`,
    { code: 'STORY_CLONE_SOURCE_UNAVAILABLE' });
    const pointer = matches[0];
    if (!refHead(root, `${pointer.commitOid}^{commit}`)) await fetchRemote(root, ledger.remote, {
      branches: [pointer.branch], respectPartialClone: true
    });
    fetchStoryRecords(root, pointer.commitOid, pointer.id);
    const index = await buildRepositorySubjectIndexFromRefs(root, {
      definition, refs: [{ ref: pointer.commitOid, branch: pointer.branch }]
    });
    selected = resolveContext(index, { reference: pointer.id, kind: 'story', required: false });
    if (!selected) throw new SingularityFlowError('The indexed original Story could not be read from its committed source. '
      + index.unreadable.map(entry => entry.reason).join('; '),
    { code: 'STORY_CLONE_SOURCE_UNAVAILABLE', details: { workId: pointer.id, commit: pointer.commitOid, unavailable: index.unreadable } });
  }
  const observedCommit = selected.location.commit ?? head(root);
  if (expectedCommit && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(expectedCommit)) throw new SingularityFlowError(
    'The clone request snapshot must name a full commit returned by the clone preview.', { code: 'STORY_CLONE_SOURCE_UNAVAILABLE' });
  const commit = expectedCommit ?? observedCommit;
  // A phase can advance while this form is open. Its committed request snapshot stays usable;
  // copying input never carries old lifecycle authority into the fresh Story.
  if (commit !== observedCommit) {
    fetchStoryRecords(root, commit, selected.id);
    const index = await buildRepositorySubjectIndexFromRefs(root, { definition,
      refs: [{ ref: commit, branch: selected.canonicalBranch }] });
    selected = resolveContext(index, { reference: selected.id, kind: 'story', required: false });
    if (!selected) throw new SingularityFlowError('The selected original request snapshot is unavailable. Keep the draft and reopen Clone Story.',
      { code: 'STORY_CLONE_SOURCE_UNAVAILABLE', details: { commit, unavailable: index.unreadable } });
  }
  const directory = path.posix.dirname(selected.location.path);
  if (path.posix.basename(directory) !== selected.id || directory.split('/').some(part => part === '..')
      || path.posix.isAbsolute(directory)) throw new SingularityFlowError('The selected Story has a noncanonical request location.',
    { code: 'STORY_CLONE_SOURCE_UNAVAILABLE' });
  fetchStoryRecords(root, commit, selected.id);
  const files = committedFilesAtRevisions(root, ['source.json', 'workflow.json', 'documents.json'].map(file => ({
    key: file, ref: commit, path: `${directory}/${file}`
  })), { requireCompleteRead: true });
  if (!files.has('source.json') || !files.has('workflow.json')) throw new SingularityFlowError(
    'The original Story request is not available at its indexed commit. Refresh Stories or restore the missing Git objects, then retry Clone Story.',
    { code: 'STORY_CLONE_SOURCE_UNAVAILABLE' });
  const workflow = JSON.parse(files.get('workflow.json').toString('utf8'));
  if (workflow.workItem?.id !== selected.id) throw new SingularityFlowError('The clone source does not match the selected Story.',
    { code: 'STORY_CLONE_SOURCE_UNAVAILABLE' });
  const documents = files.has('documents.json') ? JSON.parse(files.get('documents.json').toString('utf8')).documents ?? [] : [];
  return { ...storyCloneDraft(workflow, JSON.parse(files.get('source.json').toString('utf8')), { commit, documents }),
    repository: { path: root, commonDirectory: gitCommonDir(root) } };
}

/** Defaults remain editable; ordinary start validates the selected base and today's workflow. */
export function cloneStartOptions(draft, options) {
  const bases = draft.defaults.repositoryBases;
  return {
    ...(!options['work-type'] ? { 'work-type': draft.defaults.workType } : {}),
    ...(!options['from-branch'] && !options.base ? {
      'from-branch': bases.length > 1 ? bases.map(entry => `${entry.repositoryId}=${entry.baseBranch}`) : draft.defaults.baseBranch
    } : {}),
    ...(!options['reference-repository'] && draft.defaults.referenceRepositories.length ? {
      'reference-repository': draft.defaults.referenceRepositories.map(entry => `${entry.id}=${entry.repository}`),
      'reference-branch': draft.defaults.referenceRepositories.map(entry => `${entry.id}=${entry.branch}`)
    } : {}),
    ...(!options.spec && draft.defaults.specifications.length ? {
      spec: draft.defaults.specifications,
      ...(draft.defaults.dependencyReason ? { 'allow-partial-dependency': true, reason: draft.defaults.dependencyReason } : {})
    } : {}),
    ...(!options['target-url'] && draft.defaults.targetUrl ? { 'target-url': draft.defaults.targetUrl } : {}),
    ...options
  };
}
