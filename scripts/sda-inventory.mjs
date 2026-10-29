#!/usr/bin/env node
/**
 * SDA M0 inventory (docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md §4, §15 Stage 0).
 *
 * Every place the engine starts Git, writes the filesystem, parses YAML or hard-codes a lifetime,
 * found by reading src/ as syntax trees, never by running it. Each module that starts Git or writes
 * files carries one SDA class (see RULES): its primary role, since many modules play several. A module
 * that matches no rule is `unclassified`, and test/sda-inventory.test.mjs refuses that, so a new
 * persistence path is classified when it is written. The counts are the M0 baseline the SDA-AC-001
 * ratchet (M1) will hold. The GAL bypass audit (scripts/git-bypass-audit.mjs) freezes where processes
 * are launched; this inventory says what each Git call does and which storage role its module plays.
 *
 *   node scripts/sda-inventory.mjs [--json] [--sites] [--output=FILE]
 *
 * --sites keeps every call site with its line, for an investigation; the default is the committed form.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REMOTE_VERBS = new Set(['fetch', 'push', 'pull', 'clone', 'ls-remote']);
const WRITE_VERBS = new Set(['commit', 'commit-tree', 'update-ref', 'update-index', 'add', 'rm', 'mv', 'checkout', 'switch', 'reset',
  'merge', 'rebase', 'cherry-pick', 'revert', 'stash', 'tag', 'read-tree', 'write-tree', 'mktree', 'init', 'apply', 'notes', 'gc',
  'maintenance', 'repack', 'prune', 'restore', 'clean', 'sparse-checkout', 'submodule', 'pack-refs', 'reflog', 'replace', 'am',
  'format-patch', 'mktag', 'unpack-objects', 'index-pack', 'pack-objects']);
const READ_VERBS = new Set(['rev-parse', 'cat-file', 'ls-tree', 'ls-files', 'show', 'show-ref', 'for-each-ref', 'log', 'rev-list',
  'diff', 'diff-tree', 'diff-index', 'diff-files', 'status', 'merge-base', 'describe', 'name-rev', 'check-ignore', 'check-attr',
  'check-ref-format', 'var', 'version', '--version', 'blame', 'grep', 'shortlog', 'count-objects', 'verify-commit', 'verify-tag',
  'fsck', 'cherry', 'range-diff', 'merge-tree', 'get-tar-commit-id', 'archive', 'bundle', 'help', 'rev-list']);
// A verb whose effect depends on its arguments: `branch --show-current` reads, `branch -D` writes.
const MIXED_VERBS = new Set(['branch', 'worktree', 'config', 'symbolic-ref', 'hash-object', 'remote', 'lfs']);
const MIXED_READ = /^(?:--show-current|--list|-l|-a|-r|--contains|--merged|--no-merged|--format.*|list|--get.*|-l|get-url|--porcelain|show)$/u;
const SPAWNERS = new Set(['run', 'spawnSync', 'execFileSync', 'spawn', 'execFile', 'runAsync', 'spawnAsync', 'runProcess', 'runCommand']);
const WRAPPERS = new Set(['git', 'runGit', 'gitRun', 'gitSync', 'gitOutput', 'gitText', 'gitRead', 'execGit', 'executeGit', 'gitAsync',
  'runGitAsync', 'gitCommand', 'gitResult', 'gitLines']);
const REMOTE_API = new Set(['runRemoteGit', 'runRemoteGitAsync']);
const NAMED_READS = new Set(['executeGitQuery', 'readLocalGitAsync']);
const WRITES = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync', 'rm', 'rmSync', 'unlink',
  'unlinkSync', 'rmdir', 'rmdirSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'symlink', 'symlinkSync', 'link', 'linkSync',
  'truncate', 'truncateSync', 'writeAtomic', 'writePrivate', 'writePrivateJson', 'atomicWrite', 'writePrivateDocumentContext',
  'writePrivateDocumentExport']);
const YAML_READS = new Set(['parse', 'parseDocument', 'parseAllDocuments', 'parseYaml', 'loadYaml']);
const LIFETIME_NAME = /(?:TTL|MAX_?AGE|STALE|FRESH|EXPIR|LIFETIME|INTERVAL|IDLE|HEARTBEAT|LEASE|RETENTION|TIMEOUT|DEADLINE)/iu;

/**
 * Ordered: the first matching rule names the class. Paths are relative to src/ with forward slashes.
 * The six classes of SDA §15 Stage 0, with `local-draft` widened to every kind of local authored data
 * (§6.3: drafts, journals, outboxes and private bindings, which can be the only copy), plus two the
 * spec did not name: `local-operational` (logs, telemetry, leases, run state and preferences: machine
 * local and bounded) and `surface` (commands, hosts and the gateway, which should reach persistence
 * only through services).
 */
