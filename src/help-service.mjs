/**
 * One model-free help service for every Singularity Flow surface.
 *
 * The service returns neutral data: topic bytes, provenance, alternatives, follow-ups and a safe
 * Copilot handoff. CLI, gateway, VS Code Chat and the Help Center adapt that data without resolving
 * the question again. Keeping package-root discovery below this boundary also makes the same code
 * safe in the CLI's ESM process and the extension's CommonJS bundle.
 */
import {
  buildManifest, loadTopics, nearestTopicIds, previewTopic, resolveTopic, sectionOf, sectionsOf,
  TOPICS_DIRECTORY
} from './docs-topics.mjs';
import { docsManifest } from './docs-manifest.mjs';
import { classifyHelpIntent } from './help-intents.mjs';
import { copilotSkillForCommand } from './copilot-guidance.mjs';
import { SingularityFlowError } from './util.mjs';

const HANDLE_PATTERN = /^sfdoc:v1:([a-z0-9]+(?:-[a-z0-9]+)*):([a-f0-9]{12})$/;

export function docsHandle(topic) {
  return `sfdoc:v1:${topic.id}:${topic.sha256.slice(0, 12)}`;
}

export function parseDocsHandle(value) {
  const match = HANDLE_PATTERN.exec(String(value ?? '').trim());
  return match ? { topicId: match[1], shaPrefix: match[2] } : null;
}

export function citationLine(provenance) {
  const commit = provenance.docsSourceCommit ? provenance.docsSourceCommit.slice(0, 7) : 'unstamped';
  return `— topic ${provenance.topic} v${provenance.topicVersion}, docs ${commit}`;
}

export function servedBody(topic, { maxBytes, section } = {}) {
  let body = topic.body;
  if (section) {
    body = sectionOf(topic.body, section);
    if (body === null) {
      throw new SingularityFlowError(
        `Topic '${topic.id}' has no section '${section}'. It offers: ${sectionsOf(topic.body).join(', ') || 'none'}.`,
        { exitCode: 5, code: 'handle.expansion_invalid' }
      );
    }
  }
  const preview = previewTopic(body, maxBytes === undefined || maxBytes === null ? {} : { maxBytes });
  return {
    ...preview,
    handle: preview.truncated ? docsHandle(topic) : null,
    sections: preview.truncated ? sectionsOf(topic.body) : []
  };
}

function provenanceOf(topic, manifest, topics) {
  return {
    topic: topic.id,
    topicVersion: topic.version,
    topicSha256: topic.sha256,
    docsSourceCommit: manifest?.sourceCommit ?? null,
    docsContentSha256: manifest?.contentSha256 ?? null,
    manifestMatch: manifest ? manifest.contentSha256 === buildManifest(topics).contentSha256 : false
  };
}

function publicTopic(topic) {
  return Object.freeze({
    id: topic.id,
    title: topic.title,
    version: topic.version,
    sha256: topic.sha256,
    file: topic.file,
    commands: Object.freeze([...topic.commands]),
    related: Object.freeze([...topic.related]),
    aliases: Object.freeze([...topic.aliases]),
    questions: Object.freeze([...topic.questions])
  });
}

function safeHandoff(topic) {
  const declared = topic.commands[0] ?? null;
  if (!declared) return null;
  const canonical = /^(?:singularity-flow|sflow)\s/.test(declared)
    ? declared.replace(/^sflow\s/, 'singularity-flow ')
    : `singularity-flow ${declared}`;
  const skill = copilotSkillForCommand(canonical, null);
  if (!skill) return null;
  return Object.freeze({ skill, command: canonical });
}

