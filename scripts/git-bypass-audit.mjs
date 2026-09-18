#!/usr/bin/env node
// [GAL:REQ-033] Freeze legacy production process sites while Git callers migrate to GAL.
// This is a static regression gate, not proof that the legacy sites are compliant. The
// release qualification also needs runtime probes for dynamic/indirect execution.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'scripts', 'git-bypass-baseline.json');
const productionDirectories = ['src', 'bin', 'apps/vscode/src', 'plugin/extensions', 'scripts', 'distribution'];
const sourceExtensions = new Set(['.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.sh', '.bash', '.ps1', '.cmd', '.bat']);
const shellExtensions = new Set(['.sh', '.bash', '.ps1', '.cmd', '.bat']);
const processPackages = new Set(['node:child_process', 'child_process', 'execa', 'cross-spawn', 'shelljs']);
const processNames = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execSync', 'fork', 'execa', 'execaSync']);
const commandNames = new Set(['run', 'runCommand', 'git']);

// These are the reviewed process/compatibility owners. New sites elsewhere require
// an explicit baseline review or migration; owner files are still reported.
export const REGISTERED_OWNERS = Object.freeze([
  'src/platform-process.mjs',
  'src/git-execution.mjs',
  'src/git-access.mjs',
  'src/git-local-blob-async.mjs',
  'src/git-blob-batch.mjs',
  'src/fos-object-service.mjs',
  'src/git.mjs',
  'src/util.mjs',
  // Fixed-command, local-only qualification harness; never imported by product commands.
  'scripts/gal-matrix-cell.mjs'
]);

// The benchmark's sole child-process site creates its isolated temporary Git fixture. It is not
// imported by production commands and is checked separately for bounded, local-only execution.
const excludedAuditFiles = new Set([
  'scripts/git-bypass-audit.mjs', 'scripts/check.mjs', 'scripts/gal-read-benchmark.mjs'
]);

function signature(kind, source, context = '') {
  const normalized = source.replace(/\r\n?/gu, '\n').trim();
  const digest = createHash('sha256').update(`${kind}\0${context}\0${normalized}`).digest('hex').slice(0, 24);
  return { id: `${kind}:${digest}`, sample: `${context ? `${context}: ` : ''}${normalized.replace(/\s+/gu, ' ').slice(0, 120)}` };
}

function record(sites, kind, source, context = '') {
  const { id, sample } = signature(kind, source, context);
  const existing = sites.get(id);
  if (existing) existing.count += 1;
  else sites.set(id, { id, count: 1, sample });
}