const RULES = [
  ['installation', /^(?:install|reinstall|product-|distribution|bootstrap|workspace-bootstrap|vsix|runtime|staged-install|installation|uninstall|factory-reset|local-install|direct-skills|plugin|update-|self-update|package-|apm-install|build-currency|build-info|fresh-install|inject\.mjs$|release-|secure-release|skp-)/u],
  ['surface', /^(?:commands\/|gateway\/|cli\.mjs$|cli-entry\.mjs$|vscode|host-|copilot-|chat-|acp|mcp|narration\/|help-|first-run-guide|doctor\.mjs$|terminal-review)/u],
  ['local-authored', /(?:journal|transport-intents|outbox|publication-pending|draft|clarification|^inputs|scratch|^choices|^environment-|private-sidecar)/u],
  ['local-operational', /^(?:logging|telemetry|dx-|performance-|personalization|prompt-audit|model-prompt|native-efficiency|observation-compiler|file-lease|subject-lock|context-|application-run|local-application|comprehension\/xpl2\/observed|work-intervals|lease)/u],
  ['artifact', /^(?:document|evidence|fos-|artifact|attachment|verification\/|verification-receipt|witness|screenshot|report|agent-output|agent-result|deliverable|visual-)/u],
  ['projection', /(?:-index|index\.mjs$|-cache|cache\.mjs$|^git-fact|knowledge\/|listing|read-model|read-worker|projection|projectors|summar|^ast-|^comprehension\/|^grounding|^impact\.mjs$|^lead-repositories|^repositories\/store|^schema-census|^snapshot-coordinator)/u],
  ['shared-state', /^(?:ledger|publication|transport-|state|story-|session|phase|approval|decision|configuration|config|sgos\/|workflow|epic|initiative|portfolio|goal|program|governance|policy|amendment|upstream|finding|dispute|review|submit|delivery|fulfillment|land|wca-|collaboration|organisation|capability|capabilities|team|authority|lineage|recovery|pending|repair|auto\/|revision\/|intake|start|signing|trust|accepted-story|action-|adhoc\/|agents\.mjs$|approved-configuration|asset-import|change-flight|editor\.mjs$|fault-repair|gate-|governed-goals|human-review|jira-|local-identity|local-mode\/|planning\.mjs$|return-locator|step-action|trp-|initialization\/(?:activation|recovery))/u],
  ['source-control', /^(?:git|worktree|candidate|code-|source|repository|repo-|branch|commit|merge|diff|checkout|clone|remote|fetch|push|workspace|test|quality|tce|nx-|android|dotnet|python|swift|xcode|gradle|maven|node-|instruction-test|external-command|platform-process|subprocess|process|wel|spec|cancelled-worktree|convergence-context|creation-git|harness-imports|initialization\/|pull-request|readiness-base|reference-|regression-analysis)/u]
];

function classify(relative, overrides) {
  if (overrides[relative]) return overrides[relative];
  for (const [name, pattern] of RULES) if (pattern.test(relative)) return name;
  return 'unclassified';
}

