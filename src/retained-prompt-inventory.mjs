/** Content-free, bounded disk observation. Neither a provider-usage ledger nor proof of authority. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SingularityFlowError } from './util.mjs';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_PROMPTS = 256;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => String(value ?? '').replace(/^sha256:/, '');
const fail = message => { throw new SingularityFlowError(message, { code: 'PROMPT_INVENTORY_UNSAFE' }); };

async function directory(file, { optional = false } = {}) {
  const stat = await lstat(file).catch(error => error.code === 'ENOENT' && optional ? null : Promise.reject(error));
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('Prompt inventory directories must be regular non-symlink directories.');
  return Boolean(stat);
}

async function boundedRead(file, budget) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Prompt inventory files must be regular non-symlink files.');
  if (stat.size > MAX_FILE_BYTES || stat.size > budget.remaining) fail('Prompt inventory exceeds its finite file or aggregate byte limit.');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.ino !== stat.ino || actual.dev !== stat.dev) fail('Prompt inventory file changed during observation.');
    // A bounded read also handles concurrent growth without allocating an unbounded buffer.
    const limit = Math.min(MAX_FILE_BYTES, budget.remaining);
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > limit) fail('Prompt inventory file grew beyond its byte limit.');
    budget.remaining -= size;
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

function sectionSizes(record, sha256) {
  if (digest(record?.renderedSha256) !== sha256) return null;
  const sections = record.promptBudget?.sections;
  if (!Array.isArray(sections) || sections.some(section =>
    typeof section.id !== 'string' || !Number.isSafeInteger(section.bytes) || section.bytes < 0
    || typeof section.included !== 'boolean')) return null;
  return sections.map(({ id, bytes, included, mandatory }) => ({ id, bytes, included, mandatory: mandatory === true }));
}

export async function retainedPromptInventory(storyDirectory) {
  const root = path.resolve(storyDirectory);
  await directory(root);
  const context = path.join(root, 'context'); const prompts = path.join(context, 'prompts');
  const result = { schemaVersion: 1, resultType: 'retained-prompt-inventory',
    scope: 'selected-story-directory', storyDirectory: root, complete: true,
    prompts: [], duplicatePrompts: [], adjacentCommonPrefixes: [], sections: [],
    providerUsage: 'not-observed', billedSavings: 'not-measured',
    limitations: ['Stored prompt sizes are not provider tokens, deliveries or cache hits.',
      'Receipt digest matching is observational, not an authority or lifecycle verification.'] };
  if (!await directory(context, { optional: true }) || !await directory(prompts, { optional: true })) return result;
  const names = (await readdir(prompts)).filter(name => /^[a-z0-9]+(?:-[a-z0-9]+)*-gen[1-9]\d*\.md$/u.test(name)).sort();
  if (names.length > MAX_PROMPTS) fail('Prompt inventory exceeds its finite prompt-count limit.');
  const budget = { remaining: MAX_TOTAL_BYTES }; const groups = new Map(); const totals = new Map();
  let previous = null;
  for (const name of names) {
    const bytes = await boundedRead(path.join(prompts, name), budget); const sha256 = hash(bytes);
    const receiptFile = path.join(context, name.replace(/\.md$/u, '.json'));
    let receipt = null; let receiptStatus = 'missing';
    try {
      const raw = await boundedRead(receiptFile, budget);
      try { receipt = JSON.parse(raw.toString('utf8')); receiptStatus = 'digest-mismatch'; }
      catch { receiptStatus = 'malformed'; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const sections = sectionSizes(receipt, sha256);
    if (sections) receiptStatus = 'digest-matched';
    result.prompts.push({ path: `context/prompts/${name}`, bytes: bytes.length, sha256, receiptStatus,
      ...(sections ? { sections } : {}) });
    for (const section of sections ?? []) {
      if (!section.included) continue;
      const total = totals.get(section.id) ?? { id: section.id, bytes: 0, occurrences: 0 };
      total.bytes += section.bytes; total.occurrences += 1; totals.set(section.id, total);
    }
    const group = groups.get(sha256) ?? []; group.push(name); groups.set(sha256, group);
    if (previous) {
      let commonBytes = 0;
      while (commonBytes < Math.min(previous.bytes.length, bytes.length)
        && previous.bytes[commonBytes] === bytes[commonBytes]) commonBytes += 1;
      result.adjacentCommonPrefixes.push({ left: previous.name, right: name, commonBytes });
    }
    previous = { name, bytes };
  }
  result.prompts.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
  result.sections = [...totals.values()].sort((left, right) => right.bytes - left.bytes || left.id.localeCompare(right.id));
  result.duplicatePrompts = [...groups].filter(([, names]) => names.length > 1).map(([sha256, names]) => ({ sha256, files: names }));
  return result;
}
