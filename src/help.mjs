import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SingularityFlowError } from './util.mjs';

const helpPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'HELP.md');

export function helpTopicId(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function parseHelpDocument(content) {
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? 'Singularity Flow Help';
  const matches = [...content.matchAll(/^##\s+(.+)$/gm)];
  const topics = matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const topicTitle = match[1].trim();
    return { id: helpTopicId(topicTitle), title: topicTitle, content: content.slice(start, end).trim() };
  });
  return { schemaVersion: 1, title, content, topics };
}

export async function loadHelpDocument(topic = null) {
  const document = parseHelpDocument(await readFile(helpPath, 'utf8'));
  if (!topic) return document;
  const requested = helpTopicId(topic);
  const exact = document.topics.find((item) => item.id === requested);
  const candidates = exact ? [exact] : document.topics.filter((item) => item.id.includes(requested) || requested.includes(item.id));
  if (candidates.length !== 1) {
    const suffix = candidates.length > 1 ? ` Matches: ${candidates.map((item) => item.id).join(', ')}.` : '';
    throw new SingularityFlowError(`Unknown or ambiguous help topic '${topic}'.${suffix} Available topics: ${document.topics.map((item) => item.id).join(', ')}.`);
  }
  const selected = candidates[0];
  return { ...document, selectedTopic: selected.id, content: `# ${document.title}\n\n## ${selected.title}\n\n${selected.content}\n` };
}
