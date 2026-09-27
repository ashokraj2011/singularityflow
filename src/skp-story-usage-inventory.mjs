/** Explicit local Story/ref history inventory. No ref enumeration, transport or execution. */
import path from 'node:path';
import { createGitRuntime } from './git-access.mjs';
import { FosGitObjectService } from './fos-object-service.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { inspectStorySkillUsageRevision } from './skp-story-usage.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { scanEntries } from './secrets.mjs';
import { SingularityFlowError } from './util.mjs';
import { captureLocalStoryInventoryRequest, SKP_STORY_INVENTORY_LIMITS } from './skp-story-inventory-request.mjs';
import { withLocalReadDeadline, assertLocalReadDeadline, localReadDeadlineRemainingMs,
  localReadDeadlineSignal, localReadDeadlineTimeoutMs } from './local-read-deadline.mjs';
export { parseLocalStoryInventorySubjects, SKP_STORY_INVENTORY_LIMITS } from './skp-story-inventory-request.mjs';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const digest = (value) => `sha256:${recordSha256(value)}`;
function fail(message, code = 'SKP_STORY_INVENTORY_INVALID', cause = null) {
  const cleanupUnproven = cause?.temporaryGitCleanupUnproven === true || cause?.details?.cleanupUnproven === true;
  const temporaryProjectionRetained = cause?.details?.temporaryProjectionRetained === true;
  const refusal = new SingularityFlowError(message
    + (temporaryProjectionRetained ? ' A private temporary projection was retained because process cleanup is unproven.' : ''), {
    code,
    details: cleanupUnproven || temporaryProjectionRetained
      ? { cleanupUnproven, temporaryProjectionRetained } : null
  });
  if (cleanupUnproven) refusal.temporaryGitCleanupUnproven = true;
  throw refusal;
}
function scan(value) {
  if (scanEntries([{ path: 'story-skill-inventory.json', content: canonicalJson(value), forceScan: true }]).findings.length) {
    fail('Credential-shaped inventory metadata cannot be disclosed.', 'SKP_STORY_INVENTORY_DISCLOSURE_BLOCKED');
  }
}
function required(result) {
  if (!result?.ok) {
    const outcome = result?.diagnostic;
    const cleanupUnproven = outcome?.timedOut || outcome?.cancelled || outcome?.outputOverflow
      || outcome?.signal || result?.code === 'GAL_CLEANUP_INCOMPLETE';
    fail('Required local Git refs or objects are unavailable; no remote fallback was attempted.',
      ['GAL_LIMIT_EXCEEDED', 'GAL_OUTPUT_LIMIT'].includes(result?.code) ? 'SKP_STORY_INVENTORY_LIMIT' : 'SKP_STORY_INVENTORY_UNAVAILABLE',
      cleanupUnproven ? { temporaryGitCleanupUnproven: true } : null);
  }
  return result.value;
}
function localEnvironment() {
  const clean = withoutGitProcessOverrides(process.env);
  const redirect = /^(?:GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|SHALLOW_FILE|REPLACE_REF_BASE|EXEC_PATH|TEMPLATE_DIR|CONFIG.*|TRACE.*|CURL_VERBOSE|REDIRECT_STDERR|EXTERNAL_DIFF))$/iu;
  if (Object.keys(process.env).some((key) => !Object.hasOwn(clean, key) && redirect.test(key))) {
    fail('Inherited Git repository, object, command or trace overrides must be cleared before inventory.', 'SKP_STORY_INVENTORY_UNAVAILABLE');
  }
  return clean;
}

/**
 * historyDepth includes the tip and follows only first parents. Other refs, repositories and merge
 * side-parent inventories are not searched. Each selected revision independently proves its full
 * bounded accepted lineage through the existing retained Story reader; a missing Story or corrupt
 * older revision refuses the whole query rather than becoming a silently omitted row.
 */
export async function lookupLocalStorySkillUsageInventory(root, request = {}) {
  const selected = captureLocalStoryInventoryRequest(request);
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('Select one explicit opened local repository.');
  try {
    return await withLocalReadDeadline(SKP_STORY_INVENTORY_LIMITS.durationMs,
      () => readLocalStorySkillUsageInventory(root, selected));
  } catch (error) {
    if (error?.code === 'LOCAL_READ_DEADLINE_EXCEEDED') {
      fail('The shared selected inventory read duration was exhausted; no partial result was returned.', 'SKP_STORY_INVENTORY_LIMIT', error);
    }
    throw error;
  }
}

