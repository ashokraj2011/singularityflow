/**
 * The Epic context a released Story's prompt carries.
 *
 * Epic release copies the approved requirements, the Story specification and the other planning
 * outputs onto the Story branch under singularity/story-context/<WORK-ID>/ and pins each file's
 * SHA-256 in the Story seed (singularity/seeds/<WORK-ID>.yml). Nothing put them in front of the
 * agent: the Story source holds only the title, the description and bare AC IDs. This reads those
 * pinned files, uses only bytes that match the seed's hashes, and renders the Story's allocated
 * requirement and acceptance-criterion text, the Epic's decisions and the Story specification.
 *
 * A file that fails verification is withheld and named, never used and never a new refusal here:
 * Story finalization already refuses until it is restored. A Story with no seed, or a seed with no
 * governed context, has no Epic context.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { posix } from './util.mjs';

// Each part has its own ceiling, so one long Story specification cannot crowd out the allocated
// clauses. A cut part says where its full, verified text is.
const PART_BYTES = Object.freeze({ requirements: 4_000, acceptance: 4_000, decisions: 3_000, specification: 6_000 });
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/u;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function readOptional(file) {
  try { return await readFile(file); }
  catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null; throw error; }
}

/** The bytes of one pinned file when they match its seed hash, else why they were withheld. */
async function verifiedContext(root, record) {
  const relative = posix(String(record.path ?? ''));
  // A seed names files on its own branch; a path that leaves the checkout is never read.
  if (!relative || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
    return { record, withheld: 'its seed path is not inside this checkout' };
  }
  const working = await readOptional(path.join(root, relative));
  if (!working) return { record, withheld: 'it is missing from this checkout' };
  if (sha256(working) === record.sha256) return { record, text: working.toString('utf8') };
  // A Windows checkout may differ from the committed bytes only by line endings.
  const committed = (await import('./documents-read.mjs')).committedDocumentBytes(
    root, relative, { sha256: record.sha256, size: record.bytes }, working);
  if (committed) return { record, text: committed.toString('utf8') };
  return { record, withheld: `it does not match the SHA-256 its seed pins (found \`${sha256(working).slice(0, 12)}\`)` };
}

/** Markdown sections by heading, ignoring headings inside fenced code. */
function headings(lines) {
  const found = [];
  let fence = null;
  lines.forEach((line, index) => {
    const opener = line.match(FENCE)?.[1];
    if (fence) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
      return;
    }
    if (opener) { fence = opener; return; }
    const match = line.match(HEADING);
    if (match) found.push({ index, level: match[1].length, title: match[2] });
  });
  return found;
}

function sectionText(lines, all, heading) {
  const next = all.find((candidate) => candidate.index > heading.index && candidate.level <= heading.level);
  return lines.slice(heading.index, next ? next.index : lines.length).join('\n').trim();
}

/** Each allocated ID's own section (`### REQ-001 …`), and the allocated IDs with none. */
function allocatedSections(text, ids) {
  const lines = text.split(/\r?\n/u);
  const all = headings(lines);
  const sections = [];
  const missing = [];
  for (const id of ids) {
    const exact = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![A-Za-z0-9-])`, 'u');
    const heading = all.find((candidate) => exact.test(candidate.title));
    if (heading) sections.push(sectionText(lines, all, heading));
    else missing.push(id);
  }
  return { text: sections.join('\n\n'), missing };
}

/** Every level-two section whose title names decisions ("Decisions", "Open questions and decisions"). */
function decisionSections(text) {
  const lines = text.split(/\r?\n/u);
  const all = headings(lines);
  return all.filter((heading) => heading.level === 2 && /\bdecisions?\b/iu.test(heading.title))
    .map((heading) => sectionText(lines, all, heading)).join('\n\n');
}

function utf8Prefix(value, maximumBytes) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  const prefix = bytes.subarray(0, end).toString('utf8');
  const lineEnd = prefix.lastIndexOf('\n');
  return (lineEnd > 0 ? prefix.slice(0, lineEnd) : prefix).trimEnd();
}

/** One part: quoted in a fence its own text cannot close, cut at its ceiling with a pointer. */
function renderPart(title, text, maximumBytes, sourcePath) {
  if (!text) return [];
  const kept = utf8Prefix(text, maximumBytes);
  const longest = Math.max(0, ...[...kept.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [
    '', `### ${title}`, '', `${fence}markdown`, kept, fence,
    ...(kept.length < text.length
      ? ['', `Cut at ${maximumBytes} bytes; the full verified text is in \`${sourcePath}\`.`] : [])
  ];
}

