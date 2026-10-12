/** Constitution authoring is configuration, never a second policy or Story mutation path. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { DEFAULT_CONSTITUTION_PATH, constitutionPolicy, generateConstitution, normalizeArticle, parseConstitution, policyValue } from './constitution.mjs';
import { resolveWorkType, validateDefinition } from './config.mjs';
import { configurationAssetPolicy, isConfigurationAssetPath, portableConfigurationPath } from './configuration-assets.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { renderDataPreservingFormatting } from './yaml-formatting.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const refuse = message => { throw new SingularityFlowError(message, { code: 'STUDIO_CONSTITUTION_INVALID' }); };
const LIMIT = 256 * 1024;

function constitutionPath(path, definition) {
  if (!portableConfigurationPath(path) || !path.startsWith('singularity/') || !path.endsWith('.md')
      || !isConfigurationAssetPath(path, configurationAssetPolicy(definition))) {
    refuse('The Constitution editor supports portable Markdown paths under singularity/, outside Story and runtime directories.');
  }
  return path;
}

export function constitutionPolicyChoices(resolution) {
  // Offer only settings the kernel actually enforces, not arbitrary configuration/prose paths.
  return (resolution.phases || []).flatMap(phase => {
    const path = `phases.${phase.id}.approval.minimum`;
    const value = policyValue(resolution, path);
    return Number.isInteger(value) ? [{ path, label: `${phase.label || phase.id}: minimum approvals`, value }] : [];
  });
}

export async function studioConstitutions(root, definition) {
  const files = new Map();
  for (const [id, workflow] of Object.entries(definition.workTypes || {})) {
    let policy; let problem = null;
    try { policy = constitutionPolicy(workflow.constitution); }
    catch (error) { policy = { path: DEFAULT_CONSTITUTION_PATH, mode: 'invalid' }; problem = `Workflow ${id}: ${error.message}`; }
    if (!files.has(policy.path)) files.set(policy.path, { path: policy.path, workflows: [], articles: [], problems: [], present: false, text: null });
    files.get(policy.path).workflows.push({ id, label: workflow.label || id, mode: policy.mode });
    if (problem) files.get(policy.path).problems.push(problem);
  }
  for (const file of files.values()) {
    try {
      constitutionPath(file.path, definition);
      const target = await secureRepositoryPath(root, file.path, { label: 'Constitution', type: 'file' });
      if (target.exists) {
        const bytes = await readFile(target.absolute);
        if (bytes.length > LIMIT) refuse('Constitution exceeds the 256 KiB editor limit.');
        file.text = bytes.toString('utf8'); file.present = true;
        const parsed = parseConstitution(file.text, { allowExample: false });
        file.articles = parsed.articles;
        file.problems = parsed.findings.map(item => item.message);
      }
    } catch (error) { file.problems.push(error.message); }
    file.sha256 = hash(file.text ?? '');
  }
  return { files, sha256: hash(JSON.stringify([...files.values()].map(file => [file.path, file.sha256, file.problems]))) };
}

export function constitutionStudioView(catalog, definition, protectedWorkflows) {
  return [...catalog.files.values()].map(({ text, ...file }) => ({ ...file,
    workflows: file.workflows.map(workflow => ({ ...workflow, editable: workflow.mode !== 'invalid' && !protectedWorkflows.includes(workflow.id) })),
    policyChoices: file.workflows.map(workflow => {
      try { return { workflow: workflow.id, choices: constitutionPolicyChoices(resolveWorkType(definition, workflow.id)) }; }
      catch { return { workflow: workflow.id, choices: [] }; }
    })
  }));
}

/** Existing articles cannot disappear, be resurrected or acquire new meaning under the same ID. */
function authoredArticles(values, before, choices) {
  if (!Array.isArray(values) || !values.length || values.length > 100) refuse('A constitution contains 1–100 articles.');
  const seen = new Set();
  const articles = values.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['id', 'type', 'status', 'policy', 'level', 'evidenceRequired', 'title', 'prose', 'withdrawnBy'].includes(key))) {
      refuse('An article contains unsupported fields.');
    }
    const normalized = normalizeArticle(value, index);
    if (seen.has(normalized.id)) refuse(`Article ID ${normalized.id} is already used.`);
    seen.add(normalized.id);
    const title = String(value.title ?? '').trim(); const prose = String(value.prose ?? '').trim();
    if (!title || title.length > 120 || /[\r\n]/u.test(title)) refuse(`${normalized.id} needs a single-line title of at most 120 characters.`);
    if (prose.length > 16000 || (normalized.type === 'judged' && !prose)) refuse(`${normalized.id} needs rule text of at most 16,000 characters.`);
    if (/^#{1,6}\s*\[[A-Z][A-Z0-9]*-\d{3,}\]/mu.test(prose)) refuse('Rule text cannot embed another article heading.');
    const old = before.find(article => article.id === normalized.id);
    if (old) {
      const keys = old.type === 'judged' ? ['type', 'level', 'evidenceRequired'] : ['type', 'policy'];
      if (keys.some(key => old[key] !== normalized[key]) || old.title !== title || old.prose.trim() !== prose
          || (old.status === 'withdrawn' && (normalized.status !== 'withdrawn' || (old.withdrawnBy ?? null) !== (normalized.withdrawnBy ?? null)))) {
        refuse(`Approved article ${old.id} is immutable. Withdraw it and create a replacement ID.`);
      }
      return { ...old, status: normalized.status, ...(normalized.withdrawnBy ? { withdrawnBy: normalized.withdrawnBy } : {}) };
    }
    if (normalized.type === 'enforced' && !choices.has(normalized.policy)) refuse(`${normalized.id} must select a supported machine-enforced policy.`);
    if (normalized.type === 'enforced' && prose) refuse(`${normalized.id}: machine-enforced rule text is generated, not authored.`);
    return { ...normalized, title, prose };
  });
  if (before.some(article => !seen.has(article.id))) refuse('Approved articles must be retained. Withdraw an article instead of deleting it.');
  const byId = new Map(articles.map(article => [article.id, article]));
  for (const article of articles) {
    if (!article.withdrawnBy) continue;
    if (article.status !== 'withdrawn' || !byId.has(article.withdrawnBy) || article.withdrawnBy === article.id) {
      refuse('A replacement must name a different article in this constitution and withdraw the old one.');
    }
    // Earlier replacements remain history even when their successors are later withdrawn.
    const chain = new Set([article.id]); let target = article.withdrawnBy;
    while (target) {
      if (chain.has(target)) refuse('Article replacement history cannot contain a cycle.');
      chain.add(target); target = byId.get(target)?.withdrawnBy;
    }
  }
  return articles;
}