/** A few modules whose names mislead the rules, with the reason kept beside them. */
const OVERRIDES = {
  // Creates workspaces and clones their repositories; the registry it also writes is a local locator.
  'workspace.mjs': 'source-control',
  'workspace-manifest.mjs': 'projection',
  // Story checkouts are source: the Story's branch is checked out there.
  'story-worktree.mjs': 'source-control',
  // The SGOS operational store holds recovery journals and is refused as authority (SDA §2).
  'sgos/operational-store.mjs': 'local-authored',
  'generation-publication-store.mjs': 'shared-state',
  // The Story index is the machine-wide locator registry SDA §12 builds on.
  'story-index.mjs': 'projection',
  // Repository-check settings and their cache are machine-local preferences and projections.
  'repository-check-settings.mjs': 'projection',
  'repository-check-cache.mjs': 'projection',
  'session-listing-cache.mjs': 'projection',
  'session-state-index.mjs': 'projection',
  // Configuration drafts are the one place a configuration edit is saved before it is proposed.
  'configuration-drafts.mjs': 'local-authored',
  // The configuration read model is rebuildable (docs/CONFIGURATION-STATE-SERVICE.md).
  'configuration-state-service.mjs': 'projection',
  // Shared helpers every class uses.
  'util.mjs': 'source-control',
  'atomic-write.mjs': 'projection'
};

function literal(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** The Git verb of an argv array literal: past `-c k=v`, `-C dir` and other leading options. */
function gitVerb(array) {
  if (!array || !ts.isArrayLiteralExpression(array)) return { verb: null, next: null };
  const words = array.elements.map((element) => (ts.isSpreadElement(element) ? null : literal(element)));
  let index = 0;
  while (index < words.length && words[index] !== null && words[index].startsWith('-') && words[index] !== '--version') {
    index += ['-c', '-C', '--git-dir', '--work-tree', '--namespace'].includes(words[index]) ? 2 : 1;
  }
  return { verb: words[index] ?? null, next: words[index + 1] ?? null };
}

function verbClass(verb, next) {
  if (verb === null) return 'dynamic';
  if (REMOTE_VERBS.has(verb)) return 'remote';
  if (READ_VERBS.has(verb)) return 'read';
  if (WRITE_VERBS.has(verb)) return 'write';
  if (MIXED_VERBS.has(verb)) return next !== null && MIXED_READ.test(next) ? 'read' : next === null ? 'dynamic' : 'write';
  return 'unknown';
}

function evaluate(node) {
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
  if (ts.isParenthesizedExpression(node)) return evaluate(node.expression);
  if (ts.isBinaryExpression(node)) {
    const [left, right] = [evaluate(node.left), evaluate(node.right)];
    if (left === null || right === null) return null;
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
  }
  return null;
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return { name: expression.text, owner: null };
  if (ts.isPropertyAccessExpression(expression)) return { name: expression.name.text,
    owner: ts.isIdentifier(expression.expression) ? expression.expression.text : null };
  return { name: null, owner: null };
}

async function sourceFiles(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await sourceFiles(path.join(directory, entry.name), relative));
    else if (/\.mjs$/u.test(entry.name)) found.push(relative);
  }
  return found.sort();
}

export async function scanSource(root = packageRoot) {
  const sourceRoot = path.join(root, 'src');
  const modules = [];
  for (const relative of await sourceFiles(sourceRoot)) {
    const text = await readFile(path.join(sourceRoot, relative), 'utf8');
    const file = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const entry = { module: relative, class: null, git: [], writes: 0, yamlReads: 0, lifetimes: [] };
    const line = (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const { name, owner } = calleeName(node.expression);
        const args = node.arguments;
        let site = null;
        if (name && SPAWNERS.has(name) && literal(args[0]) === 'git') site = { form: 'direct', ...gitVerb(args[1]) };
        else if (name && WRAPPERS.has(name) && !owner) {
          const array = args.find((argument) => ts.isArrayLiteralExpression(argument));
          if (array) site = { form: 'wrapper', ...gitVerb(array) };
        } else if (name && REMOTE_API.has(name)) site = { form: 'remote-boundary', ...gitVerb(args[0]) };
        else if (name && NAMED_READS.has(name)) site = { form: 'named-read', verb: literal(args[name === 'readLocalGitAsync' ? 0 : 1]), next: null };
        if (site) {
          const kind = site.form === 'named-read' ? 'read' : site.form === 'remote-boundary' ? 'remote' : verbClass(site.verb, site.next);
          entry.git.push({ line: line(node), form: site.form, verb: site.verb ?? 'dynamic', kind });
        }
        if (name && WRITES.has(name) && (owner === null || /^(?:fs|fsp|promises|fsPromises|fileSystem)$/u.test(owner) || !owner)) entry.writes += 1;
        if (name && YAML_READS.has(name) && (owner === 'YAML' || owner === 'yaml' || owner === null) && name !== 'parse' || (name === 'parse' && owner && /^ya?ml$/iu.test(owner))) entry.yamlReads += 1;
      }
      if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer && node.name && ts.isIdentifier(node.name)
          && LIFETIME_NAME.test(node.name.text) && !/BYTES|COUNT|SIZE|LIMIT/iu.test(node.name.text)) {
        const value = evaluate(node.initializer);
        if (value !== null && value >= 1000) entry.lifetimes.push({ line: line(node), name: node.name.text, value,
          kind: /TIMEOUT|DEADLINE/iu.test(node.name.text) ? 'timeout' : 'lifetime' });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (entry.git.length || entry.writes || entry.yamlReads || entry.lifetimes.length) {
      entry.class = entry.git.length || entry.writes ? classify(relative, OVERRIDES) : null;
      modules.push(entry);
    }
  }
  return modules;
}