async function readLocalStorySkillUsageInventory(root, selected) {
  const budget = assertLocalReadDeadline;
  let runtime = null;
  let service = null;
  try {
    budget();
    runtime = required(await createGitRuntime({ trustedEnvironment: localEnvironment(),
      deadlineMs: localReadDeadlineTimeoutMs(30_000), signal: localReadDeadlineSignal() }));
    budget();
    const repository = required(await runtime.openRepository(root));
    const invocation = repository.beginInvocation();
    const refs = new Map();
    for (const { ref } of selected.subjects) {
      budget();
      if (refs.has(ref)) continue;
      const observed = required(ref === 'HEAD' ? await invocation.head() : await invocation.resolveRef({ ref }));
      if (!OID.test(observed.oid ?? '')) fail('A selected local ref has no exact committed tip.', 'SKP_STORY_INVENTORY_UNAVAILABLE');
      refs.set(ref, observed.oid);
    }
    service = new FosGitObjectService(repository.identity.nativePath, {
      executable: runtime.identity.path, maxObjectBytes: SKP_STORY_INVENTORY_LIMITS.commitBytes,
      timeoutMs: localReadDeadlineTimeoutMs(30_000)
    });
    const parsed = new Map(); let historyBytes = 0;
    const readParents = async (oid) => {
      if (parsed.has(oid)) return parsed.get(oid);
      budget();
      const object = await service.read(oid, { signal: localReadDeadlineSignal() });
      budget();
      if (object?.type !== 'commit') fail('Selected history is not complete local commit ancestry.', 'SKP_STORY_INVENTORY_UNAVAILABLE');
      historyBytes += object.bytes.length;
      if (historyBytes > SKP_STORY_INVENTORY_LIMITS.historyBytes) fail('Selected history exceeds its byte budget.', 'SKP_STORY_INVENTORY_LIMIT');
      const end = object.bytes.indexOf(Buffer.from('\n\n'));
      let headers;
      try { headers = end < 0 ? [] : new TextDecoder('utf-8', { fatal: true }).decode(object.bytes.subarray(0, end)).split('\n'); }
      catch { fail('Selected history has malformed commit headers.', 'SKP_STORY_INVENTORY_UNAVAILABLE'); }
      const tree = /^tree ([a-f0-9]+)$/u.exec(headers[0] ?? '')?.[1];
      const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
      if (!OID.test(tree ?? '') || tree.length !== oid.length || parents.length > 32
          || parents.some((parent) => !OID.test(parent) || parent.length !== oid.length)
          || new Set(parents).size !== parents.length) fail('Selected history has malformed commit ancestry.', 'SKP_STORY_INVENTORY_UNAVAILABLE');
      parsed.set(oid, parents);
      return parents;
    };
    const selections = [];
    for (const subject of selected.subjects) {
      const commits = []; let oid = refs.get(subject.ref); let reachedRoot = false;
      for (let depth = 0; depth < subject.historyDepth; depth += 1) {
        if (commits.includes(oid)) fail('Selected history repeats a commit.', 'SKP_STORY_INVENTORY_UNAVAILABLE');
        const parents = await readParents(oid); commits.push(oid);
        if (!parents.length) { reachedRoot = true; break; }
        oid = parents[0];
      }
      selections.push({ ...subject, observedRefCommit: refs.get(subject.ref), commits, reachedRoot });
    }
    const source = { repositoryPath: repository.identity.nativePath,
      repositoryInstanceId: repository.identity.repositoryInstanceId, historyOrder: 'first-parent-tip-first', selections };
    const subject = { skillId: selected.skillId, packageSha256: selected.packageSha256 ?? null };
    const sourceSha256 = digest({ subject, source });
    scan({ subject, source });
    if (selected.expectedSource !== undefined && selected.expectedSource !== sourceSha256) {
      fail('The selected inventory refs or request changed; restart pagination from the first page.', 'SKP_STORY_INVENTORY_SOURCE_CHANGED');
    }
    const observations = []; const rows = []; let rowBytes = 0;
    const verified = new Map(); const retainedStates = new Map();
    for (const selection of selections) for (const commit of selection.commits) {
      budget();
      const key = canonicalJson([selection.workId, selection.ref, commit]);
      let observation = verified.get(key);
      if (!observation) {
        observation = await inspectStorySkillUsageRevision(root, { workId: selection.workId,
          skillId: selected.skillId, ref: selection.ref, commit,
          ...(selected.packageSha256 !== undefined ? { packageSha256: selected.packageSha256 } : {}) });
        budget();
        verified.set(key, observation);
      }
      if (observation.source.repositoryInstanceId !== repository.identity.repositoryInstanceId
          || observation.source.observedRefCommit !== selection.observedRefCommit) {
        fail('A selected local ref changed during retained verification.', 'SKP_STORY_INVENTORY_SOURCE_CHANGED');
      }
      const identity = { workId: selection.workId, ref: selection.ref, commit,
        snapshotRevision: observation.source.snapshotRevision, snapshotHash: observation.source.snapshotHash,
        sourceSha256: observation.sourceSha256 };
      // Aliased refs and empty commits can expose the exact same retained state. Verify each
      // accepted tip, disclose every observation, but do not count its identical usage rows twice.
      // Changed lifecycle record bytes remain distinct, even when the snapshot itself is pinned.
      const stateKey = canonicalJson([selection.workId, observation.source.workflowSha256,
        observation.source.snapshotHash, observation.subject.packageSha256]);
      const duplicate = retainedStates.get(stateKey);
      if (!duplicate) retainedStates.set(stateKey, identity);
      observations.push({ ...identity, status: observation.status,
        packageSha256: observation.subject.packageSha256, references: duplicate ? 0 : observation.references.length,
        ...(duplicate ? { duplicateOf: { ref: duplicate.ref, commit: duplicate.commit, sourceSha256: duplicate.sourceSha256 } } : {}) });
      for (const row of duplicate ? [] : observation.references) {
        const entry = { ...identity, ...row }; rowBytes += Buffer.byteLength(canonicalJson(entry));
        if (rows.length >= SKP_STORY_INVENTORY_LIMITS.references || rowBytes > SKP_STORY_INVENTORY_LIMITS.outputBytes) {
          fail('The selected inventory exceeds its aggregate result budget; no partial success was returned.', 'SKP_STORY_INVENTORY_LIMIT');
        }
        rows.push(entry);
      }
    }
    // A new invocation cannot return an earlier memoized mutable observation. No ref writes occur.
    const finalReads = repository.beginInvocation();
    for (const [ref, commit] of refs) {
      budget();
      const current = required(ref === 'HEAD' ? await finalReads.head() : await finalReads.resolveRef({ ref }));
      if (current.oid !== commit) fail('A selected local ref changed during inventory.', 'SKP_STORY_INVENTORY_SOURCE_CHANGED');
    }
    if (selected.cursor > rows.length) fail('The requested inventory page does not exist.');
    const page = rows.slice(selected.cursor, selected.cursor + selected.limit);
    const report = { format: 'sflow-local-story-skill-inventory/v1', subject, source, sourceSha256,
      permissionEffect: 'none', readScope: { kind: 'explicit-local-story-ref-windows',
        authorization: 'existing-git-repository-read-access', authenticatedPrincipal: 'not-established',
        teamFiltering: 'not-established', network: 'not-contacted' },
      coverage: { selectedWindows: 'complete-for-requested-first-parent-commit-windows',
        retainedClosures: 'verified', acceptedLineage: 'verified-at-each-selected-commit',
        identicalRetainedStates: 'deduplicated-by-story-workflow-bytes-and-snapshot-identity',
        observedRevisions: observations.length, matchingRevisions: observations.filter((row) => row.status === 'verified-matching-pin').length,
        otherStories: 'not-searched', otherRefs: 'not-searched', otherRepositories: 'not-searched',
        mergeSideParentInventory: 'not-searched', earlierCommitsBeyondWindows: 'not-searched',
        executionUsage: 'not-assessed', providerPrincipalAndRevocation: 'not-established' },
      observations, page: { cursor: selected.cursor, limit: selected.limit, total: rows.length,
        returned: page.length, nextCursor: selected.cursor + page.length < rows.length ? selected.cursor + page.length : null,
        complete: selected.cursor + page.length >= rows.length }, references: page };
    const fullBytes = Buffer.byteLength(canonicalJson({ ...report, references: rows }));
    const text = canonicalJson(report);
    if (fullBytes > SKP_STORY_INVENTORY_LIMITS.outputBytes || Buffer.byteLength(text) > SKP_STORY_INVENTORY_LIMITS.pageBytes) {
      fail('The selected inventory exceeds its bounded disclosure budget; no rows were truncated.', 'SKP_STORY_INVENTORY_LIMIT');
    }
    scan({ ...report, references: rows });
    budget();
    return JSON.parse(text);
  } catch (error) {
    if (localReadDeadlineRemainingMs() === 0 || error?.code === 'LOCAL_READ_DEADLINE_EXCEEDED') {
      fail('The shared selected inventory read duration was exhausted; no partial result was returned.', 'SKP_STORY_INVENTORY_LIMIT', error);
    }
    if (error?.code?.startsWith('OBJECT_')) fail('Required local history objects are unavailable; no lazy fetch or remote fallback was attempted.', 'SKP_STORY_INVENTORY_UNAVAILABLE');
    throw error;
  } finally {
    if (service) {
      const outcome = await service.close();
      if (outcome?.terminated !== true) {
        await runtime.dispose();
        fail('The local inventory object reader did not prove process cleanup.', 'SKP_STORY_INVENTORY_UNAVAILABLE',
          { temporaryGitCleanupUnproven: true });
      }
    }
    if (runtime) await runtime.dispose();
  }
}
