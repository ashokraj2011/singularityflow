/** Temporary, local-object-only Story metadata view. No checkout, transport or user-ref writes. */
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createGitRuntime } from './git-access.mjs';
import { FosGitObjectService } from './fos-object-service.mjs';
import { gitDisabledHooksPath } from './git-isolation-paths.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { normalizeWorkItemRoot } from './work-item-location.mjs';
import { validatePortableWorkId } from './work-id.mjs';
import { removeTemporaryTree, SingularityFlowError } from './util.mjs';

export const EXACT_STORY_REVISION_LIMITS = Object.freeze({ commits: 256, commitBytes: 65536,
  historyBytes: 8 * 1024 * 1024, files: 4096, bytes: 256 * 1024 * 1024,
  objectBytes: 32 * 1024 * 1024, durationMs: 120_000 });
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REF = /^refs\/(?:heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
function fail(message, code = 'SKP_STORY_USAGE_UNAVAILABLE') {
  throw new SingularityFlowError(message, { code });
}
function required(result) {
  if (!result?.ok) {
    const error = new SingularityFlowError('The exact local Story objects are unavailable; no remote was contacted.', {
      code: ['GAL_LIMIT_EXCEEDED', 'GAL_OUTPUT_LIMIT'].includes(result?.code) ? 'SKP_STORY_USAGE_LIMIT' : 'SKP_STORY_USAGE_UNAVAILABLE'
    });
    const outcome = result?.diagnostic;
    if (outcome?.timedOut || outcome?.cancelled || outcome?.outputOverflow || outcome?.signal
        || outcome?.spawnErrorCode || result?.code === 'GAL_CLEANUP_INCOMPLETE') error.temporaryGitCleanupUnproven = true;
    throw error;
  }
  return result.value;
}
function assertNoProcessOverrides() {
  const cleaned = withoutGitProcessOverrides(process.env);
  // Pager/editor and credential-prompt settings cannot run in these fixed, piped local reads.
  // Reject the removed keys that can redirect repository/objects, rewrite commands or write traces.
  const relevant = /^(?:GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|SHALLOW_FILE|REPLACE_REF_BASE|EXEC_PATH|TEMPLATE_DIR|CONFIG.*|TRACE.*|CURL_VERBOSE|REDIRECT_STDERR|EXTERNAL_DIFF))$/iu;
  if (Object.keys(process.env).some((key) => !Object.hasOwn(cleaned, key) && relevant.test(key))) {
    fail('Inherited Git repository, command or trace overrides must be cleared before this exact local Story read.');
  }
}
function safePath(value) {
  return typeof value === 'string' && Buffer.byteLength(value) <= 4096
    && !/[\u0000-\u001f\u007f\\]/u.test(value) && !value.startsWith('/')
    && value.split('/').every((part) => part && part !== '.' && part !== '..'
      && !/[:]/u.test(part) && !/[. ]$/u.test(part)
      && !/^(?:\.git|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}
function metadataPath(relative) {
  return relative === 'workflow.json' || relative.startsWith('config/wfa/')
    || relative.startsWith('context/skill-amendments/');
}

export async function withExactLocalStoryRevision(root, request, callback) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !request
      || Object.keys(request).some((key) => !['ref', 'commit', 'workId'].includes(key))
      || typeof callback !== 'function') fail('An explicit repository and closed Story revision request are required.', 'SKP_STORY_USAGE_INVALID');
  const { ref = 'HEAD', commit = null, workId } = request;
  if (typeof ref !== 'string' || Buffer.byteLength(ref) > 512
      || (ref !== 'HEAD' && (!REF.test(ref) || ref.includes('..') || ref.includes('//')
        || ref.endsWith('/') || ref.endsWith('.lock') || ref.includes('@{')))
      || !WORK_ID.test(workId ?? '') || (commit !== null && (typeof commit !== 'string' || !OID.test(commit)))) {
    fail('Invalid exact local Story revision selector.', 'SKP_STORY_USAGE_INVALID');
  }
  validatePortableWorkId(workId, { code: 'SKP_STORY_USAGE_INVALID' });
  // The retained reader still has fixed HEAD-based legacy local calls. Do not let inherited
  // repository/object/command overrides redirect those calls outside this private projection.
  assertNoProcessOverrides();
  const runtime = required(await createGitRuntime({ deadlineMs: 30_000 }));
  let service = null;
  let scratch = null;
  let retainScratch = false;
  const began = Date.now();
  const budget = () => {
    if (Date.now() - began > EXACT_STORY_REVISION_LIMITS.durationMs) fail('The selected Story exceeds the bounded read duration.', 'SKP_STORY_USAGE_LIMIT');
  };
  try {
    const repository = required(await runtime.openRepository(root));
    const invocation = repository.beginInvocation();
    const observation = ref === 'HEAD' ? required(await invocation.head()) : required(await invocation.resolveRef({ ref }));
    const observedRefCommit = observation.oid;
    const selectedCommit = commit ?? observedRefCommit;
    if (!OID.test(selectedCommit ?? '') || selectedCommit.length !== observedRefCommit.length) fail('The exact selected Story commit is unavailable.');
    service = new FosGitObjectService(repository.identity.nativePath, {
      executable: runtime.identity.path, maxObjectBytes: EXACT_STORY_REVISION_LIMITS.commitBytes
    });
    const commits = new Map();
    const pending = [observedRefCommit];
    let historyBytes = 0;
    while (pending.length) {
      budget();
      const oid = pending.pop();
      if (commits.has(oid)) continue;
      if (commits.size >= EXACT_STORY_REVISION_LIMITS.commits) fail('The selected ref ancestry exceeds the bounded Story read; no partial result was returned.', 'SKP_STORY_USAGE_LIMIT');
      const object = await service.read(oid);
      if (object?.type !== 'commit') fail('The selected Story ref does not identify complete local commit ancestry.');
      historyBytes += object.bytes.length;
      if (historyBytes > EXACT_STORY_REVISION_LIMITS.historyBytes) fail('Story ancestry exceeds its byte budget.', 'SKP_STORY_USAGE_LIMIT');
      const end = object.bytes.indexOf(Buffer.from('\n\n'));
      const headers = end < 0 ? [] : object.bytes.subarray(0, end).toString('utf8').split('\n');
      const tree = /^tree ([a-f0-9]+)$/u.exec(headers[0] ?? '')?.[1];
      const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
      if (!tree || !OID.test(tree) || tree.length !== oid.length || parents.length > 32
          || parents.some((parent) => !OID.test(parent) || parent.length !== oid.length)
          || new Set(parents).size !== parents.length) fail('Story commit ancestry is malformed.');
      commits.set(oid, { tree, parents }); pending.push(...parents);
    }
    if (!commits.has(selectedCommit)) fail('The selected historical commit is not reachable from the selected ref.', 'SKP_STORY_USAGE_COMMIT_NOT_REACHABLE');
    // Traverse only the selected prefix. A large application tree does not require source blobs.
    async function entryAt(treeOid, relative) {
      let tree = treeOid;
      const parts = relative.split('/');
      for (let index = 0; index < parts.length; index += 1) {
        budget();
        const entries = required(await invocation.tree({ oid: tree, recursive: false })).entries;
        const entry = entries.find((value) => value.path.text === parts[index]);
        if (!entry) return null;
        if (index === parts.length - 1) return entry;
        if (entry.objectType !== 'tree' || entry.mode !== '040000') fail('The selected Story path traverses a non-directory Git entry.');
        tree = entry.oid;
      }
      return null;
    }
    const configEntry = await entryAt(commits.get(selectedCommit).tree, 'singularity/workflow.yml');
    if (!configEntry || configEntry.objectType !== 'blob' || !['100644', '100755'].includes(configEntry.mode)
        || configEntry.size > 1024 * 1024) fail('The selected commit has no bounded ordinary workflow definition.');
    const configBytes = required(await invocation.blob(configEntry.oid)).bytes;
    let definition;
    try { definition = YAML.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes)); }
    catch { fail('The selected commit workflow definition is unavailable.'); }
    let workItemRoot;
    try { workItemRoot = normalizeWorkItemRoot(definition?.workItemRoot); }
    catch { fail('The selected commit has no safe governed Story root.'); }
    const prefix = `${workItemRoot}/${workId}`;
    if (!safePath(prefix)) fail('The selected Story path is not portable.', 'SKP_STORY_USAGE_INVALID');
    const reachable = new Set();
    const selectedPending = [selectedCommit];
    while (selectedPending.length) {
      const oid = selectedPending.pop();
      if (reachable.has(oid)) continue;
      reachable.add(oid); selectedPending.push(...commits.get(oid).parents);
    }
    const selectedEntries = [];
    const portablePaths = new Set();
    const treeInventories = new Map();
    const objects = new Map([[configEntry.oid, configEntry.size]]);
    for (const oid of reachable) {
      const story = await entryAt(commits.get(oid).tree, prefix);
      if (!story) continue;
      if (story.objectType !== 'tree' || story.mode !== '040000') fail('The selected Story root is not an ordinary Git tree.');
      let entries = treeInventories.get(story.oid);
      if (!entries) {
        entries = required(await invocation.tree({ oid: story.oid, recursive: true })).entries;
        treeInventories.set(story.oid, entries);
      }
      for (const entry of entries) {
        const relative = entry.path.text;
        if (typeof relative !== 'string' || !metadataPath(relative)) continue;
        if (!safePath(relative) || entry.objectType !== 'blob' || !['100644', '100755'].includes(entry.mode)) fail('The selected retained Story metadata contains an unsafe Git entry.');
        objects.set(entry.oid, entry.size);
        if (objects.size > EXACT_STORY_REVISION_LIMITS.files) fail('The retained Story history exceeds its object budget.', 'SKP_STORY_USAGE_LIMIT');
        if (oid === selectedCommit) {
          const portable = relative.normalize('NFC').toLocaleLowerCase('en-US');
          if (portablePaths.has(portable)) fail('The selected retained Story paths collide on portable filesystems.');
          portablePaths.add(portable);
          selectedEntries.push({ relative: `${prefix}/${relative}`, oid: entry.oid });
        }
      }
    }
    if (!selectedEntries.some((entry) => entry.relative === `${prefix}/workflow.json`)) fail('The selected Story does not exist at the selected commit.', 'SKP_STORY_USAGE_STORY_UNAVAILABLE');
    const total = [...objects.values()].reduce((sum, size) => sum + size, 0);
    if (total > EXACT_STORY_REVISION_LIMITS.bytes || [...objects.values()].some((size) => !Number.isSafeInteger(size)
        || size < 0 || size > EXACT_STORY_REVISION_LIMITS.objectBytes)) fail('The retained Story history exceeds its byte budget.', 'SKP_STORY_USAGE_LIMIT');
    const bytes = new Map();
    const batch = [];
    let batchSize = 0;
    async function flush() {
      if (!batch.length) return;
      for (const entry of required(await invocation.blobs({ oids: batch })).entries) bytes.set(entry.oid, entry.bytes);
      batch.length = 0; batchSize = 0;
    }
    for (const [oid, size] of objects) {
      if (batch.length && (batch.length === 128 || batchSize + size > 32 * 1024 * 1024)) await flush();
      batch.push(oid); batchSize += size;
    }
    await flush();
    budget();
    const objectDirectory = await realpath(path.join(repository.identity.commonDir, 'objects'));
    if (/[\r\n\u0000]/u.test(objectDirectory)) fail('The local object directory cannot be represented safely in an exact projection.');
    scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-usage-'));
    await mkdir(path.join(scratch, '.git/objects/info'), { recursive: true });
    await mkdir(path.join(scratch, '.git/refs/heads'), { recursive: true });
    await writeFile(path.join(scratch, '.git/HEAD'), `${selectedCommit}\n`, { mode: 0o600 });
    await writeFile(path.join(scratch, '.git/config'), '[core]\n\trepositoryformatversion = '
      + (repository.identity.objectFormat === 'sha256' ? '1' : '0') + '\n\tbare = false\n\thooksPath = ' + JSON.stringify(gitDisabledHooksPath()) + '\n'
      + (repository.identity.objectFormat === 'sha256' ? '[extensions]\n\tobjectFormat = sha256\n' : ''), { mode: 0o600 });
    await writeFile(path.join(scratch, '.git/objects/info/alternates'), `${process.platform === 'win32' ? objectDirectory.replaceAll('\\', '/') : objectDirectory}\n`, { mode: 0o600 });
    for (const entry of [{ relative: 'singularity/workflow.yml', oid: configEntry.oid }, ...selectedEntries]) {
      const target = path.join(scratch, entry.relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes.get(entry.oid), { mode: 0o600 });
    }
    assertNoProcessOverrides();
    return await callback(scratch, Object.freeze({ repositoryPath: repository.identity.nativePath,
      repositoryInstanceId: repository.identity.repositoryInstanceId, ref, observedRefCommit,
      commit: selectedCommit, workItemRoot, workflowPath: `${prefix}/workflow.json` }));
  } catch (error) {
    if (error?.temporaryGitCleanupUnproven) retainScratch = true;
    if (error?.code?.startsWith('OBJECT_')) fail('The required local Story ancestry is unavailable; no remote fallback was attempted.');
    throw error;
  } finally {
    if (service) {
      const outcome = await service.close();
      if (outcome?.terminated !== true) {
        retainScratch = true;
        await runtime.dispose();
        fail('The local Story object reader did not prove process cleanup; temporary projection was retained.');
      }
    }
    await runtime.dispose();
    if (scratch && !retainScratch) await removeTemporaryTree(scratch);
  }
}