/** Render and seal using the same generator/parser as CLI and Story pinning. */
export function renderStudioConstitution({ path, articles: values }, catalog, raw) {
  constitutionPath(path, raw);
  const original = catalog.files.get(path);
  if (!original) refuse('The constitution path is not declared by a workflow in this configuration.');
  if (original.problems.length) refuse('Inspect and repair the existing constitution before replacing it: ' + original.problems.join('; '));
  const definition = validateDefinition(raw);
  const profiles = Object.entries(definition.workTypes).filter(([, workflow]) => constitutionPolicy(workflow.constitution).path === path);
  const applicable = profiles.filter(([, workflow]) => constitutionPolicy(workflow.constitution).mode !== 'off');
  // An inactive draft can be authored against one profile; enabling another profile checks its
  // exact effective policy too. Off workflows must not constrain currently applicable rules.
  const resolutions = (applicable.length ? applicable : profiles.slice(0, 1)).map(([id]) => resolveWorkType(definition, id));
  const choices = new Set(resolutions.flatMap(resolution => constitutionPolicyChoices(resolution).map(choice => choice.path)));
  const articles = authoredArticles(values, original.articles, choices);
  const metadata = articles.map(({ title, prose, valid, ...article }) => article);
  // Keep existing metadata, comments and introductory prose; the form edits articles only.
  const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(original.text ?? '');
  const frontMatter = header ? renderDataPreservingFormatting(`${header[1]}\n`, { ...YAML.parse(header[1]), articles: metadata }) : YAML.stringify({ articles: metadata });
  const body = header ? original.text.slice(header[0].length) : '';
  const anchor = body.search(/^#{1,6}\s*\[[A-Z][A-Z0-9]*-\d{3,}\]/mu);
  const introduction = (anchor < 0 ? body : body.slice(0, anchor)).trim() || '# Constitution';
  const markdown = `---\n${frontMatter.trimEnd()}\n---\n\n${introduction}\n\n` + articles.map(article =>
    `## [${article.id}] ${article.title}\n\n${article.prose || 'Generated from the configured machine policy.'}\n`).join('\n');
  const generated = generateConstitution(markdown, resolutions[0] || definition).markdown.trimEnd() + '\n';
  for (const resolution of resolutions) {
    const checked = parseConstitution(generated, { resolution, allowExample: false });
    if (checked.findings.length) refuse(checked.findings.map(item => item.message).join('; ')
      + ' Choose policies with the same effective value in all applicable workflows, or use separate declared constitution files.');
  }
  if (Buffer.byteLength(generated) > LIMIT) refuse('Constitution exceeds the 256 KiB editor limit.');
  return generated;
}