function verifyCatalog(manifest, topics) {
  if (!manifest || !Array.isArray(manifest.topics)) {
    throw new SingularityFlowError('The packaged help catalog has no stamped manifest. Reinstall Singularity Flow.', {
      code: 'DOCS_MANIFEST_MISSING'
    });
  }
  const built = buildManifest(topics);
  const stamped = new Map(manifest.topics.map((entry) => [entry.id, entry]));
  const mismatched = built.topics.filter((entry) => {
    const expected = stamped.get(entry.id);
    return !expected || expected.file !== entry.file || expected.title !== entry.title
      || expected.version !== entry.version || expected.sha256 !== entry.sha256
      || expected.routingSha256 !== entry.routingSha256;
  });
  if (manifest.topicCount !== built.topicCount || manifest.contentSha256 !== built.contentSha256
      || stamped.size !== built.topicCount || mismatched.length) {
    throw new SingularityFlowError(
      `The packaged help catalog does not match its stamped manifest${mismatched.length
        ? ` (${mismatched.slice(0, 3).map((entry) => entry.id).join(', ')})` : ''}. Reinstall Singularity Flow.`,
      { code: 'DOCS_MANIFEST_MISMATCH' }
    );
  }
}

/**
 * Resolve and serve a help request without repository, network, host, or model state.
 *
 * `topicsDirectory` and `manifest` are injection seams for package verification and tests. Normal
 * callers use the exact packaged catalog. A missing or changed manifest is refused before any
 * content is served; the service never labels edited bytes as stamped documentation.
 */
export async function resolveHelp(question, {
  maxBytes, section, topicsDirectory = TOPICS_DIRECTORY, manifest = docsManifest()
} = {}) {
  const started = Date.now();
  const topics = await loadTopics(topicsDirectory);
  verifyCatalog(manifest, topics);
  const query = String(question ?? '').trim();
  const index = Object.freeze(topics.map(publicTopic));
  if (!query) {
    return Object.freeze({
      status: 'index', query: '', helpIntent: 'concept', matchedBy: 'index', candidates: Object.freeze([]),
      topics: index,
      provenance: Object.freeze({
        topic: 'index', topicVersion: 1,
        docsSourceCommit: manifest?.sourceCommit ?? null,
        docsContentSha256: manifest?.contentSha256 ?? null,
        manifestMatch: manifest ? manifest.contentSha256 === buildManifest(topics).contentSha256 : false
      }),
      latencyMs: Date.now() - started
    });
  }

  const resolution = resolveTopic(topics, query);
  const helpIntent = classifyHelpIntent(query) ?? 'concept';
  if (resolution.status !== 'resolved') {
    const candidateIds = resolution.status === 'ambiguous'
      ? resolution.candidates
      : (resolution.candidates.length ? resolution.candidates : nearestTopicIds(topics, query, 3));
    const fallbackIds = candidateIds.length ? candidateIds : topics.slice(0, 3).map((topic) => topic.id);
    const candidates = fallbackIds.map((id) => topics.find((topic) => topic.id === id)).filter(Boolean).map(publicTopic);
    return Object.freeze({
      status: resolution.status === 'ambiguous' ? 'ambiguous' : 'not-found',
      query,
      helpIntent,
      matchedBy: resolution.status === 'ambiguous' ? 'ambiguous' : 'no-match',
      candidates: Object.freeze(candidates),
      topics: index,
      latencyMs: Date.now() - started
    });
  }

  const topic = resolution.topic;
  const served = servedBody(topic, { maxBytes, section });
  const provenance = provenanceOf(topic, manifest, topics);
  const known = new Map(topics.map((entry) => [entry.id, entry]));
  const related = topic.related.map((id) => known.get(id)).filter(Boolean).slice(0, 3).map(publicTopic);
  return Object.freeze({
    status: 'resolved',
    query,
    helpIntent,
    matchedBy: resolution.how,
    topic: publicTopic(topic),
    served: Object.freeze({ ...served }),
    provenance: Object.freeze(provenance),
    citation: citationLine(provenance),
    handle: docsHandle(topic),
    related: Object.freeze(related),
    handoff: safeHandoff(topic),
    candidates: Object.freeze([]),
    topics: index,
    latencyMs: Date.now() - started
  });
}
