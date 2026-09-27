/** Declared skill pins in one explicitly selected, accepted Story Git revision. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withExactLocalStoryRevision } from './git-exact-story-revision.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { scanEntries } from './secrets.mjs';
import { verifyWorkflowSnapshot } from './workflow-snapshots.mjs';
import { validatePortableWorkId } from './work-id.mjs';
import { SingularityFlowError } from './util.mjs';

export const SKP_STORY_USAGE_LIMITS = Object.freeze({ phases: 512, references: 512,
  page: 64, pageBytes: 256 * 1024, observationBytes: 1024 * 1024,
  workflowBytes: 1024 * 1024, revision: 64 });
const SHA = /^sha256:[a-f0-9]{64}$/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const REF = /^refs\/(?:heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const digest = (value) => `sha256:${recordSha256(value)}`;
function fail(message, code = 'SKP_STORY_USAGE_INVALID') {
  throw new SingularityFlowError(message, { code });
}
function scan(value) {
  if (scanEntries([{ path: 'story-skill-usage.json', content: canonicalJson(value), forceScan: true }]).findings.length) {
    fail('Credential-shaped usage metadata cannot be disclosed.', 'SKP_STORY_USAGE_DISCLOSURE_BLOCKED');
  }
}
function requestSnapshot(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(request))
      || Object.keys(request).some((key) => !['workId', 'skillId', 'packageSha256', 'ref', 'commit',
        'snapshotRevision', 'limit', 'cursor', 'expectedSource'].includes(key))) {
    fail('Select one Story and skill with exact revision selectors and bounded pagination.');
  }
  const { workId, skillId, packageSha256, ref = 'HEAD', commit,
    snapshotRevision, limit = 32, cursor = 0, expectedSource } = request;
  if (typeof workId !== 'string' || !WORK_ID.test(workId)
      || typeof skillId !== 'string' || skillId.length > 128 || !SKILL_ID.test(skillId)
      || typeof ref !== 'string' || Buffer.byteLength(ref) > 512
      || (ref !== 'HEAD' && (!REF.test(ref) || ref.includes('..') || ref.includes('//')
        || ref.endsWith('/') || ref.endsWith('.lock') || ref.includes('@{')))
      || (commit !== undefined && (typeof commit !== 'string' || !OID.test(commit)))
      || (packageSha256 !== undefined && (typeof packageSha256 !== 'string' || !SHA.test(packageSha256)))
      || (expectedSource !== undefined && (typeof expectedSource !== 'string' || !SHA.test(expectedSource)))
      || (snapshotRevision !== undefined && (!Number.isSafeInteger(snapshotRevision)
        || snapshotRevision < 1 || snapshotRevision > SKP_STORY_USAGE_LIMITS.revision))
      || !Number.isSafeInteger(limit) || limit < 1 || limit > SKP_STORY_USAGE_LIMITS.page
      || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > SKP_STORY_USAGE_LIMITS.references
      || (cursor > 0 && expectedSource === undefined)) {
    fail('Invalid exact Story revision, selected skill or bounded page; later pages require a source digest.');
  }
  validatePortableWorkId(workId, { code: 'SKP_STORY_USAGE_INVALID' });
  const captured = { workId, skillId, ref, ...(commit !== undefined ? { commit } : {}),
    ...(packageSha256 !== undefined ? { packageSha256 } : {}),
    ...(snapshotRevision !== undefined ? { snapshotRevision } : {}), limit, cursor,
    ...(expectedSource !== undefined ? { expectedSource } : {}) };
  scan(captured);
  return Object.freeze(captured);
}

/**
 * Reads existing local Git objects only. A historical commit must be reachable from the exact
 * selected local ref. Missing ancestry/bytes is unavailable, never absence or a latest fallback.
 * Git object readability is the declared authorization boundary, not a provider principal ACL.
 */
export async function lookupStorySkillUsage(root, request = {}) {
  const selected = requestSnapshot(request);
  return readStorySkillUsage(root, selected);
}

