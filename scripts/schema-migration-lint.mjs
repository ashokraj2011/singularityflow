#!/usr/bin/env node
/** Static guard for the durable-record migration boundary. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// These are wire/result/config shapes, not stored durable records. Keeping the exception explicit
// prevents an API envelope from forcing durable-history semantics while making a newly persisted
// family fail closed until it registers.
const TRANSIENT_SCHEMA_CONSTANTS = new Set([
  'src/gateway/context.mjs',
  'src/gateway/conversation.mjs',
  'src/gateway/handles.mjs',
  'src/gateway/home-projection-v2.mjs',
  'src/gateway/journey-contracts.mjs',
  'src/gateway/progress.mjs',
  'src/gateway/result.mjs',
  'src/gateway/tools.mjs',
  'src/impact-config.mjs',
  'src/narration/command-result.mjs',
  'src/personalization.mjs',
  'src/workspace-logs.mjs',
  'src/workspace.mjs'
]);

const VERSION_BRANCH_HOME = new Set([
  'src/schema-migrations.mjs',
  'src/schema-census.mjs'
]);

const DURABLE_WRITE_CALLS = new Set([
  'appendFile', 'atomicJson', 'writeAtomic', 'writeFile', 'writeJson', 'writeText'
]);

const REGISTERED_DIRECT_READ_MARKERS = Object.freeze([
  /(?:^|\/)workflow\.json$/
]);

function callName(node) {
  if (!ts.isCallExpression(node)) return null;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

/** Parse and index one source once for both durable-write and durable-read checks. */
function indexedSource(file, source) {
  const text = String(source);
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = new Map();
  const collectDeclarations = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (!declarations.has(node.name.text)) declarations.set(node.name.text, []);
      declarations.get(node.name.text).push(node.initializer);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);
  return { sourceFile, sourceLines: text.split(/\r?\n/), declarations };
}

function indirectWriterLiterals({ sourceFile, sourceLines, declarations }) {
  const findings = new Map();
  const inspectValue = (node, seen = new Set()) => {
    if (ts.isPropertyAssignment(node)
        && ['schemaVersion', "'schemaVersion'", '"schemaVersion"'].includes(node.name.getText(sourceFile))
        && ts.isNumericLiteral(node.initializer)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      if (!(sourceLines[line - 1] ?? '').includes('schema-transient')) findings.set(line, { line });
    }
    const parent = node.parent;
    const referenceIdentifier = ts.isIdentifier(node)
      && !(ts.isPropertyAssignment(parent) && parent.name === node)
      && !(ts.isVariableDeclaration(parent) && parent.name === node)
      && !(ts.isPropertyAccessExpression(parent) && parent.name === node)
      && !(ts.isFunctionDeclaration(parent) && parent.name === node);
    if (referenceIdentifier && declarations.has(node.text)) {
      const initializer = declarations.get(node.text)
        .filter((candidate) => candidate.getStart(sourceFile) < node.getStart(sourceFile))
        .at(-1);
      const key = initializer ? `${node.text}:${initializer.getStart(sourceFile)}` : null;
      if (initializer && !seen.has(key)) {
        inspectValue(initializer, new Set(seen).add(key));
        return;
      }
    }
    ts.forEachChild(node, (child) => inspectValue(child, seen));
  };
  const visit = (node) => {
    if (DURABLE_WRITE_CALLS.has(callName(node))) for (const argument of node.arguments) inspectValue(argument);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...findings.values()];
}