function collectScriptSites(source, filename) {
  const sites = new Map();
  const scriptKind = filename.endsWith('.tsx') ? ts.ScriptKind.TSX
    : filename.endsWith('.jsx') ? ts.ScriptKind.JSX
      : /\.(?:ts|mts|cts)$/u.test(filename) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind);
  const processAliases = new Set(processNames);
  const processNamespaces = new Set();
  const commandAliases = new Set(commandNames);

  function contextOf(node) {
    const names = [];
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isClassDeclaration(parent) && parent.name) names.push(`class ${parent.name.text}`);
      else if (ts.isFunctionDeclaration(parent) && parent.name) names.push(`function ${parent.name.text}`);
      else if (ts.isMethodDeclaration(parent) && parent.name) names.push(`method ${parent.name.getText(ast)}`);
      else if (ts.isConstructorDeclaration(parent)) names.push('constructor');
      else if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
        && parent.initializer && (ts.isArrowFunction(parent.initializer) || ts.isFunctionExpression(parent.initializer))) {
        names.push(`function ${parent.name.text}`);
      }
    }
    return names.reverse().join(' > ') || 'module';
  }

  function isProcessPackage(node) {
    return node && ts.isStringLiteralLike(node) && processPackages.has(node.text);
  }

  function inspectImport(node) {
    if (!ts.isImportDeclaration(node) || !isProcessPackage(node.moduleSpecifier)) return;
    record(sites, 'process-import', node.getText(ast), 'module');
    const clause = node.importClause;
    if (clause?.name) processAliases.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) processNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) processAliases.add(element.name.text);
    }
  }

  function inspectVariable(node) {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return false;
    const initializer = node.initializer;
    const requireProcess = ts.isCallExpression(initializer)
      && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'require'
      && isProcessPackage(initializer.arguments[0]);
    const name = ts.isIdentifier(node.name) ? node.name.text : null;
    let changed = false;
    if (requireProcess) {
      if (name && !processNamespaces.has(name)) { processNamespaces.add(name); changed = true; }
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const alias = element.name;
          if (ts.isIdentifier(alias) && !processAliases.has(alias.text)) {
            processAliases.add(alias.text);
            changed = true;
          }
        }
      }
    }
    if (!name) return changed;
    if (ts.isIdentifier(initializer)) {
      if (processAliases.has(initializer.text) && !processAliases.has(name)) {
        processAliases.add(name);
        changed = true;
      }
      if (processNamespaces.has(initializer.text) && !processNamespaces.has(name)) {
        processNamespaces.add(name);
        changed = true;
      }
      if (commandAliases.has(initializer.text) && !commandAliases.has(name)) {
        commandAliases.add(name);
        changed = true;
      }
    }
    if (ts.isPropertyAccessExpression(initializer) && ts.isIdentifier(initializer.expression)
      && processNamespaces.has(initializer.expression.text)
      && (processNames.has(initializer.name.text) || initializer.name.text === 'exec')
      && !processAliases.has(name)) {
      processAliases.add(name);
      changed = true;
    }
    if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)
      && initializer.expression.text === 'promisify'
      && initializer.arguments.some((argument) => ts.isIdentifier(argument) && processAliases.has(argument.text))
      && !processAliases.has(name)) {
      processAliases.add(name);
      changed = true;
    }
    return changed;
  }

  const variables = [];
  function gather(node) {
    inspectImport(node);
    if (ts.isVariableDeclaration(node)) variables.push(node);
    ts.forEachChild(node, gather);
  }
  gather(ast);
  // Resolve short alias chains regardless of declaration order.
  for (let pass = 0; pass <= variables.length; pass += 1) {
    let changed = false;
    for (const variable of variables) changed = inspectVariable(variable) || changed;
    if (!changed) break;
  }

  function isLaunchExpression(expression) {
    if (ts.isIdentifier(expression)) return processAliases.has(expression.text);
    if (ts.isPropertyAccessExpression(expression)) {
      if (processNames.has(expression.name.text)) return true;
      if (expression.name.text === 'exec' && ts.isIdentifier(expression.expression)
        && processNamespaces.has(expression.expression.text)) return true;
    }
    if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)
      && processNamespaces.has(expression.expression.text)
      && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)
      && (processNames.has(expression.argumentExpression.text) || expression.argumentExpression.text === 'exec')) return true;
    // Handles promisify(execFile)(...) without relying on the wrapper variable name.
    if (ts.isCallExpression(expression)) return expression.arguments.some((argument) =>
      ts.isIdentifier(argument) && processAliases.has(argument.text));
    return false;
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && expression.text === 'require' && isProcessPackage(node.arguments[0])) {
        record(sites, 'process-import', node.getText(ast), contextOf(node));
      } else if (expression.kind === ts.SyntaxKind.ImportKeyword && isProcessPackage(node.arguments[0])) {
        record(sites, 'process-import', node.getText(ast), contextOf(node));
      }
      if (isLaunchExpression(expression)) {
        record(sites, 'process-launch', node.getText(ast), contextOf(node));
      } else if (ts.isIdentifier(expression) && commandAliases.has(expression.text)) {
        record(sites, `command-${expression.text}`, node.getText(ast), contextOf(node));
      } else if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
        && /^git(?:\.exe)?$/iu.test(node.arguments[0].text)) {
        record(sites, 'command-git-literal', node.getText(ast), contextOf(node));
      }
    } else if (ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'Command' && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Deno') {
      record(sites, 'process-launch', node.getText(ast), contextOf(node));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return [...sites.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function collectShellSites(source) {
  const sites = new Map();
  const logicalLines = [];
  for (const line of source.replace(/\r\n?/gu, '\n').split('\n')) {
    const previous = logicalLines.at(-1);
    if (previous?.endsWith('\\')) logicalLines[logicalLines.length - 1] = `${previous}\n${line}`;
    else logicalLines.push(line);
  }
  for (const line of logicalLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('REM ') || trimmed.startsWith('::')) continue;
    if (/\bgit(?:\.exe)?\b|\b(?:eval|exec|bash|sh|pwsh|powershell|cmd|xargs)\b|\$\{?[^\s}"']*git[^\s}"']*\}?/iu.test(trimmed)) {
      record(sites, 'shell-process', trimmed);
    }
  }
  return [...sites.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function collectExecutionSites(source, filename) {
  return shellExtensions.has(path.extname(filename).toLowerCase())
    ? collectShellSites(source) : collectScriptSites(source, filename);
}

export function collectPackageScriptSites(packageJsonSource) {
  const sites = new Map();
  const scripts = JSON.parse(packageJsonSource).scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command === 'string') record(sites, 'package-script', `${name}: ${command}`);
  }
  return [...sites.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function sourceFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue;
    const relative = [prefix, entry.name].filter(Boolean).join('/');
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute, relative));
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name).toLowerCase())) files.push(relative);
  }
  return files;
}