export function summarize(modules) {
  const count = (filter) => modules.reduce((sum, entry) => sum + entry.git.filter(filter).length, 0);
  const byClass = {};
  for (const entry of modules.filter((item) => item.class)) {
    const bucket = byClass[entry.class] ??= { modules: 0, gitSites: 0, gitWrites: 0, gitRemote: 0, writeSites: 0 };
    bucket.modules += 1;
    bucket.gitSites += entry.git.length;
    bucket.gitWrites += entry.git.filter((site) => site.kind === 'write').length;
    bucket.gitRemote += entry.git.filter((site) => site.kind === 'remote').length;
    bucket.writeSites += entry.writes;
  }
  const gitModules = modules.filter((entry) => entry.git.length);
  return {
    gitSites: { total: count(() => true), read: count((site) => site.kind === 'read'), write: count((site) => site.kind === 'write'),
      remote: count((site) => site.kind === 'remote'), dynamic: count((site) => ['dynamic', 'unknown'].includes(site.kind)) },
    gitModules: gitModules.length,
    // SDA-AC-001: local Git started outside the git*.mjs modules and the remote boundary.
    directLocalGitSitesOutsideGitModules: modules.filter((entry) => !/^git[^/]*\.mjs$/u.test(entry.module))
      .reduce((sum, entry) => sum + entry.git.filter((site) => site.kind !== 'remote' && site.form !== 'named-read').length, 0),
    writeSites: modules.reduce((sum, entry) => sum + entry.writes, 0),
    yamlReadModules: modules.filter((entry) => entry.yamlReads).length,
    lifetimes: modules.reduce((sum, entry) => sum + entry.lifetimes.filter((item) => item.kind === 'lifetime').length, 0),
    timeouts: modules.reduce((sum, entry) => sum + entry.lifetimes.filter((item) => item.kind === 'timeout').length, 0),
    byClass,
    unclassified: modules.filter((entry) => entry.class === 'unclassified').map((entry) => entry.module)
  };
}

/**
 * The committed form (benchmarks/sda/inventory.json): counts per module, no line numbers, so it
 * changes only when a module gains or loses a call site, not on every edit above one.
 */
export function baseline(modules) {
  return { schemaVersion: 1, specification: 'SDA-v1 M0 inventory', summary: summarize(modules),
    modules: modules.map((entry) => ({ module: entry.module, class: entry.class,
      git: Object.fromEntries(['read', 'write', 'remote', 'dynamic', 'unknown'].map((kind) => [kind, entry.git.filter((site) => site.kind === kind).length])
        .filter(([, count]) => count)),
      writes: entry.writes, yamlReads: entry.yamlReads,
      lifetimes: entry.lifetimes.map((item) => ({ name: item.name, value: item.value, kind: item.kind })) })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modules = await scanSource();
  const report = process.argv.includes('--sites')
    ? { schemaVersion: 1, specification: 'SDA-v1 M0 inventory', summary: summarize(modules), modules }
    : baseline(modules);
  const output = process.argv.find((argument) => argument.startsWith('--output='))?.slice('--output='.length);
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report.summary, null, 2));
}
