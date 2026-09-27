/** Explicit cross-repository Story usage over already readable local Git repositories. */
import path from 'node:path';
import { canonicalJson, recordSha256 } from './records.mjs';
import { scanEntries } from './secrets.mjs';
import { SingularityFlowError } from './util.mjs';
import { withLocalReadDeadline, assertLocalReadDeadline } from './local-read-deadline.mjs';
import { captureLocalStoryInventoryRequest, SKP_STORY_INVENTORY_LIMITS } from './skp-story-inventory-request.mjs';
import { lookupLocalStorySkillUsageInventory } from './skp-story-usage-inventory.mjs';

export const SKP_CROSS_REPOSITORY_INVENTORY_LIMITS = Object.freeze({
  repositories: 4, subjects: SKP_STORY_INVENTORY_LIMITS.subjects,
  revisions: SKP_STORY_INVENTORY_LIMITS.revisions,
  references: SKP_STORY_INVENTORY_LIMITS.references,
  page: SKP_STORY_INVENTORY_LIMITS.page,
  pageBytes: SKP_STORY_INVENTORY_LIMITS.pageBytes,
  durationMs: SKP_STORY_INVENTORY_LIMITS.durationMs
});
const SHA = /^sha256:[a-f0-9]{64}$/u;
const digest = (value) => `sha256:${recordSha256(value)}`;

function fail(message, code = 'SKP_CROSS_STORY_INVENTORY_INVALID') {
  throw new SingularityFlowError(message, { code });
}
function closed(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Select closed literal repository inventory records.');
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(entries).some((key) => typeof key !== 'string' || !fields.includes(key)
      || !Object.hasOwn(entries[key], 'value') || !entries[key].enumerable)) {
    fail('Select closed literal repository inventory records.');
  }
  return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.value]));
}
function literalArray(value, maximum) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    fail('Select a bounded nonempty list of exact local repositories.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string'
      || key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length
        || !Object.hasOwn(descriptors[key], 'value')))) {
    fail('Repository selection must be a literal bounded array.');
  }
  return Array.from({ length: value.length }, (_, index) => {
    if (!Object.hasOwn(descriptors[index] ?? {}, 'value')) fail('Repository selection cannot contain missing entries.');
    return descriptors[index].value;
  });
}
function scan(value) {
  if (scanEntries([{ path: 'cross-repository-story-skill-inventory.json', content: canonicalJson(value), forceScan: true }]).findings.length) {
    fail('Credential-shaped inventory metadata cannot be disclosed.', 'SKP_CROSS_STORY_INVENTORY_DISCLOSURE_BLOCKED');
  }
}

/** Snapshot exact repository roots and Story/ref windows before touching any repository. */
export function captureCrossRepositoryStoryInventoryRequest(request) {
  const input = closed(request, ['skillId', 'packageSha256', 'repositories', 'limit', 'cursor', 'expectedSource']);
  const { skillId, packageSha256, repositories, limit = 32, cursor = 0, expectedSource } = input;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SKP_CROSS_REPOSITORY_INVENTORY_LIMITS.page
      || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > SKP_CROSS_REPOSITORY_INVENTORY_LIMITS.references
      || cursor > 0 && expectedSource === undefined
      || expectedSource !== undefined && (typeof expectedSource !== 'string' || !SHA.test(expectedSource))) {
    fail('Select a bounded page; later pages require the complete source digest.');
  }
  const selected = []; const seen = new Set(); let subjects = 0; let revisions = 0;
  for (const value of literalArray(repositories, SKP_CROSS_REPOSITORY_INVENTORY_LIMITS.repositories)) {
    const repository = closed(value, ['root', 'subjects']);
    const root = repository.root;
    if (typeof root !== 'string' || !root.isWellFormed() || Buffer.byteLength(root) > 4096
        || /[\u0000-\u001f\u007f]/u.test(root) || !path.isAbsolute(root)
        || path.normalize(root) !== root || root === path.parse(root).root || seen.has(root)) {
      fail('Select distinct exact absolute local repository roots.');
    }
    seen.add(root);
    const local = captureLocalStoryInventoryRequest({ skillId, packageSha256,
      subjects: repository.subjects, limit: 1, cursor: 0 });
    subjects += local.subjects.length;
    revisions += local.subjects.reduce((sum, entry) => sum + entry.historyDepth, 0);
    selected.push(Object.freeze({ root, subjects: local.subjects }));
  }
  if (subjects > SKP_CROSS_REPOSITORY_INVENTORY_LIMITS.subjects
      || revisions > SKP_CROSS_REPOSITORY_INVENTORY_LIMITS.revisions) {
    fail('Selected repositories exceed the shared Story or revision budget.', 'SKP_CROSS_STORY_INVENTORY_LIMIT');
  }
  const result = Object.freeze({ skillId, ...(packageSha256 === undefined ? {} : { packageSha256 }),
    repositories: Object.freeze(selected), limit, cursor,
    ...(expectedSource === undefined ? {} : { expectedSource }) });
  scan(result);
  return result;
}

