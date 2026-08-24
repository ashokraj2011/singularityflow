#!/usr/bin/env node
/** Static producer guard for closed first-party symbolic vocabularies. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

import {
  LIFECYCLE_EVENT, LIFECYCLE_EVENT_VOCABULARY
} from '../src/vocabularies/catalog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCER_EVENT_ARGUMENT = new Map([
  ['lifecycleEvent', 0],
  ['commitAndPublish', 3],
  ['commitInitiativeChange', 3],
  ['transactStory', 3],
  ['transactInitiative', 3]
]);

// These are the audited runtime validation adapters. They accept an already-created event draft,
// add the governed subject/actor envelope, and immediately pass it through lifecycleEvent(). They
// are not member producers, so their dynamic forwarding is the one centrally registered exception.
const TRUSTED_DYNAMIC_FORWARDERS = new Map([
  ['src/lifecycle-event.mjs', new Set(['assertLifecycleEvent'])],
  ['src/state.mjs', new Set(['commitAndPublish'])],
  ['src/initiative-state.mjs', new Set(['commitInitiativeChange'])],
  ['src/state-stores.mjs', new Set(['publish'])],
  // CLI Initiative transitions are deliberately executed inside this single publication adapter.
  // The adapter forwards the already-created draft to commitInitiativeChange(), whose runtime
  // lifecycleEvent() validation remains the closed-vocabulary authority.
  ['src/cli.mjs', new Set(['transactInitiativeCommand'])]
]);

function containingFunctionName(node) {
  let current = node.parent;
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isMethodDeclaration(current))
        && current.name) return propertyName(current.name, current.getSourceFile());
    if (ts.isArrowFunction(current) && ts.isVariableDeclaration(current.parent)
        && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
    current = current.parent;
  }
  return null;
}

function callName(node) {
  if (!ts.isCallExpression(node)) return null;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function normalizedName(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function sourceEntries(sources) {
  if (sources instanceof Map) return [...sources.entries()];
  if (Array.isArray(sources)) return sources;
  return Object.entries(sources ?? {});
}

function propertyName(node, sourceFile) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node)) return node.text;
  return node.getText(sourceFile);
}

function declarationIndex(sourceFile) {
  const declarations = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const values = declarations.get(node.name.text) ?? [];
      values.push(node.initializer);
      declarations.set(node.name.text, values);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function resolveValue(node, before, declarations, seen = new Set()) {
  if (!node || !ts.isIdentifier(node)) return node;
  const initializer = (declarations.get(node.text) ?? [])
    .filter((candidate) => candidate.getStart() < before)
    .at(-1);
  const key = initializer ? `${node.text}:${initializer.getStart()}` : null;
  if (!initializer || seen.has(key)) return node;
  return resolveValue(initializer, before, declarations, new Set(seen).add(key));
}

function lifecycleType(object, sourceFile) {
  if (!ts.isObjectLiteralExpression(object)) return null;
  const assignment = object.properties.find((property) =>
    ts.isPropertyAssignment(property) && propertyName(property.name, sourceFile) === 'type');
  return assignment?.initializer ?? null;
}

function lifecycleSymbolRoots(sourceFile) {
  const roots = new Set(['LIFECYCLE_EVENT']);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings
        || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    for (const specifier of statement.importClause.namedBindings.elements) {
      if ((specifier.propertyName?.text ?? specifier.name.text) === 'LIFECYCLE_EVENT') {
        roots.add(specifier.name.text);
      }
    }
  }
  return roots;
}

function symbolicMember(node, sourceFile, roots) {
  if (ts.isPropertyAccessExpression(node) && roots.has(node.expression.getText(sourceFile))) {
    return { symbol: node.name.text, value: LIFECYCLE_EVENT[node.name.text] ?? null };
  }
  if (ts.isElementAccessExpression(node) && roots.has(node.expression.getText(sourceFile))
      && ts.isStringLiteralLike(node.argumentExpression)) {
    const symbol = node.argumentExpression.text;
    return { symbol, value: LIFECYCLE_EVENT[symbol] ?? null };
  }
  return null;
}

function ownedSymbolicMembers(node, sourceFile, roots) {
  if (ts.isParenthesizedExpression(node)) return ownedSymbolicMembers(node.expression, sourceFile, roots);
  if (ts.isConditionalExpression(node)) {
    const left = ownedSymbolicMembers(node.whenTrue, sourceFile, roots);
    const right = ownedSymbolicMembers(node.whenFalse, sourceFile, roots);
    return left && right ? [...left, ...right] : null;
  }
  const member = symbolicMember(node, sourceFile, roots);
  return member ? [member] : null;
}

/**
 * Find only actual lifecycle producer arguments. Strings in docs, fixtures, errors, and ordinary
 * objects are intentionally outside this adapter and cannot create false repository-wide locks.
 */