/**
 * Inventory-only observation of one exact accepted Story revision. A verified nonmatching pin is
 * distinct from unavailable retained bytes. This data is not an authority or execution capability.
 * The ordinary selected-Story lookup keeps its original subject-not-pinned refusal and pagination.
 */
export async function inspectStorySkillUsageRevision(root, request = {}) {
  if (Object.keys(request ?? {}).some((key) => ['limit', 'cursor', 'expectedSource'].includes(key))) {
    fail('Inventory revision observations do not accept per-revision pagination.');
  }
  const selected = requestSnapshot(request);
  return readStorySkillUsage(root, selected, { observation: true });
}

async function readStorySkillUsage(root, selected, { observation = false } = {}) {
  return withExactLocalStoryRevision(root, {
    workId: selected.workId, ref: selected.ref, commit: selected.commit ?? null
  }, async (projectionRoot, capturedSource) => {
    // A lookup verifies this exact accepted identity; it does not rerun a mutable author's ID
    // naming policy or let a retained arbitrary regexp become executable read-side work.
    const config = { workItemRoot: capturedSource.workItemRoot };
    const workflowBytes = await readFile(path.join(projectionRoot, capturedSource.workflowPath));
    if (workflowBytes.length > SKP_STORY_USAGE_LIMITS.workflowBytes) {
      fail('The selected Story exceeds the usage lookup budget.', 'SKP_STORY_USAGE_LIMIT');
    }
    let workflow;
    try { workflow = readRecord('story-workflow', new TextDecoder('utf-8', { fatal: true }).decode(workflowBytes)).record; }
    catch { fail('The selected Story has no supported retained record.', 'SKP_STORY_USAGE_UNAVAILABLE'); }
    if (workflow.workItem?.id !== selected.workId || !workflow.workflowSnapshot) {
      fail('The selected Story has no proven retained snapshot; legacy compatibility is not empty skill usage.', 'SKP_STORY_USAGE_UNAVAILABLE');
    }
    const phases = workflow.resolution?.phases;
    if (!Array.isArray(phases) || phases.length > SKP_STORY_USAGE_LIMITS.phases) {
      fail('The selected Story phase closure is unavailable or exceeds the usage budget.',
        Array.isArray(phases) ? 'SKP_STORY_USAGE_LIMIT' : 'SKP_STORY_USAGE_UNAVAILABLE');
    }
    if (selected.snapshotRevision !== undefined && workflow.workflowSnapshot.revision !== selected.snapshotRevision) {
      fail('The selected commit does not contain the requested accepted snapshot revision.', 'SKP_STORY_USAGE_REVISION_MISMATCH');
    }
    const source = { repositoryPath: capturedSource.repositoryPath,
      repositoryInstanceId: capturedSource.repositoryInstanceId, ref: capturedSource.ref,
      observedRefCommit: capturedSource.observedRefCommit, commit: capturedSource.commit,
      workflowPath: capturedSource.workflowPath,
      workflowSha256: `sha256:${createHash('sha256').update(workflowBytes).digest('hex')}`,
      snapshotRevision: workflow.workflowSnapshot.revision,
      snapshotHash: workflow.workflowSnapshot.snapshotHash,
      genesisSnapshotHash: workflow.workflowSnapshot.genesisSnapshotHash };
    const sourceSha256 = digest(source);
    if (selected.expectedSource !== undefined && selected.expectedSource !== sourceSha256) {
      fail('The selected Story source changed; restart pagination from the first page.', 'SKP_STORY_USAGE_SOURCE_CHANGED');
    }
    let retained;
    try {
      retained = await verifyWorkflowSnapshot(projectionRoot, config, workflow, {
        requireAccepted: true, retainBytes: true
      });
    } catch (error) {
      // A refused retained object can name hostile logical IDs/paths in its diagnostic. Such
      // refusal must not become a way to disclose credential-shaped retained metadata either.
      scan({ message: String(error?.message ?? ''), details: error?.details ?? null });
      throw error;
    }
    if (retained.status !== 'ready' || retained.closure !== 'verified' || !retained.manifest || !retained.policy) {
      fail('The selected Story retained closure is not available.', 'SKP_STORY_USAGE_UNAVAILABLE');
    }
    const pin = retained.manifest.skillPackages?.find((entry) => entry.skillId === selected.skillId);
    const matches = Boolean(pin && (selected.packageSha256 === undefined || pin.manifest.packageSha256 === selected.packageSha256));
    if (!matches && !observation) {
      fail('The selected exact skill package is not pinned by this accepted Story revision.', 'SKP_STORY_USAGE_SUBJECT_NOT_PINNED');
    }
    if ((pin?.phaseBindings.length ?? 0) > SKP_STORY_USAGE_LIMITS.references) {
      fail('The selected pin exceeds the bounded usage budget; no partial result was returned.', 'SKP_STORY_USAGE_LIMIT');
    }
    const policyPhases = new Map(retained.policy.phases.map((phase) => [phase.id, phase]));
    const rows = (matches ? pin.phaseBindings : []).map((binding) => {
      const phase = policyPhases.get(binding.phaseId);
      const recorded = Object.hasOwn(workflow.phases ?? {}, binding.phaseId) ? workflow.phases[binding.phaseId] : null;
      return { kind: 'story-phase', phaseId: binding.phaseId, packageBinding: 'exact',
        packageSha256: pin.manifest.packageSha256, contractSha256: binding.contractSha256,
        compilationSha256: binding.compilationSha256, bindingRefsSha256: binding.bindingRefsSha256,
        parserProfile: binding.parserProfile, agentId: phase.defaultAgent,
        recordedPhase: { status: typeof recorded?.status === 'string' ? recorded.status : null,
          generation: Number.isSafeInteger(recorded?.generation) && recorded.generation >= 0 ? recorded.generation : null } };
    });
    if (observation) {
      const report = { format: 'sflow-story-skill-usage-observation/v1',
        subject: { workId: selected.workId, skillId: selected.skillId,
          packageSha256: pin?.manifest.packageSha256 ?? null }, source, sourceSha256,
        status: matches ? 'verified-matching-pin' : pin ? 'verified-other-package' : 'verified-no-selected-pin',
        retainedClosure: 'verified', acceptedLineage: 'verified-at-selected-commit',
        permissionEffect: 'none', executionUsage: 'not-assessed', references: rows };
      if (Buffer.byteLength(canonicalJson(report)) > SKP_STORY_USAGE_LIMITS.observationBytes) {
        fail('The selected revision exceeds the bounded inventory observation budget.', 'SKP_STORY_USAGE_LIMIT');
      }
      scan(report);
      return JSON.parse(canonicalJson(report));
    }
    if (selected.cursor > rows.length) fail('The requested usage page does not exist.');
    const page = rows.slice(selected.cursor, selected.cursor + selected.limit);
    const report = { format: 'sflow-story-skill-usage/v1',
      subject: { workId: selected.workId, skillId: selected.skillId, packageSha256: pin.manifest.packageSha256 },
      source, sourceSha256, permissionEffect: 'none',
      readScope: { kind: 'selected-local-git-story-revision', authorization: 'existing-git-repository-read-access',
        authenticatedPrincipal: 'not-established', teamFiltering: 'not-established', network: 'not-contacted' },
      coverage: { declaredPins: 'complete-within-bounds', retainedClosure: 'verified',
        acceptedLineage: 'verified-at-selected-commit', executionUsage: 'not-assessed',
        otherStories: 'not-searched', otherRepositories: 'not-searched',
        otherHistoricalRevisions: 'not-searched', agentIdOnlyDependencies: 'not-assessed',
        providerPrincipalAndRevocation: 'not-established' },
      page: { cursor: selected.cursor, limit: selected.limit, total: rows.length, returned: page.length,
        nextCursor: selected.cursor + page.length < rows.length ? selected.cursor + page.length : null,
        complete: selected.cursor + page.length >= rows.length }, references: page };
    const text = canonicalJson(report);
    if (Buffer.byteLength(text) > SKP_STORY_USAGE_LIMITS.pageBytes) {
      fail('The selected usage page exceeds its byte budget; select a smaller page.', 'SKP_STORY_USAGE_LIMIT');
    }
    scan(report);
    return JSON.parse(text);
  });
}
