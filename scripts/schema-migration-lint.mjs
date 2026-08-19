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

function callName(node) {
  if (!ts.isCallExpression(node)) return null;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function indirectWriterLiterals(file, source) {
  const sourceFile = ts.createSourceFile(file, String(source), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const sourceLines = String(source).split(/\r?\n/);
  const declarations = new Map();
  const collectDeclarations = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (!declarations.has(node.name.text)) declarations.set(node.name.text, []);
      declarations.get(node.name.text).push(node.initializer);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);

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
      for (const finding of indirectWriterLiterals(file, source)) violations.push({
        file, line: finding.line,
        message: 'durable writer schemaVersion literals must use currentSchemaVersion(family) from the migration registry; mark a proven transport-only shape schema-transient'
      });
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!VERSION_BRANCH_HOME.has(file)
          && (/schemaVersion\s*(?:===|!==|==|!=|<=|>=|<|>)/.test(line)
            || /switch\s*\([^)]*schemaVersion/.test(line)
            || /(?:includes|has)\s*\([^)]*schemaVersion/.test(line))) {
        // Result envelopes are validated at their transport boundary; they are never re-opened as
        // durable records. Their two validators are the only explicit branching exceptions.
        const transientBoundary = (file === 'src/gateway/result.mjs' || file === 'src/narration/command-result.mjs')
          && /schemaVersion\s*!==/.test(line);
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
