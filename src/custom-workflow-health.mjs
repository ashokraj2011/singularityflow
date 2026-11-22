/**
 * The repository's own workflows, checked once by each SFlow version [owner, 2026-11-22: "A way to identify and fix
 * the issues in existing custom workflows"]. A custom workflow written for an earlier SFlow is never checked again
 * unless someone thinks to, so a rule a newer SFlow adds (the owner's Verification loop, 2026-11-22) is first met by a
 * person halfway through a Story. The updater runs the old version's code, so the check runs the first time the new
 * version reads the repository: `singularity-flow check`, and the start of a Copilot session (agent-hooks.mjs).
 *
 * - Which workflows: every one SFlow does not ship (workflow-check.mjs marks shipped ones readOnly).
 * - What it reports: per workflow with a problem or warning, the counts and the first findings' titles in plain
 *   words, and the one route that fixes them: /sf-fix-workflow <ID> (each fix drafted, the person's questions asked,
 *   the result one reviewed proposal), or in the person's own terminal `singularity-flow workflow fix <ID>`.
 * - When it runs again: when SFlow's build or the repository's committed configuration changes. The result is kept in
 *   the repository's Git folder (never committed), so reading it again costs nothing.
 *
 * Read only: it changes no configuration and asks nothing.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CUSTOM_WORKFLOW_HEALTH_RESULT = 'custom-workflow-health';
const FILE = 'custom-workflow-health.json';
const TOP = 3;

/** What this SFlow build is: its version and the commit or source digest it was packed from. */
async function buildKey() {
  const [{ VERSION }, { BUILD_INFO }] = await Promise.all([import('./version.mjs'), import('./build-info.mjs')]);
  return `${VERSION}+${BUILD_INFO.commit ?? BUILD_INFO.sourceSha256 ?? 'checkout'}`;
}

/** The repository's committed SFlow configuration, as one digest: every file under singularity/ in Git's index. */
function configurationKey(root) {
  const listed = spawnSync('git', ['-C', root, 'ls-files', '-s', '--', 'singularity'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return createHash('sha256').update(listed.status === 0 ? listed.stdout : `unreadable:${listed.stderr}`).digest('hex');
}

async function cacheFile(root) {
  const { gitCommonDir } = await import('./git.mjs');
  return path.join(gitCommonDir(root), 'singularity-flow', FILE);
}

/** The IDs of the workflows in `root`'s workflow.yml that SFlow does not ship; null when there is none to read. */
async function customWorkflowIds(root) {
  const [{ default: YAML }, { configurationReadRoot }, { seededWorkflowCatalogs }] = await Promise.all([
    import('yaml'), import('./configuration-read-scope.mjs'), import('./seeded-workflow-protection.mjs')]);
  const text = await readFile(path.join(configurationReadRoot(root), 'singularity', 'workflow.yml'), 'utf8').catch(() => null);
  if (text == null) return null;
  let parsed;
  try { parsed = YAML.parse(text) ?? {}; } catch { return null; }
  const shipped = (await seededWorkflowCatalogs()).story.workTypes ?? {};
  return Object.keys(parsed.workTypes ?? {}).filter((id) => !shipped[id]);
}

/** The route that fixes one workflow: Copilot's skill, and the person's own terminal. */
export function fixRoute(workflowId) {
  return { copilot: `/sf-fix-workflow ${workflowId}`, shell: `singularity-flow workflow fix ${workflowId}` };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One workflow's entry from its `workflow check` result: its counts and the first findings, problems first. */
function entryOf(workflow) {
  const findings = (workflow.findings ?? []).filter((finding) => finding.severity === 'problem' || finding.severity === 'warning')
    .sort((left, right) => Number(right.severity === 'problem') - Number(left.severity === 'problem'));
  const problems = findings.filter((finding) => finding.severity === 'problem').length;
  return { id: workflow.id, label: workflow.label ?? workflow.id, problems, warnings: findings.length - problems,
    findings: findings.slice(0, TOP).map((finding) => ({ code: finding.code, severity: finding.severity, title: finding.title })),
    fix: fixRoute(workflow.id) };
}

/** The plain words for a result: one line per workflow that needs attention, with its fix; null when none does. */
export function healthWords(result) {
  const attention = result?.attention ?? [];
  if (!attention.length) return null;
  const lines = attention.map((entry) => {
    const counts = [entry.problems ? plural(entry.problems, 'problem') : null, entry.warnings ? plural(entry.warnings, 'warning') : null].filter(Boolean).join(' and ');
    return `${entry.label} (${entry.id}): ${counts}, for example "${entry.findings[0]?.title ?? 'see workflow check'}". Fix: ${entry.fix.copilot} (or in your terminal: ${entry.fix.shell}).`;
  });
  return `This SFlow found ${attention.length === 1 ? 'a custom workflow' : `${attention.length} custom workflows`} to fix before a Story meets it:\n${lines.join('\n')}`;
}

/**
 * The health of `root`'s custom workflows for this SFlow build: `{ resultType, build, configuration, checkedAt,
 * source: 'fresh' | 'kept', workflows, attention }`, where `attention` holds the workflows with a problem or warning.
 * Kept from the last run while the build and the committed configuration are the same; `refresh` checks again.
 * Null when the repository has no SFlow configuration that loads (the repository check reports that itself).
 */
export async function customWorkflowHealth(root, { refresh = false, check = null } = {}) {
  const build = await buildKey();
  const configuration = configurationKey(root);
  const file = await cacheFile(root);
  if (!refresh) {
    const kept = await readFile(file, 'utf8').then(JSON.parse, () => null);
    if (kept?.resultType === CUSTOM_WORKFLOW_HEALTH_RESULT && kept.build === build && kept.configuration === configuration) return { ...kept, source: 'kept' };
  }
  // Only the workflows SFlow does not ship are checked; with none, there is nothing to run.
  const custom = await customWorkflowIds(root);
  if (custom == null) return null;
  const run = check ?? (async (at, ids) => (ids.length ? (await import('./workflow-check.mjs')).checkWorkflowConfiguration(at, { workflows: ids })
    : { configuration: { valid: true }, workflows: [] }));
  let checked;
  try { checked = await run(root, custom); } catch { return null; }
  if (checked?.configuration?.valid === false && !(checked.workflows ?? []).length) return null;
  const workflows = (checked.workflows ?? []).filter((workflow) => !workflow.readOnly).map(entryOf);
  const result = { schemaVersion: 1, resultType: CUSTOM_WORKFLOW_HEALTH_RESULT, build, configuration, checkedAt: new Date().toISOString(),
    workflows, attention: workflows.filter((entry) => entry.problems || entry.warnings) };
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } catch { /* the result is still returned; it is only checked again next time */ }
  return { ...result, source: 'fresh' };
}
