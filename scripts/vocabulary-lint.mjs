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

function symbolicMember(node, sourceFile) {
  if (!ts.isPropertyAccessExpression(node)) return null;
  if (node.expression.getText(sourceFile) !== 'LIFECYCLE_EVENT') return null;
  return { symbol: node.name.text, value: LIFECYCLE_EVENT[node.name.text] ?? null };
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
    const visit = (node) => {
      if (ts.isCallExpression(node) && PRODUCER_EVENT_ARGUMENT.has(callName(node))) {
        const boundary = callName(node);
        const argument = resolveValue(node.arguments[PRODUCER_EVENT_ARGUMENT.get(boundary)], node.getStart(sourceFile), declarations);
        const memberNode = lifecycleType(argument, sourceFile);
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
          const symbolic = symbolicMember(memberNode, sourceFile);
          if (symbolic && !symbolic.value) violations.push({
            file,
            line,
            code: 'VOCABULARY_MEMBER_UNKNOWN',
            vocabulary: LIFECYCLE_EVENT_VOCABULARY.id,
            member: symbolic.symbol,
            boundary,
            message: `unknown lifecycle symbol LIFECYCLE_EVENT.${symbolic.symbol} at ${boundary}()`
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