/** CLI syntax: exact ABSOLUTE-ROOT#STORY=LOCAL-REF entries; no glob or repository search. */
export function parseCrossRepositoryStoryInventorySubjects(value, historyDepth = 1) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 8192) {
    fail('Select bounded exact ROOT#STORY=local-ref entries.');
  }
  const repositories = []; const byRoot = new Map();
  for (const entry of value.split(',')) {
    const marker = entry.indexOf('#'); const equals = entry.indexOf('=', marker + 1);
    if (marker < 1 || equals <= marker + 1 || entry.indexOf('#', marker + 1) !== -1
        || entry.indexOf('=', equals + 1) !== -1) {
      fail('Each cross-repository selector must be one exact ROOT#STORY=local-ref entry.');
    }
    const root = entry.slice(0, marker);
    const subject = { workId: entry.slice(marker + 1, equals), ref: entry.slice(equals + 1), historyDepth };
    if (!byRoot.has(root)) { const selected = { root, subjects: [] }; byRoot.set(root, selected); repositories.push(selected); }
    byRoot.get(root).subjects.push(subject);
  }
  return captureCrossRepositoryStoryInventoryRequest({ skillId: 'inventory-selector', repositories }).repositories;
}

function localRequest(selected, subjects, extra = {}) {
  return { skillId: selected.skillId, ...(selected.packageSha256 === undefined ? {} : { packageSha256: selected.packageSha256 }),
    subjects, ...extra };
}
async function readLocal(root, request) {
  try { return await lookupLocalStorySkillUsageInventory(root, request); }
  catch (error) {
    if (error?.code === 'SKP_STORY_INVENTORY_SOURCE_CHANGED') {
      fail('A selected local repository changed during inventory; restart at the first page.',
        'SKP_CROSS_STORY_INVENTORY_SOURCE_CHANGED');
    }
    throw error;
  }
}