/**
 * `{ text, records }` for a released Story, or null. `records` name every pinned file with whether
 * it was verified; `text` is the Markdown appended to the Story's pinned source section.
 */
export async function storyEpicContext(root, workId) {
  const seedRelative = posix(path.join('singularity', 'seeds', `${workId}.yml`));
  const seedBytes = await readOptional(path.join(root, seedRelative));
  if (!seedBytes) return null;
  let seed;
  try { seed = YAML.parse(seedBytes.toString('utf8')); } catch { return null; }
  const story = seed?.story;
  const pinned = Array.isArray(seed?.governedContext)
    ? seed.governedContext.filter((record) => record && typeof record.id === 'string' && typeof record.path === 'string')
    : [];
  if ((story?.workId ?? story?.id) !== workId || !pinned.length) return null;

  const files = await Promise.all(pinned.map((record) => verifiedContext(root, record)));
  const byId = new Map(files.map((file) => [file.record.id, file]));
  const requirementIds = (story.requirements ?? []).filter((id) => typeof id === 'string');
  const acceptanceIds = (story.acceptanceCriteria ?? []).filter((id) => typeof id === 'string');
  const requirementsFile = byId.get('requirements');
  const specificationFile = byId.get('story-specification');
  const requirements = requirementsFile?.text ? allocatedSections(requirementsFile.text, requirementIds) : null;
  const acceptance = requirementsFile?.text ? allocatedSections(requirementsFile.text, acceptanceIds) : null;
  const decisions = requirementsFile?.text ? decisionSections(requirementsFile.text) : '';
  const missing = [...(requirements?.missing ?? []), ...(acceptance?.missing ?? [])];
  const epic = seed.initiative?.id ?? story.epicId ?? 'unknown';

  const lines = [
    '## Pinned Epic context',
    '',
    `- Released by Epic \`${epic}\` as plan \`${story.planId ?? workId}\`. Seed \`${seedRelative}\` pins each file below by SHA-256; only verified bytes are quoted here.`,
    ...files.map((file) => file.withheld
      ? `- \`${file.record.path}\` (${file.record.id}) is withheld: ${file.withheld}. Story finalization refuses until the released file is restored.`
      : `- \`${file.record.path}\` (${file.record.id}) · \`${String(file.record.sha256).slice(0, 12)}\` verified`),
    '- Authority: the allocated clauses, the Epic\'s decisions and the Story specification are approved Epic scope. Refine them; do not contradict them. Their `REQ-`, `AC-` and decision IDs are the Epic\'s, not this Story\'s clause IDs.',
    ...(missing.length ? [`- Allocated but not found in the pinned requirements: ${missing.join(', ')}.`] : []),
    ...renderPart(`Allocated requirements: ${requirementIds.join(', ')}`, requirements?.text, PART_BYTES.requirements, requirementsFile?.record.path),
    ...renderPart(`Allocated acceptance criteria: ${acceptanceIds.join(', ')}`, acceptance?.text, PART_BYTES.acceptance, requirementsFile?.record.path),
    ...renderPart('Epic decisions', decisions, PART_BYTES.decisions, requirementsFile?.record.path),
    ...renderPart('Story specification', specificationFile?.text?.trim(), PART_BYTES.specification, specificationFile?.record.path)
  ];
  return {
    text: lines.join('\n'),
    records: files.map((file) => ({ id: file.record.id, path: file.record.path, sha256: file.record.sha256, verified: !file.withheld }))
  };
}