export function vocabularyProducerLint(sources) {
  const violations = [];
  for (const [rawName, source] of sourceEntries(sources)) {
    const file = normalizedName(rawName);
    if (!file.startsWith('src/') || !file.endsWith('.mjs')) continue;
    const sourceFile = ts.createSourceFile(file, String(source), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declarations = declarationIndex(sourceFile);
    const symbolRoots = lifecycleSymbolRoots(sourceFile);
    const visit = (node) => {
      if (ts.isCallExpression(node) && PRODUCER_EVENT_ARGUMENT.has(callName(node))) {
        const boundary = callName(node);
        const forwarder = containingFunctionName(node);
        if (TRUSTED_DYNAMIC_FORWARDERS.get(file)?.has(forwarder)) {
          ts.forEachChild(node, visit);
          return;
        }
        const argument = resolveValue(node.arguments[PRODUCER_EVENT_ARGUMENT.get(boundary)], node.getStart(sourceFile), declarations);
        const unresolvedMember = lifecycleType(argument, sourceFile);
        const memberNode = resolveValue(unresolvedMember, node.getStart(sourceFile), declarations);
        const line = sourceFile.getLineAndCharacterOfPosition((memberNode ?? argument ?? node).getStart(sourceFile)).line + 1;
        if (memberNode && ts.isStringLiteralLike(memberNode)) {
          const member = memberNode.text;
          const known = Boolean(LIFECYCLE_EVENT_VOCABULARY.descriptors[member]);
          violations.push({
            file,
            line,
            code: known ? 'VOCABULARY_PRODUCER_LITERAL' : 'VOCABULARY_MEMBER_UNKNOWN',
            vocabulary: LIFECYCLE_EVENT_VOCABULARY.id,
            member,
            boundary,
            message: known
              ? `direct lifecycle-event-type member '${member}' at ${boundary}(); use the LIFECYCLE_EVENT symbol from src/lifecycle-event.mjs`
              : `unregistered lifecycle-event-type member '${member}' at ${boundary}(); register it in ${LIFECYCLE_EVENT_VOCABULARY.id} or remove the invalid emitter`
          });
        } else if (memberNode) {
          const symbolics = ownedSymbolicMembers(memberNode, sourceFile, symbolRoots);
          const unknown = symbolics?.find((symbolic) => !symbolic.value);
          if (unknown) violations.push({
            file,
            line,
            code: 'VOCABULARY_MEMBER_UNKNOWN',
            vocabulary: LIFECYCLE_EVENT_VOCABULARY.id,
            member: unknown.symbol,
            boundary,
            message: `unknown lifecycle symbol LIFECYCLE_EVENT.${unknown.symbol} at ${boundary}()`
          });
          else if (!symbolics) violations.push({
            file,
            line,
            code: 'VOCABULARY_MEMBER_DYNAMIC',
            vocabulary: LIFECYCLE_EVENT_VOCABULARY.id,
            member: memberNode.getText(sourceFile),
            boundary,
            message: `lifecycle event type at ${boundary}() is not a provably owned LIFECYCLE_EVENT symbol`
          });
        } else {
          violations.push({
            file,
            line,
            code: 'VOCABULARY_MEMBER_DYNAMIC',
            vocabulary: LIFECYCLE_EVENT_VOCABULARY.id,
            member: null,
            boundary,
            message: `lifecycle event draft at ${boundary}() does not expose a provably owned type member`
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations;
}

async function repositorySources() {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'src/**/*.mjs', 'src/*.mjs'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (listed.status !== 0) throw new Error(listed.stderr.trim() || 'Unable to list source files.');
  const files = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort();
  return new Map(await Promise.all(files.map(async (file) => [file, await readFile(path.join(root, file), 'utf8')])));
}

export async function lintRepositoryVocabularies() {
  return vocabularyProducerLint(await repositorySources());
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const violations = await lintRepositoryVocabularies();
  if (violations.length) {
    for (const violation of violations) {
      process.stderr.write(`${violation.file}:${violation.line}: ${violation.code}: ${violation.message}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write('Closed vocabulary producer boundary is clean.\n');
  }
}
