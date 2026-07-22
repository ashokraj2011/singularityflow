import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import YAML from 'yaml';
import { SingularityFlowError } from './util.mjs';

function listText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function documentRecords(value, baseDirectory) {
  const entries = value == null ? [] : Array.isArray(value) ? value : [value];
  return entries.map((entry, index) => {
    const item = typeof entry === 'string' ? { value: entry } : entry;
    if (!item || typeof item !== 'object') throw new SingularityFlowError(`Manual story document ${index + 1} must be a path, URL, or object.`);
    const candidate = item.path ?? item.url ?? item.value;
    if (typeof candidate !== 'string' || !candidate.trim()) throw new SingularityFlowError(`Manual story document ${index + 1} requires path or url.`);
    if (/^https?:\/\//i.test(candidate)) return { type: 'url', url: candidate, label: item.label ?? null, kind: item.kind ?? null };
    return { type: 'file', path: path.resolve(baseDirectory, candidate), label: item.label ?? null, kind: item.kind ?? null };
  });
}

function structuredSource(id, value, overrides) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('Manual story file must contain a YAML or JSON object.');
  const source = structuredClone(value);
  delete source.documents;
  source.type = 'manual';
  source.id = id;
  source.key = null;
  source.url ??= null;
  source.title = overrides.title || source.title || id;
  source.description = overrides.description || source.description || source.problem || '';
  source.desiredOutcome = source.desiredOutcome ?? source.outcome ?? '';
  source.acceptanceCriteria = listText(overrides.acceptanceCriteria || source.acceptanceCriteria);
  return source;
}

export async function loadManualStory(id, {
  storyFile = null,
  title = null,
  description = null,
  acceptanceCriteria = null
} = {}) {
  if (!storyFile) {
    return {
      source: structuredSource(id, {}, { title, description, acceptanceCriteria }),
      documents: []
    };
  }

  const absolute = path.resolve(storyFile);
  let content;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new SingularityFlowError(`Manual story file was not found: ${storyFile}`);
    throw error;
  }
  const extension = path.extname(absolute).toLowerCase();
  if (['.md', '.mdx', '.txt'].includes(extension)) {
    const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    return {
      source: structuredSource(id, { title: heading, description: content }, { title, description, acceptanceCriteria }),
      documents: []
    };
  }

  let value;
  try {
    value = extension === '.json' ? JSON.parse(content) : YAML.parse(content);
  } catch (error) {
    throw new SingularityFlowError(`Unable to parse manual story file ${storyFile}: ${error.message}`);
  }
  return {
    source: structuredSource(id, value, { title, description, acceptanceCriteria }),
    documents: documentRecords(value.documents, path.dirname(absolute))
  };
}

export async function promptManualStory(id) {
  if (!input.isTTY || !output.isTTY) {
    if (process.env.NODE_ENV === 'test') return loadManualStory(id);
    throw new SingularityFlowError('Manual intake questions require an interactive terminal. Use --story-file for a prepared story.');
  }
  const io = readline.createInterface({ input, output });
  try {
    console.log('\nEnter manual story details. Leave an optional answer blank to continue.');
    const title = (await io.question(`Title [${id}]: `)).trim() || id;
    const user = (await io.question('User or audience: ')).trim();
    const description = (await io.question('Problem or description: ')).trim();
    const desiredOutcome = (await io.question('Desired outcome: ')).trim();
    const acceptanceCriteria = [];
    console.log('Enter acceptance criteria one at a time. Leave blank when finished.');
    while (true) {
      const criterion = (await io.question(`AC-${String(acceptanceCriteria.length + 1).padStart(3, '0')}: `)).trim();
      if (!criterion) break;
      acceptanceCriteria.push(criterion);
    }
    const source = structuredSource(id, { title, user, description, desiredOutcome, acceptanceCriteria }, {});
    const documents = [];
    console.log('Enter supporting file paths or HTTPS URLs one at a time. Leave blank when finished.');
    while (true) {
      const candidate = (await io.question(`Document ${documents.length + 1}: `)).trim();
      if (!candidate) break;
      documents.push(...documentRecords(candidate, process.cwd()));
    }
    return { source, documents };
  } finally {
    io.close();
  }
}