/** Every requested revision is verified; an unavailable repository refuses the whole result. */
export async function lookupCrossRepositoryStorySkillUsageInventory(request = {}) {
  const selected = captureCrossRepositoryStoryInventoryRequest(request);
  try {
    return await withLocalReadDeadline(SKP_CROSS_REPOSITORY_INVENTORY_LIMITS.durationMs, async () => {
      const first = [];
      for (const repository of selected.repositories) {
        assertLocalReadDeadline();
        first.push(await readLocal(repository.root, localRequest(selected, repository.subjects, { limit: 1, cursor: 0 })));
      }
      const identities = new Set();
      for (const result of first) {
        if (identities.has(result.source.repositoryInstanceId)) fail('One local repository was selected more than once.');
        identities.add(result.source.repositoryInstanceId);
      }
      const subject = { skillId: selected.skillId, packageSha256: selected.packageSha256 ?? null };
      const source = { repositoryOrder: 'explicit-request-order',
        repositories: first.map((result, index) => ({ requestedRoot: selected.repositories[index].root,
          ...result.source, localSourceSha256: result.sourceSha256 })) };
      const sourceSha256 = digest({ subject, source });
      scan({ subject, source });
      if (selected.expectedSource !== undefined && selected.expectedSource !== sourceSha256) {
        fail('The selected repositories, refs or request changed; restart at the first page.',
          'SKP_CROSS_STORY_INVENTORY_SOURCE_CHANGED');
      }
      const total = first.reduce((sum, result) => sum + result.page.total, 0);
      if (total > SKP_CROSS_REPOSITORY_INVENTORY_LIMITS.references) {
        fail('Selected repositories exceed the shared reference budget.', 'SKP_CROSS_STORY_INVENTORY_LIMIT');
      }
      if (selected.cursor > total) fail('The requested cross-repository inventory page does not exist.');
      const observations = first.flatMap((result, repositoryIndex) => result.observations.map((row) => ({ repositoryIndex, ...row })));
      const references = []; let before = 0;
      for (let repositoryIndex = 0; repositoryIndex < first.length; repositoryIndex += 1) {
        const result = first[repositoryIndex]; const count = result.page.total;
        const offset = Math.max(0, selected.cursor - before);
        const take = Math.min(Math.max(0, count - offset), selected.limit - references.length);
        before += count;
        if (!take) continue;
        const local = offset === 0 && take === 1 ? result
          : await readLocal(selected.repositories[repositoryIndex].root,
            localRequest(selected, selected.repositories[repositoryIndex].subjects,
              { limit: take, cursor: offset, expectedSource: result.sourceSha256 }));
        if (local.sourceSha256 !== result.sourceSha256 || local.references.length !== take) {
          fail('A selected local repository changed during inventory; restart at the first page.',
            'SKP_CROSS_STORY_INVENTORY_SOURCE_CHANGED');
        }
        references.push(...local.references.map((row) => ({ repositoryIndex, ...row })));
      }
      // Recheck every selected local source after gathering the global page, including repositories
      // that contributed no rows to it. No repository is fetched or mutated.
      for (let index = 0; index < first.length; index += 1) {
        assertLocalReadDeadline();
        const current = await readLocal(selected.repositories[index].root,
          localRequest(selected, selected.repositories[index].subjects,
            { limit: 1, cursor: 0, expectedSource: first[index].sourceSha256 }));
        if (current.sourceSha256 !== first[index].sourceSha256) {
          fail('A selected local repository changed during inventory; restart at the first page.',
            'SKP_CROSS_STORY_INVENTORY_SOURCE_CHANGED');
        }
      }
      const report = { format: 'sflow-cross-repository-story-skill-inventory/v1', subject, source, sourceSha256,
        permissionEffect: 'none', readScope: { kind: 'explicit-local-repository-story-ref-windows',
          authorization: 'existing-git-repository-read-access', authenticatedPrincipal: 'not-established',
          teamFiltering: 'not-established', network: 'not-contacted' },
        coverage: { selectedWindows: 'complete-for-requested-first-parent-commit-windows',
          retainedClosures: 'verified', acceptedLineage: 'verified-at-each-selected-commit',
          observedRevisions: observations.length,
          matchingRevisions: observations.filter((row) => row.status === 'verified-matching-pin').length,
          otherStories: 'not-searched', otherRefs: 'not-searched', otherRepositories: 'not-searched',
          mergeSideParentInventory: 'not-searched', earlierCommitsBeyondWindows: 'not-searched',
          executionUsage: 'not-assessed', providerPrincipalAndRevocation: 'not-established' },
        observations,
        page: { cursor: selected.cursor, limit: selected.limit, total, returned: references.length,
          nextCursor: selected.cursor + references.length < total ? selected.cursor + references.length : null,
          complete: selected.cursor + references.length >= total }, references };
      const text = canonicalJson(report);
      if (Buffer.byteLength(text) > SKP_CROSS_REPOSITORY_INVENTORY_LIMITS.pageBytes) {
        fail('Cross-repository inventory exceeds its bounded disclosure budget.', 'SKP_CROSS_STORY_INVENTORY_LIMIT');
      }
      scan(report);
      assertLocalReadDeadline();
      return JSON.parse(text);
    });
  } catch (error) {
    if (error?.code === 'LOCAL_READ_DEADLINE_EXCEEDED') {
      fail('The shared cross-repository inventory duration was exhausted; no partial result was returned.',
        'SKP_CROSS_STORY_INVENTORY_LIMIT');
    }
    throw error;
  }
}
