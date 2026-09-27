/** Pure bounded local Story-inventory preflight; imports no Git/object/retained readers. */
import { canonicalJson } from './records.mjs';
import { scanEntries } from './secrets.mjs';
import { validatePortableWorkId } from './work-id.mjs';
import { SingularityFlowError } from './util.mjs';

export const SKP_STORY_INVENTORY_LIMITS = Object.freeze({ subjects: 8, historyDepth: 16,
  revisions: 32, references: 2048, page: 64, pageBytes: 256 * 1024,
  outputBytes: 2 * 1024 * 1024, commitBytes: 65536, historyBytes: 2 * 1024 * 1024,
  durationMs: 120_000 });
const SHA = /^sha256:[a-f0-9]{64}$/u;
const REF = /^refs\/(?:heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SKILL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
function fail(message, code = 'SKP_STORY_INVENTORY_INVALID') {
  throw new SingularityFlowError(message, { code });
}
function closed(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Inventory selectors must be closed literal records.');
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(entries).some((key) => typeof key !== 'string' || !fields.includes(key)
      || !Object.hasOwn(entries[key], 'value') || !entries[key].enumerable)) fail('Inventory selectors must be closed literal records.');
  return Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.value]));
}
function validRef(ref) {
  return typeof ref === 'string' && Buffer.byteLength(ref) <= 512
    && (ref === 'HEAD' || REF.test(ref) && !/(?:\.\.|@\{|\/\/|\/$|\.lock(?:\/|$))/u.test(ref));
}

/** Snapshot all literal selectors synchronously; the result grants no read or execution authority. */
export function captureLocalStoryInventoryRequest(request) {
  const input = closed(request, ['skillId', 'packageSha256', 'subjects', 'limit', 'cursor', 'expectedSource']);
  const { skillId, packageSha256, subjects, limit = 32, cursor = 0, expectedSource } = input;
  if (typeof skillId !== 'string' || skillId.length > 128 || !SKILL.test(skillId)
      || packageSha256 !== undefined && (typeof packageSha256 !== 'string' || !SHA.test(packageSha256))
      || expectedSource !== undefined && (typeof expectedSource !== 'string' || !SHA.test(expectedSource))
      || !Number.isSafeInteger(limit) || limit < 1 || limit > SKP_STORY_INVENTORY_LIMITS.page
      || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > SKP_STORY_INVENTORY_LIMITS.references
      || cursor > 0 && expectedSource === undefined || !Array.isArray(subjects)
      || subjects.length < 1 || subjects.length > SKP_STORY_INVENTORY_LIMITS.subjects) {
    fail('Select bounded explicit Story/ref windows and pages; later pages require the complete source digest.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(subjects);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string'
      || key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= subjects.length
        || !Object.hasOwn(descriptors[key], 'value')))) fail('Subject selection must be a literal bounded array.');
  const seen = new Set(); let revisions = 0;
  const selected = [];
  for (let index = 0; index < subjects.length; index += 1) {
    const entry = descriptors[index];
    if (!entry || !Object.hasOwn(entry, 'value')) fail('Subject selection cannot contain missing entries.');
    const { workId, ref = 'HEAD', historyDepth = 1 } = closed(entry.value, ['workId', 'ref', 'historyDepth']);
    if (typeof workId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(workId)
        || !validRef(ref) || !Number.isSafeInteger(historyDepth) || historyDepth < 1
        || historyDepth > SKP_STORY_INVENTORY_LIMITS.historyDepth) fail('Select exact portable Story IDs, local refs and bounded first-parent commit windows.');
    validatePortableWorkId(workId, { code: 'SKP_STORY_INVENTORY_INVALID' });
    const key = canonicalJson([workId, ref]);
    if (seen.has(key)) fail('Inventory selection repeats a Story/ref identity.');
    seen.add(key); revisions += historyDepth;
    selected.push(Object.freeze({ workId, ref, historyDepth }));
  }
  if (revisions > SKP_STORY_INVENTORY_LIMITS.revisions) fail('Requested Story history exceeds the aggregate revision budget.', 'SKP_STORY_INVENTORY_LIMIT');
  const result = { skillId, ...(packageSha256 !== undefined ? { packageSha256 } : {}),
    subjects: Object.freeze(selected), limit, cursor, ...(expectedSource !== undefined ? { expectedSource } : {}) };
  if (scanEntries([{ path: 'story-skill-inventory-request.json', content: canonicalJson(result), forceScan: true }]).findings.length) {
    fail('Credential-shaped inventory metadata cannot be disclosed.', 'SKP_STORY_INVENTORY_DISCLOSURE_BLOCKED');
  }
  return Object.freeze(result);
}

/** CLI preflight parser: explicit comma-separated Story=local-ref pairs, never a ref glob. */
export function parseLocalStoryInventorySubjects(value, historyDepth = 1) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 8192) {
    fail('Select bounded explicit Story=local-ref pairs.');
  }
  const subjects = value.split(',').map((entry) => {
    const parts = entry.split('=');
    if (parts.length !== 2) fail('Each inventory selector must be one exact Story=local-ref pair.');
    return { workId: parts[0], ref: parts[1], historyDepth };
  });
  return captureLocalStoryInventoryRequest({ skillId: 'inventory-selector', subjects }).subjects;
}