export async function collectProductionSites(repositoryRoot = root) {
  const files = [];
  for (const directory of productionDirectories) {
    for (const relative of await sourceFiles(path.join(repositoryRoot, directory), directory)) files.push(relative);
  }
  for (const entry of await readdir(repositoryRoot, { withFileTypes: true })) {
    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name).toLowerCase())) files.push(entry.name);
  }
  const byFile = {};
  for (const file of files.sort()) {
    if (excludedAuditFiles.has(file)) continue;
    const sites = collectExecutionSites(await readFile(path.join(repositoryRoot, file), 'utf8'), file);
    if (sites.length) byFile[file] = sites;
  }
  for (const file of ['package.json', 'apps/vscode/package.json']) {
    const sites = collectPackageScriptSites(await readFile(path.join(repositoryRoot, file), 'utf8'));
    if (sites.length) byFile[file] = sites;
  }
  return byFile;
}

export function summarizeSites(sitesByFile) {
  const summary = {};
  for (const [file, sites] of Object.entries(sitesByFile)) {
    const counts = {};
    for (const site of sites) {
      const kind = site.id.split(':')[0];
      counts[kind] = (counts[kind] ?? 0) + site.count;
    }
    const signed = sites.map(({ id, count }) => `${id}:${count}`).sort().join('\n');
    summary[file] = {
      counts,
      digest: createHash('sha256').update(signed).digest('hex')
    };
  }
  return summary;
}

export function compareWithBaseline(actual, baseline) {
  const problems = [];
  const owners = new Set(REGISTERED_OWNERS);
  const current = summarizeSites(actual);
  for (const file of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    if (owners.has(file)) continue;
    const sites = current[file];
    const allowed = baseline[file];
    if (!allowed || !sites || allowed.digest !== sites.digest) {
      problems.push(`${file}: production process/Git sites differ from reviewed baseline (observed ${JSON.stringify(sites?.counts ?? {})}, baseline ${JSON.stringify(allowed?.counts ?? {})}). Run --print-sites ${file} to review.`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const actual = await collectProductionSites();
  if (process.argv.includes('--print-baseline')) {
    process.stdout.write(`${JSON.stringify({ version: 1, registeredOwners: REGISTERED_OWNERS, sites: summarizeSites(actual) }, null, 2)}\n`);
  } else if (process.argv.includes('--print-sites')) {
    const file = process.argv[process.argv.indexOf('--print-sites') + 1];
    if (!file || !actual[file]) {
      console.error(`No observed production process/Git sites in ${file ?? '(missing path)'}`);
      process.exitCode = 2;
    } else {
      process.stdout.write(`${JSON.stringify(actual[file], null, 2)}\n`);
    }
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    const problems = baseline.version === 1
      && JSON.stringify(baseline.registeredOwners) === JSON.stringify(REGISTERED_OWNERS)
      && baseline.sites && typeof baseline.sites === 'object'
      ? compareWithBaseline(actual, baseline.sites)
      : ['Baseline version or registered owner map differs from the audit contract.'];
    if (problems.length) {
      console.error(`GAL Git bypass audit failed (${problems.length} new site${problems.length === 1 ? '' : 's'}):\n${problems.join('\n')}`);
      process.exitCode = 1;
    } else {
      const allowed = Object.values(actual).flat().reduce((sum, site) => sum + site.count, 0);
      console.log(`GAL Git bypass audit: ${allowed} observed production process/Git sites; no new sites outside registered owners.`);
    }
  }
}