function directDurableReads({ sourceFile, declarations }) {
  const containsRegisteredPath = (node, before, seen = new Set()) => {
    if (ts.isStringLiteralLike(node)) {
      return REGISTERED_DIRECT_READ_MARKERS.some((pattern) => pattern.test(node.text.replaceAll('\\', '/')));
    }
    if (ts.isIdentifier(node) && declarations.has(node.text)) {
      const initializer = declarations.get(node.text)
        .filter((candidate) => candidate.getStart(sourceFile) < before)
        .at(-1);
      const key = initializer ? `${node.text}:${initializer.getStart(sourceFile)}` : null;
      if (initializer && !seen.has(key)) {
        return containsRegisteredPath(initializer, before, new Set(seen).add(key));
      }
    }
    let found = false;
    ts.forEachChild(node, (child) => { if (!found) found = containsRegisteredPath(child, before, seen); });
    return found;
  };
  const findings = [];
  const visit = (node) => {
    const jsonParse = ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(sourceFile) === 'JSON'
      && node.expression.name.text === 'parse';
    if (jsonParse) {
      const parsed = ts.isAwaitExpression(node.arguments[0]) ? node.arguments[0].expression : node.arguments[0];
      if (ts.isCallExpression(parsed) && callName(parsed) === 'readFile'
        && parsed.arguments[0] && containsRegisteredPath(parsed.arguments[0], node.getStart(sourceFile))) {
        findings.push({ line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function normalizedName(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function sourceEntries(sources) {
  if (sources instanceof Map) return [...sources.entries()];
  if (Array.isArray(sources)) return sources;
  return Object.entries(sources ?? {});
}

export function schemaMigrationLint(sources) {
  const violations = [];
  for (const [rawName, source] of sourceEntries(sources)) {
    const file = normalizedName(rawName);
    const lines = String(source).split(/\r?\n/);
    if (file === 'src/schema-migrations.mjs'
        && /(?:node:|model-runner|invokeModel|\.\/git\.mjs|\bfetch\s*\(|\bDate\b|Math\.random|randomUUID|process\.env)/.test(String(source))) {
      violations.push({
        file, line: 1,
        message: 'migration steps must remain pure and cannot access I/O, clocks, models, Git, randomness, or environment state'
      });
    }
    if (file !== 'src/schema-migrations.mjs') {
      // TypeScript parsing and declaration indexing dominate this repository-wide lint. Both AST
      // rules consume the same immutable index; rebuilding it for each rule doubled that work.
      // Most source modules contain neither a durable writer nor the one registered direct-read
      // marker. A conservative text admission check avoids constructing a TypeScript AST for those
      // files; the AST remains the authority whenever every token required by a finding is present.
      const text = String(source);
      const mayWriteLiteral = text.includes('schemaVersion')
        && [...DURABLE_WRITE_CALLS].some((name) => text.includes(name));
      const mayReadWorkflowDirectly = text.includes('workflow.json')
        && text.includes('JSON') && text.includes('parse') && text.includes('readFile');
      if (mayWriteLiteral || mayReadWorkflowDirectly) {
        const indexed = indexedSource(file, text);
        if (mayWriteLiteral) {
          for (const finding of indirectWriterLiterals(indexed)) violations.push({
            file, line: finding.line,
            message: 'durable writer schemaVersion literals must use currentSchemaVersion(family) from the migration registry; mark a proven transport-only shape schema-transient'
          });
        }
        if (mayReadWorkflowDirectly) {
          for (const finding of directDurableReads(indexed)) violations.push({
            file, line: finding.line,
            message: 'registered durable records must be loaded through readRecord(family) or their aggregate store'
          });
        }
      }
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!VERSION_BRANCH_HOME.has(file)
          && (/schemaVersion\s*(?:===|!==|==|!=|<=|>=|<|>)/.test(line)
            || /switch\s*\([^)]*schemaVersion/.test(line)
            || /(?:includes|has)\s*\([^)]*schemaVersion/.test(line))) {
        // Result envelopes are validated at their transport boundary; they are never re-opened as
        // durable records. Their two validators are the only explicit branching exceptions.
        const transientBoundary = line.includes('schema-transient')
          || ((file === 'src/gateway/result.mjs' || file === 'src/narration/command-result.mjs')
            && /schemaVersion\s*!==/.test(line));
        if (!transientBoundary) violations.push({
          file, line: index + 1,
          message: 'schemaVersion branching belongs in src/schema-migrations.mjs'
        });
      }
      if (!TRANSIENT_SCHEMA_CONSTANTS.has(file)
          && /(?:export\s+)?const\s+[A-Z][A-Z0-9_]*SCHEMA_VERSION\s*=\s*\d+\b/.test(line)) {
        violations.push({
          file, line: index + 1,
          message: 'durable schema constants must use currentSchemaVersion(family)'
        });
      }
      if (/(?:writeJson|atomicJson|writeAtomic|appendFile|writeFile)\s*\([^\n]*schemaVersion\s*:\s*\d+\b/.test(line)
          && !violations.some((violation) => violation.file === file && violation.line === index + 1)) {
        violations.push({
          file, line: index + 1,
          message: 'durable writes must stamp schemaVersion from the migration registry'
        });
      }
    }
  }
  return violations;
}

async function repositorySources() {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'src/**/*.mjs', 'src/*.mjs'], {
    cwd: root, encoding: 'utf8'
  });
  if (listed.status !== 0) throw new Error(listed.stderr.trim() || 'Unable to list source files.');
  const files = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort();
  return new Map(await Promise.all(files.map(async (file) => [file, await readFile(path.join(root, file), 'utf8')])));
}

export async function lintRepositorySchemas() {
  return schemaMigrationLint(await repositorySources());
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const violations = await lintRepositorySchemas();
  if (violations.length) {
    for (const violation of violations) process.stderr.write(`${violation.file}:${violation.line}: ${violation.message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Schema migration boundary is clean.\n');
  }
}
