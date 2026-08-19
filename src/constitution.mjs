/**
 * One constitution. `[SPK:REQ-090]` … `[SPK:REQ-104]` `[SPK:CON-039]` … `[SPK:CON-044]`
 *
 * A constitution is the standing rules a Story is held to — the things that are true before anyone
 * writes a requirement. Two kinds, and the distinction is the whole design:
 *
 * - An **enforced** article restates a machine policy the kernel already enforces `[SPK:REQ-093]`.
 *   Its prose is *generated* from the effective policy value, so it cannot drift from what the
 *   kernel actually does. A constitution saying "two approvals are required" beside a configuration
 *   requiring one is worse than no constitution: it is a document people trust and shouldn't.
 * - A **judged** article is authored prose about something no policy can check `[SPK:REQ-094]` —
 *   "every change carries a rollback". Nothing here evaluates it. A human records the verdict
 *   `[SPK:CON-044]`, and the article's job is to make sure they are asked.
 *
 * `[SPK:CON-041]` is the load-bearing constraint on the first kind: the prose, the policy reference,
 * the policy value hash, the renderer version and the article hash are generated together, and a
 * hand edit fails validation. Not because editing is disrespectful, but because an enforced article
 * that says something other than what the policy does is a lie the kernel signed.
 *
 * And `[SPK:CON-040]`: this is configuration, not a phase. It has no lifecycle state of its own, is
 * pinned once at Story start `[SPK:REQ-091]`, and an active Story keeps its pin while `sflow/config`
 * moves on `[SPK:CON-039]` — the rules you were held to are the rules that were in force when you
 * started.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

import { canonicalJson, recordSha256 } from './records.mjs';
import { exists, posix, SingularityFlowError } from './util.mjs';

import { currentSchemaVersion } from './schema-migrations.mjs';

export const CONSTITUTION_SCHEMA_VERSION = currentSchemaVersion('constitution-record');

/**
 * The renderer version.
 *
 * Bumped whenever generated prose changes shape. It is part of every enforced article's hash, so an
 * older constitution regenerates to different bytes and the difference is attributable to the
 * renderer rather than looking like a policy change `[SPK:REQ-098]`.
 */
export const RENDERER_VERSION = 1;

export const CONSTITUTION_MODES = Object.freeze(['off', 'warn', 'enforce']);
export const ARTICLE_TYPES = Object.freeze(['enforced', 'judged']);
export const ARTICLE_LEVELS = Object.freeze(['must', 'should']);
export const DEFAULT_CONSTITUTION_PATH = 'singularity/constitution.md';

/** Where generated prose begins and ends, so `generate` can replace exactly that and nothing else. */
const GENERATED = (id) => ({
  start: `<!-- singularity-flow:constitution:generated ${id} -->`,
  end: `<!-- singularity-flow:constitution:generated:end ${id} -->`
});

const ANCHOR = /^#{1,6}\s*\[(?<id>[A-Z][A-Z0-9]*-\d{3,})\]\s*(?<title>.+?)\s*$/;

/**
 * Normalize the `constitution:` block a work type declares.
 *
 * Validated at configuration load. The block shipped in `workflow.yml` from P1 with no validator and
 * no reader — a `mode: enfroce` would have resolved cleanly and governed nothing, which is the
 * failure this product keeps producing and the reason every policy now gets a normalizer.
 */
export function constitutionPolicy(value = {}) {
  if (value == null) return Object.freeze({ mode: 'off', path: DEFAULT_CONSTITUTION_PATH });
  if (typeof value === 'string') value = { mode: value };
  if (typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('constitution must be an object or mode string.');
  for (const key of Object.keys(value)) {
    if (!['mode', 'path'].includes(key)) throw new SingularityFlowError(`constitution contains unknown field '${key}'.`);
  }
  const mode = value.mode ?? 'off';
  if (!CONSTITUTION_MODES.includes(mode)) {
    throw new SingularityFlowError(`constitution.mode must be one of ${CONSTITUTION_MODES.join(', ')}; got '${mode}'.`);
  }
  const relative = posix(String(value.path ?? DEFAULT_CONSTITUTION_PATH));
  if (!relative || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
    throw new SingularityFlowError('constitution.path must be a repository-relative path without "..".');
  }
  return Object.freeze({ mode, path: relative });
}

/** Normalize one declared article. Validation lives here so a malformed one never reaches a reader. */
export function normalizeArticle(value, index) {
  const label = `Constitution article ${value?.id ?? `#${index + 1}`}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${label} must be an object.`);
  const id = String(value.id ?? '').trim();
  if (!/^[A-Z][A-Z0-9]*-\d{3,}$/.test(id)) throw new SingularityFlowError(`${label} needs a stable ID such as ART-001.`);
  const type = value.type;
  if (!ARTICLE_TYPES.includes(type)) throw new SingularityFlowError(`${label} type must be ${ARTICLE_TYPES.join(' or ')}.`);
  const status = value.status ?? 'active';
  if (!['active', 'withdrawn'].includes(status)) throw new SingularityFlowError(`${label} status must be active or withdrawn.`);

  if (type === 'enforced') {
    const policy = String(value.policy ?? '').trim();
    if (!policy) throw new SingularityFlowError(`${label} is enforced and must reference one machine-policy path.`);
    return Object.freeze({
      id, type, status, policy,
      policyValueSha256: value.policyValueSha256 ?? null,
      rendererVersion: Number(value.rendererVersion ?? RENDERER_VERSION),
      articleSha256: value.articleSha256 ?? null,
      ...(value.withdrawnBy ? { withdrawnBy: String(value.withdrawnBy) } : {})
    });
  }
  const level = value.level;
  if (!ARTICLE_LEVELS.includes(level)) throw new SingularityFlowError(`${label} is judged and needs level ${ARTICLE_LEVELS.join(' or ')}.`);
  if (typeof value.evidenceRequired !== 'boolean') {
    throw new SingularityFlowError(`${label} is judged and needs evidenceRequired: true or false.`);
  }
  return Object.freeze({
    id, type, status, level,
    evidenceRequired: value.evidenceRequired,
    articleSha256: value.articleSha256 ?? null,
    ...(value.withdrawnBy ? { withdrawnBy: String(value.withdrawnBy) } : {})
  });
}

/**
 * Read a dotted policy path out of the resolved configuration.
 *
 * A segment against an array resolves by `id` before falling back to an index, because the resolved
 * work type holds its phases as an array of `{ id, … }` and `phases.specification.approval.minimum`
 * is what anyone would write. Index-only lookup returned `undefined` for that path, and an enforced
 * article whose value is undefined renders as "not set in the approved configuration" — a sentence
 * that reads like a deliberate statement about policy rather than a typo in a path.
 */
export function policyValue(resolution, policyPath) {
  return String(policyPath).split('.').reduce((current, key) => {
    if (current === undefined || current === null) return undefined;
    if (!Array.isArray(current)) return current[key];
    if (/^\d+$/.test(key)) return current[Number(key)];
    return current.find((entry) => entry && typeof entry === 'object' && String(entry.id) === key);
  }, resolution);
}

/**
 * Generated prose for an enforced article. `[SPK:REQ-093]`
 *
 * Deliberately flat and slightly mechanical. Prose that reads as though a person wrote it invites
 * a person to improve it, and improving it is the one thing `[SPK:CON-041]` forbids — the sentence
 * has to stay a faithful restatement of a value the kernel reads from somewhere else.
 */
export function renderEnforcedArticle({ policy, value, rendererVersion = RENDERER_VERSION }) {
  if (rendererVersion !== RENDERER_VERSION) {
    throw new SingularityFlowError(`Constitution renderer version ${rendererVersion} is not available; this build renders version ${RENDERER_VERSION}.`);
  }
  const rendered = value === undefined
    ? 'not set in the approved configuration'
    : typeof value === 'object' ? canonicalJson(value) : JSON.stringify(value);
  return [
    `This article is generated from the approved configuration and restates what the kernel enforces.`,
    '',
    `- Policy: \`${policy}\``,
    `- Effective value: ${rendered}`,
    '',
    'Changing this rule means changing the policy through the configuration-authority workflow. Editing',
    'the text here changes nothing the kernel does, so the kernel refuses to read a hand-edited copy.'
  ].join('\n');
}

/**
 * The hash that makes a hand edit detectable. `[SPK:CON-041]`
 *
 * Covers the prose *and* everything the prose was derived from. Editing the sentence changes it;
 * so does changing the policy underneath without regenerating — which is the subtler failure, and
 * the one that leaves a constitution quietly describing last month's rules.
 */
export function articleHash(article, prose) {
  const body = article.type === 'enforced'
    ? {
      id: article.id, type: article.type, policy: article.policy,
      policyValueSha256: article.policyValueSha256, rendererVersion: article.rendererVersion, prose
    }
    : { id: article.id, type: article.type, level: article.level, evidenceRequired: article.evidenceRequired, prose };
  return recordSha256(body);
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value ?? null)).digest('hex');
}

function splitFrontMatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) throw new SingularityFlowError('The constitution needs YAML front matter listing its articles.');
  return { frontMatter: match[1], body: markdown.slice(match[0].length) };
}

/**
 * The visible body of each article, keyed by ID.
 *
 * `[SPK:REQ-095]` allows metadata in front matter but insists the readable Markdown carry the
 * matching anchor and text — because the front matter is not what anyone reads, and a constitution
 * whose real content is in a header block is a configuration file wearing a document's name.
 */
export function articleSections(body) {
  const lines = body.split('\n');
  const sections = new Map();
  let current = null;
  for (const line of lines) {
    const match = ANCHOR.exec(line);
    if (match) {
      current = { id: match.groups.id, title: match.groups.title, lines: [] };
      sections.set(current.id, current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return new Map([...sections].map(([id, section]) => [id, {
    id, title: section.title, prose: section.lines.join('\n').trim()
  }]));
}

/** The prose inside an enforced article's generated block, or null when it has none. */
export function generatedProse(prose, id) {
  const { start, end } = GENERATED(id);
  const from = prose.indexOf(start);
  const to = prose.indexOf(end);
  if (from === -1 || to === -1 || to < from) return null;
  return prose.slice(from + start.length, to).trim();
}

/**
 * Parse a constitution into articles joined with their visible text.
 *
 * Returns findings rather than throwing on integrity problems: `constitution check` needs to report
 * every one of them, and a parser that stops at the first leaves the author fixing them one per run.
 * Structural errors — no front matter, a malformed article — still throw, because there is nothing
 * to report about a document that cannot be read.
 */
export function parseConstitution(markdown, { resolution = null, allowExample = true } = {}) {
  const { frontMatter, body } = splitFrontMatter(markdown);
  const parsed = YAML.parse(frontMatter) ?? {};
  /**
   * The shipped examples must never become active policy on installation `[SPK:REQ-099]`.
   *
   * A marker in the file rather than a rule about its location, because the way this actually goes
   * wrong is someone copying the example to `singularity/constitution.md` to see what happens and
   * forgetting. Deleting one line is a small, obvious, deliberate act — which is the right size for
   * "these are now the rules we are held to".
   */
  if (parsed.example === true && !allowExample) {
    throw new SingularityFlowError(
      'This constitution is still marked `example: true`. Replace the sample articles with your own and remove that line before the kernel will hold a Story to it.'
    );
  }
  const declared = parsed.articles;
  if (!Array.isArray(declared)) throw new SingularityFlowError('Constitution front matter must declare an `articles` array.');
  const sections = articleSections(body);
  const findings = [];
  const articles = [];
  const seen = new Set();

  for (const [index, value] of declared.entries()) {
    const article = normalizeArticle(value, index);
    if (seen.has(article.id)) throw new SingularityFlowError(`Constitution declares article ${article.id} more than once.`);
    seen.add(article.id);
    const section = sections.get(article.id);
    if (!section) {
      findings.push({ id: article.id, kind: 'missing-anchor', message: `${article.id} is declared in front matter with no [${article.id}] section in the body` });
      articles.push({ ...article, title: null, prose: '', valid: false });
      continue;
    }
    if (!section.prose) {
      findings.push({ id: article.id, kind: 'empty-article', message: `${article.id} has an anchor and no readable text` });
    }

    let valid = true;
    if (article.type === 'enforced') {
      const inner = generatedProse(section.prose, article.id);
      if (inner === null) {
        findings.push({ id: article.id, kind: 'missing-generated-block', message: `${article.id} is enforced and has no generated block; run singularity-flow constitution generate` });
        valid = false;
      } else {
        /**
         * The hand-edit check `[SPK:CON-041]`.
         *
         * Two ways to fail it, and both matter. The prose may have been edited — the obvious one.
         * Or the policy may have moved while the article stayed still, which reads as an intact
         * document describing rules that are no longer in force.
         */
        const expected = articleHash(article, inner);
        if (article.articleSha256 && expected !== article.articleSha256) {
          findings.push({
            id: article.id,
            kind: 'hand-edited',
            message: `${article.id} was edited after generation; its recorded hash no longer matches its text. Regenerate it instead of editing it.`
          });
          valid = false;
        }
        if (resolution) {
          const value = policyValue(resolution, article.policy);
          /**
           * A path that resolves to nothing is almost always a typo, and its article renders as
           * "not set in the approved configuration" — which reads like a deliberate statement about
           * policy rather than a broken reference. Naming it is the difference between a rule the
           * team decided not to set and a rule nobody is enforcing by accident.
           */
          if (value === undefined) {
            findings.push({
              id: article.id,
              kind: 'unresolved-policy',
              message: `${article.id} references \`${article.policy}\`, which does not resolve in the approved configuration`
            });
            valid = false;
          }
          const current = sha256(value);
          if (article.policyValueSha256 && current !== article.policyValueSha256) {
            findings.push({
              id: article.id,
              kind: 'stale-policy',
              message: `${article.id} restates \`${article.policy}\`, whose approved value has changed since the article was generated`
            });
            valid = false;
          }
        }
      }
    } else if (article.articleSha256) {
      // `[SPK:REQ-096]`: judged prose is immutable once approved. Replacement withdraws the old ID
      // and allocates a new one, so an amended rule keeps a distinguishable identity from the rule
      // it replaced — which is what makes "we changed our mind" readable in the record.
      const expected = articleHash(article, section.prose);
      if (expected !== article.articleSha256) {
        findings.push({
          id: article.id,
          kind: 'judged-prose-changed',
          message: `${article.id} is a judged article whose prose changed after approval. Withdraw it and allocate a new ID instead.`
        });
        valid = false;
      }
    }
    articles.push({ ...article, title: section.title, prose: section.prose, valid });
  }

  for (const id of sections.keys()) {
    if (!seen.has(id)) findings.push({ id, kind: 'undeclared-anchor', message: `the body contains a [${id}] section that front matter does not declare` });
  }
  return { articles, findings: findings.sort((left, right) => String(left.id).localeCompare(String(right.id)) || left.kind.localeCompare(right.kind)) };
}

/**
 * The generated index. `[SPK:CON-042]`
 *
 * Joins metadata, anchors, hashes, policy bindings and provenance — and is explicitly *derived*.
 * The constitution file is what was approved; this is a projection of it, recomputable from the same
 * bytes. Saying so in the record is the guard against it quietly becoming a second authority that
 * someone edits instead of the document.
 */
export function constitutionIndex({ articles, path: source, fileSha256, configurationCommit = null, resolution = null }) {
  const entries = articles.map((article) => ({
    id: article.id,
    type: article.type,
    status: article.status,
    title: article.title,
    ...(article.type === 'enforced'
      ? { policy: article.policy, policyValueSha256: article.policyValueSha256, rendererVersion: article.rendererVersion }
      : { level: article.level, evidenceRequired: article.evidenceRequired }),
    articleSha256: article.articleSha256 ?? articleHash(article, article.prose)
  })).sort((left, right) => left.id.localeCompare(right.id));

  const record = {
    schemaVersion: CONSTITUTION_SCHEMA_VERSION,
    resultType: 'constitution-index',
    derived: true,
    authority: 'The approved constitution.md is the authority; this index is a recomputable projection of it.',
    source: posix(source),
    fileSha256,
    configurationCommit,
    rendererVersion: RENDERER_VERSION,
    policyResolutionSha256: resolution ? sha256(resolution) : null,
    articles: entries
  };
  return { ...record, indexSha256: recordSha256(record) };
}

/**
 * Regenerate enforced articles, preserving judged ones byte-for-byte. `[SPK:REQ-097]` `[SPK:REQ-098]`
 *
 * The generated block markers are what make "byte-for-byte" true rather than aspirational: only the
 * text between them is replaced, so a judged article — and any prose an author wrote *around* an
 * enforced one — comes back exactly as it went in.
 */
export function generateConstitution(markdown, resolution) {
  const { frontMatter, body } = splitFrontMatter(markdown);
  const parsed = YAML.parse(frontMatter) ?? {};
  const declared = (parsed.articles ?? []).map(normalizeArticle);
  const sections = articleSections(body);
  let output = body;
  const regenerated = [];
  const updated = [];

  for (const article of declared) {
    if (article.type !== 'enforced') {
      const section = sections.get(article.id);
      updated.push({ ...article, articleSha256: article.articleSha256 ?? articleHash(article, section?.prose ?? '') });
      continue;
    }
    const section = sections.get(article.id);
    if (!section) throw new SingularityFlowError(`Constitution declares enforced article ${article.id} with no [${article.id}] section to regenerate.`);
    const value = policyValue(resolution, article.policy);
    const prose = renderEnforcedArticle({ policy: article.policy, value, rendererVersion: RENDERER_VERSION });
    const { start, end } = GENERATED(article.id);
    const block = `${start}\n${prose}\n${end}`;
    const existing = generatedProse(section.prose, article.id);
    const replaced = existing === null
      ? section.prose.replace(/\s*$/, `\n\n${block}\n`)
      : section.prose.slice(0, section.prose.indexOf(start)) + block + section.prose.slice(section.prose.indexOf(end) + end.length);
    if (replaced !== section.prose) regenerated.push(article.id);
    output = output.replace(section.prose, replaced);
    updated.push({
      ...article,
      policyValueSha256: sha256(value),
      rendererVersion: RENDERER_VERSION,
      articleSha256: articleHash({ ...article, policyValueSha256: sha256(value), rendererVersion: RENDERER_VERSION }, prose)
    });
  }

  const nextFrontMatter = YAML.stringify({ ...parsed, articles: updated.map((article) => ({ ...article })) }, { lineWidth: 0 }).trimEnd();
  return { markdown: `---\n${nextFrontMatter}\n---\n${output}`, regenerated, articles: updated };
}

/** Load and parse the constitution a Story is held to, or null when the profile declares none. */
export async function loadConstitution(root, relative, { resolution = null, allowExample = false } = {}) {
  const absolute = path.join(root, relative);
  if (!(await exists(absolute))) return null;
  const markdown = await readFile(absolute, 'utf8');
  const { articles, findings } = parseConstitution(markdown, { resolution, allowExample });
  return {
    path: posix(relative),
    markdown,
    fileSha256: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    articles,
    findings
  };
}

/**
 * What Story start records. `[SPK:REQ-091]` `[SPK:CON-039]`
 *
 * Every field here exists so a Story can later be re-checked against the rules it actually started
 * under. `sflow/config` moving on is normal and expected; a Story silently acquiring rules nobody
 * held it to when the work began is not.
 */
export function constitutionPin({ constitution, index, configurationCommit = null, resolution = null }) {
  if (!constitution) return null;
  return {
    path: constitution.path,
    fileSha256: constitution.fileSha256,
    indexSha256: index.indexSha256,
    configurationCommit,
    policyResolutionSha256: resolution ? sha256(resolution) : null,
    rendererVersion: RENDERER_VERSION,
    articles: index.articles.map(({ id, type, status, level, evidenceRequired }) => ({
      id, type, status, ...(level ? { level } : {}), ...(evidenceRequired === undefined ? {} : { evidenceRequired })
    }))
  };
}

/**
 * The article IDs an artifact cites. `[SPK:REQ-100]`
 *
 * Read only from a `## Constitution articles` section: a document may discuss `ART-004` in passing,
 * and a citation is a claim that the work is *bound by* the article. Treating every mention as a
 * binding would make the section pointless and the validation noisy.
 *
 * The end-of-section lookahead is `(?![\s\S])`, not `\Z`. JavaScript has no `\Z` — it reads as a
 * literal `Z` — so the first version of this only matched when another heading followed, and a
 * Constitution section at the end of a document (which is where the template puts it) cited nothing.
 * Exported because it was written twice, in two files, and both copies were wrong the same way.
 */
export function citedArticleIds(markdown) {
  const section = /^#{1,6}[ \t]*Constitution articles[ \t]*$([\s\S]*?)(?=^#{1,6}[ \t]|(?![\s\S]))/mi.exec(String(markdown ?? ''));
  return section ? [...new Set(section[1].match(/\b[A-Z][A-Z0-9]*-\d{3,}\b/g) ?? [])].sort() : [];
}

/**
 * Validate the article IDs an artifact cites. `[SPK:REQ-101]`
 *
 * Checked against the **pin**, not against the file on disk. Citing an article that exists today but
 * did not when the Story started would otherwise pass, and the citation would be to a rule the
 * author never read.
 */
export function validateCitations(pin, citedIds, { label = 'artifact' } = {}) {
  const cited = [...new Set((citedIds ?? []).map((id) => String(id).trim().toUpperCase()).filter(Boolean))].sort();
  if (!pin) {
    return cited.length
      ? { cited, errors: [`${label} cites constitution article(s) ${cited.join(', ')} but this Story pinned no constitution.`], warnings: [] }
      : { cited, errors: [], warnings: [] };
  }
  const known = new Map(pin.articles.map((article) => [article.id.toUpperCase(), article]));
  const errors = [];
  const warnings = [];
  for (const id of cited) {
    const article = known.get(id);
    if (!article) { errors.push(`${label} cites constitution article ${id}, which the pinned constitution does not contain.`); continue; }
    if (article.status === 'withdrawn') warnings.push(`${label} cites ${id}, which was withdrawn.`);
  }
  return { cited, errors, warnings };
}

/**
 * The articles a phase must carry. `[SPK:REQ-102]`
 *
 * The union of what the artifact cited and every article requiring evidence — because an
 * evidence-required article that nobody cited is exactly the one most likely to be forgotten, and
 * "nobody mentioned it" is not a reason to leave it out of conformance.
 */
export function requiredArticles(pin, citedIds = []) {
  if (!pin) return [];
  const cited = new Set((citedIds ?? []).map((id) => String(id).toUpperCase()));
  return pin.articles
    .filter((article) => article.status !== 'withdrawn')
    .filter((article) => cited.has(article.id.toUpperCase()) || article.evidenceRequired === true)
    .map((article) => article.id)
    .sort();
}

/**
 * An exception to an article. `[SPK:REQ-103]`
 *
 * Every field is required because an exception is the record of a rule deliberately not followed,
 * and the only thing that distinguishes it from a rule quietly ignored is that all of this was
 * written down at the time.
 */
export function buildConstitutionException({
  articleId, reason, scope, actor, authority, at, expiresAt = null, workId, sourceCommit
} = {}) {
  for (const [field, value] of Object.entries({ articleId, reason, scope, actor, authority, at, workId, sourceCommit })) {
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new SingularityFlowError(`A constitution exception needs '${field}'.`);
    }
  }
  const record = {
    schemaVersion: CONSTITUTION_SCHEMA_VERSION,
    resultType: 'constitution-exception',
    articleId: String(articleId).toUpperCase(),
    reason: String(reason).trim(),
    scope: String(scope).trim(),
    actor,
    authority: String(authority).trim(),
    at,
    expiresAt,
    // Bound to the Story *and* the source it was granted against `[SPK:REQ-103]`: an exception that
    // outlives the code it was about is how a one-off allowance becomes the standard.
    binding: { workId, sourceCommit }
  };
  return { ...record, exceptionSha256: recordSha256(record) };
}

/** Exceptions that have passed their expiry, given an observation time supplied by the caller. */
export function expiredExceptions(exceptions = [], now) {
  if (!now) throw new SingularityFlowError('Deciding whether an exception expired needs an observation time from the caller.');
  return exceptions.filter((entry) => entry.expiresAt && String(entry.expiresAt) <= String(now));
}
