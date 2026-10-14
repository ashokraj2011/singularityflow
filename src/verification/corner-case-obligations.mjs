/**
 * AST/Token-driven corner-case test obligation matrix and diff-scoped assertion adequacy gate.
 *
 * Step 2A: Extracts deterministic corner-case obligations from modified or added source hunks
 * (error/throw paths, nullability/empty guards, boundary comparisons, and branch divergence) using
 * the TypeScript compiler AST for JavaScript/TypeScript and lexical masking for polyglot sources.
 *
 * Step 2B: Evaluates test declarations and acceptance witnesses for assertion adequacy (detecting
 * zero-assertion and tautological tests) and joins diff-scoped source obligations against the
 * signals exercised by test declarations. Pure over source strings; bounded file readers for
 * preflight and draft-check projections.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { declarations as tsDeclarations, resolveTypeScript } from '../ast-packs/typescript-core.mjs';
import { isAllowedTestAutomationPath, isTestSourceName } from '../code-delivery-tests.mjs';
import { documentationLanguage, publicDeclarations } from '../code-documentation.mjs';
import { buildComprehensionDiffPreview } from '../comprehension/diff-preview.mjs';
import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { maskPolyglotNonCode } from '../polyglot-lexical.mjs';
import { runBoundedTaskPool } from '../quality-command-runner.mjs';
import { recordSha256 } from '../records.mjs';
import { buildRepositoryChangeSet } from '../repository-change-set.mjs';
import { isTestAutomationPath } from '../source-boundary.mjs';
import { posix } from '../util.mjs';
import {
  getCachedVerificationFact
} from './incremental-verification-graph.mjs';
import {
  extractFunctionSignatures,
  synthesizeCornerCaseTestHarness
} from './corner-case-harness.mjs';
import { scanJavaScriptDeclarations } from './javascript-declarations.mjs';

export const CORNER_CASE_CATEGORIES = Object.freeze([
  'error-path',
  'nullability-guard',
  'boundary-condition',
  'branch-divergence'
]);

export const CORNER_CASE_LIMITS = Object.freeze({
  files: 200,
  fileBytes: 512 * 1024,
  diffBytes: 2 * 1024 * 1024,
  advisories: 50
});

const REQUIRED_SIGNAL_BY_CATEGORY = Object.freeze({
  'error-path': 'negative',
  'nullability-guard': 'nullability',
  'boundary-condition': 'boundary',
  'branch-divergence': 'branch'
});

let cachedTypeScript = undefined;
function getTypeScript() {
  if (cachedTypeScript === undefined) {
    cachedTypeScript = resolveTypeScript()?.module ?? null;
  }
  return cachedTypeScript;
}

function scriptKind(ts, relativePath) {
  const ext = path.extname(String(relativePath ?? '')).toLowerCase();
  return ext === '.tsx' ? ts.ScriptKind.TSX
    : ext === '.jsx' ? ts.ScriptKind.JSX
      : ['.js', '.mjs', '.cjs'].includes(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function lineInScope(line, changedLines) {
  return !changedLines || changedLines.has(line);
}

function isGuardContext(ts, node) {
  let current = node.parent;
  while (current) {
    if (ts.isIfStatement(current) && current.expression === node) return true;
    if (ts.isConditionalExpression(current) && current.condition === node) return true;
    if (ts.isWhileStatement(current) && current.expression === node) return true;
    if (ts.isBinaryExpression(current) && [
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken
    ].includes(current.operatorToken.kind)) {
      node = current;
      current = current.parent;
      continue;
    }
    if (ts.isParenthesizedExpression(current)) {
      node = current;
      current = current.parent;
      continue;
    }
    break;
  }
  return false;
}

function extractTsCornerCaseObligations(ts, source, relativePath, changedLines) {
  const sf = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind(ts, relativePath));
  const { byNode } = tsDeclarations(ts, sf, relativePath);
  const seen = new Map();
  const add = (symbol, category, line, construct) => {
    if (!lineInScope(line, changedLines)) return;
    const key = `${symbol}:${category}:${line}`;
    if (seen.has(key)) return;
    seen.set(key, {
      id: `cc:${relativePath}#${symbol}:${category}:${line}`,
      sourcePath: relativePath,
      symbol,
      category,
      line,
      construct,
      requiredSignal: REQUIRED_SIGNAL_BY_CATEGORY[category]
    });
  };
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const stack = [{ node: sf, owner: null }];
  while (stack.length > 0) {
    const { node, owner } = stack.pop();
    const record = byNode.get(node);
    const current = record && ['function', 'method', 'constructor'].includes(record.kind) ? record : owner;
    const symbol = current?.qualifiedName ?? '<module>';
    const line = lineOf(node);

    if (ts.isThrowStatement(node)) {
      const exprText = node.expression ? node.expression.getText(sf).replace(/\s+/gu, ' ').trim().slice(0, 40) : 'error';
      add(symbol, 'error-path', line, `throw ${exprText}`);
    } else if (ts.isCatchClause(node)) {
      add(symbol, 'error-path', line, 'catch clause');
    } else if (ts.isCallExpression(node) && node.expression) {
      const callee = node.expression.getText(sf).replace(/\s+/gu, '');
      if (callee === 'Promise.reject' || callee.endsWith('.reject')) {
        add(symbol, 'error-path', line, `${callee}(...)`);
      } else if (['Number.isFinite', 'Number.isSafeInteger', 'Number.isInteger', 'Number.isNaN', 'Math.min', 'Math.max'].includes(callee)) {
        add(symbol, 'boundary-condition', line, `${callee}(...)`);
      }
    }

    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const opLine = sf.getLineAndCharacterOfPosition(node.operatorToken.getStart(sf)).line + 1;
      const leftText = node.left.getText(sf).trim();
      const rightText = node.right.getText(sf).trim();
      if ([
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken
      ].includes(op)) {
        const isNullish = (side, text) => side.kind === ts.SyntaxKind.NullKeyword || text === 'undefined' || text === 'null';
        if (isNullish(node.left, leftText) || isNullish(node.right, rightText)) {
          add(symbol, 'nullability-guard', opLine, `nullish check (${leftText} ${ts.tokenToString(op)} ${rightText})`.slice(0, 60));
        } else if (((leftText.endsWith('.length') || leftText.endsWith('.size')) && rightText === '0')
            || ((rightText.endsWith('.length') || rightText.endsWith('.size')) && leftText === '0')) {
          add(symbol, 'boundary-condition', opLine, `empty boundary (${leftText} ${ts.tokenToString(op)} ${rightText})`.slice(0, 60));
        }
      } else if ([
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.QuestionQuestionEqualsToken
      ].includes(op)) {
        add(symbol, 'nullability-guard', opLine, `nullish coalescing (${ts.tokenToString(op)})`);
      } else if ([
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken
      ].includes(op)) {
        add(symbol, 'boundary-condition', opLine, `boundary comparison (${leftText} ${ts.tokenToString(op)} ${rightText})`.slice(0, 60));
      }
    }

    if (node.questionDotToken) {
      add(symbol, 'nullability-guard', line, 'optional chaining (?.)');
    } else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && isGuardContext(ts, node)) {
      const operandText = node.operand.getText(sf).replace(/\s+/gu, ' ').trim().slice(0, 30);
      if (operandText.endsWith('.length') || operandText.endsWith('.size')) {
        add(symbol, 'boundary-condition', line, `empty boundary (!${operandText})`);
      } else {
        add(symbol, 'nullability-guard', line, `guard (!${operandText})`);
      }
    }

    if (ts.isIfStatement(node) && node.elseStatement) {
      add(symbol, 'branch-divergence', line, 'if/else branch divergence');
    } else if (ts.isSwitchStatement(node) && (node.caseBlock?.clauses?.length ?? 0) >= 2) {
      add(symbol, 'branch-divergence', line, 'switch multi-case branch');
    } else if (ts.isConditionalExpression(node)) {
      add(symbol, 'branch-divergence', line, 'ternary (? :) branch');
    }

    const children = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], owner: current });
    }
  }
  return [...seen.values()];
}

function extractLexicalCornerCaseObligations(source, relativePath, language, changedLines) {
  const masked = maskPolyglotNonCode(source, language);
  const lines = masked.split(/\r?\n/u);
  const decls = language ? publicDeclarations(source, language) : [];
  const symbolForLine = (line) => {
    let found = '<module>';
    for (const decl of decls) {
      if (decl.line <= line) found = decl.name;
      else break;
    }
    return found;
  };
  const seen = new Map();
  const add = (symbol, category, line, construct) => {
    if (!lineInScope(line, changedLines)) return;
    const key = `${symbol}:${category}:${line}`;
    if (seen.has(key)) return;
    seen.set(key, {
      id: `cc:${relativePath}#${symbol}:${category}:${line}`,
      sourcePath: relativePath,
      symbol,
      category,
      line,
      construct,
      requiredSignal: REQUIRED_SIGNAL_BY_CATEGORY[category]
    });
  };
  lines.forEach((rawLine, index) => {
    const line = index + 1;
    if (!lineInScope(line, changedLines)) return;
    const text = rawLine.trim();
    if (!text) return;
    const symbol = symbolForLine(line);
    if (/\b(?:throw|raise|panic)\b|\bcatch\b|\bexcept\b/u.test(text)) {
      add(symbol, 'error-path', line, 'error/exception path');
    }
    if (/\b(?:null|None|nil|undefined)\b|\?\?|\?\./u.test(text)) {
      add(symbol, 'nullability-guard', line, 'nullability/none check');
    }
    if (/(?:<=|>=|<|>)\s*-?\d+|\b(?:len|length|size)\b.*(?:==|===|<=)\s*0/u.test(text)) {
      add(symbol, 'boundary-condition', line, 'boundary comparison');
    }
    if (/^\s*(?:else\b|elif\b|case\b)/u.test(rawLine)) {
      add(symbol, 'branch-divergence', line, 'multi-branch control flow');
    }
  });
  return [...seen.values()];
}

function summarizeObligations(obligations) {
  const counts = {
    errorPath: 0,
    nullabilityGuard: 0,
    boundaryCondition: 0,
    branchDivergence: 0,
    total: obligations.length
  };
  for (const item of obligations) {
    if (item.category === 'error-path') counts.errorPath += 1;
    else if (item.category === 'nullability-guard') counts.nullabilityGuard += 1;
    else if (item.category === 'boundary-condition') counts.boundaryCondition += 1;
    else if (item.category === 'branch-divergence') counts.branchDivergence += 1;
  }
  return Object.freeze(counts);
}

/**
 * Extract deterministic corner-case obligations from a source file (optionally scoped to a Set of
 * 1-indexed `changedLines` from diff hunks). Uses the TypeScript AST for JS/TS and lexical masking
 * for polyglot languages.
 */
export function extractCornerCaseObligations(source, { sourcePath = 'source.js', changedLines = null, root = null, persist = false } = {}) {
  const relative = posix(sourcePath);
  const scopeList = changedLines instanceof Set
    ? [...changedLines].map(Number).sort((a, b) => a - b)
    : Array.isArray(changedLines)
      ? [...new Set(changedLines.map(Number))].sort((a, b) => a - b)
      : null;
  return getCachedVerificationFact(
    'corner-case-obligations',
    source,
    { sourcePath: relative, changedLines: scopeList },
    () => {
      const text = String(source ?? '');
      const language = documentationLanguage(relative);
      const ts = (language === 'javascript' || language === 'typescript') ? getTypeScript() : null;
      const scope = scopeList ? new Set(scopeList) : null;
      let assurance = ts ? 'ast-syntax' : 'lexical';
      let rawObligations = null;
      if (ts) {
        try {
          rawObligations = extractTsCornerCaseObligations(ts, text, relative, scope);
        } catch {
          assurance = 'lexical';
        }
      }
      if (!rawObligations) {
        rawObligations = extractLexicalCornerCaseObligations(text, relative, language ?? 'javascript', scope);
      }
      const obligations = rawObligations
        .sort((left, right) => left.line - right.line || left.category.localeCompare(right.category));
      return {
        sourcePath: relative,
        language: language ?? 'unknown',
        assurance,
        obligations,
        summary: summarizeObligations(obligations)
      };
    },
    { root, persist }
  );
}

/**
 * Inspect a test source file and return its declarations with assertion adequacy and corner-case
 * signals. Uses `scanJavaScriptDeclarations` for JS/TS and a lexical fallback for polyglot tests.
 */
export function analyzeTestFileSignals(source, { sourcePath = 'test.js', framework = 'jest', root = null, persist = false } = {}) {
  const relative = posix(sourcePath);
  return getCachedVerificationFact(
    'test-file-signals',
    source,
    { sourcePath: relative, framework },
    () => {
      const text = String(source ?? '');
      const language = documentationLanguage(relative);
      if (!language || language === 'javascript' || language === 'typescript') {
        const inferredFramework = framework === 'node:test' || /\bfrom\s+['"]node:test['"]/u.test(text) ? 'node:test' : framework;
        const scanned = scanJavaScriptDeclarations(text, { sourcePath: relative, framework: inferredFramework, root });
        return {
          sourcePath: relative,
          language: language ?? 'javascript',
          declarations: scanned.declarations.map((decl) => ({
            sourcePath: relative,
            name: decl.name,
            suitePath: decl.suitePath ?? [],
            line: decl.line,
            skipped: decl.skipped === true,
            clauseIds: decl.clauseIds ?? [],
            logicalTestId: decl.logicalTestId,
            assertions: decl.assertions ?? { count: 0, tautological: 0, negative: false, boundary: false, nullability: false, adequacy: 'missing' }
          }))
        };
      }
      const masked = maskPolyglotNonCode(text, language);
      const count = (masked.match(/\b(?:assert\w*|expect|should_panic|raises|Errorf|Fatalf|FailNow)\b/gu) ?? []).length;
      const negative = /\b(?:assertThrows|raises|should_panic|expectError|catch|except|rejects)\b/u.test(masked);
      const nullability = /\b(?:null|None|nil|assertNull|assertIsNone)\b/u.test(masked);
      const boundary = /(?:<=|>=|<|>|\b0\b|-1\b|\bMAX_|\bMIN_)/u.test(masked);
      return {
        sourcePath: relative,
        language,
        declarations: [{
          sourcePath: relative,
          name: path.basename(relative),
          suitePath: [],
          line: 1,
          skipped: false,
          clauseIds: [],
          logicalTestId: null,
          assertions: {
            count,
            tautological: 0,
            negative,
            boundary,
            nullability,
            adequacy: count > 0 ? 'adequate' : 'missing'
          }
        }]
      };
    },
    { root, persist }
  );
}

export function cornerCaseMatrixDigest(matrix) {
  const {
    matrixSha256,
    harness,
    obligations,
    uncoveredObligations,
    inadequateDeclarations,
    ...core
  } = matrix ?? {};
  return `sha256:${recordSha256(core)}`;
}

export function compactCornerCaseMatrix(matrix) {
  if (!matrix || typeof matrix !== 'object') return null;
  const compact = {
    schemaVersion: matrix.schemaVersion ?? 1,
    status: matrix.status,
    summary: matrix.summary,
    signals: matrix.signals
  };
  return {
    ...compact,
    matrixSha256: cornerCaseMatrixDigest(compact)
  };
}

/**
 * Evaluate extracted source corner-case obligations and test declaration assertion adequacy.
 */
export function evaluateCornerCaseObligationMatrix({
  obligations = [],
  declarations = [],
  signaturesByPath = {},
  testPaths = []
} = {}) {
  const activeDeclarations = declarations.filter((decl) => !decl.skipped);
  const inadequateDeclarations = activeDeclarations
    .filter((decl) => decl.assertions?.adequacy !== 'adequate')
    .map((decl) => ({
      sourcePath: decl.sourcePath,
      line: decl.line ?? null,
      name: decl.name ?? decl.sourcePath,
      clauseIds: decl.clauseIds ?? [],
      adequacy: decl.assertions?.adequacy ?? 'missing',
      assertionCount: decl.assertions?.count ?? 0,
      tautologicalCount: decl.assertions?.tautological ?? 0
    }));
  const adequateDeclarations = activeDeclarations.filter((decl) => decl.assertions?.adequacy === 'adequate');
  const totalAdequateAssertions = adequateDeclarations.reduce((sum, decl) =>
    sum + Math.max(0, (decl.assertions?.count ?? 0) - (decl.assertions?.tautological ?? 0)), 0);

  const hasSignal = {
    negative: adequateDeclarations.some((decl) => decl.assertions?.negative === true),
    nullability: adequateDeclarations.some((decl) => decl.assertions?.nullability === true || decl.assertions?.negative === true),
    boundary: adequateDeclarations.some((decl) => decl.assertions?.boundary === true),
    branch: adequateDeclarations.length >= 2 || totalAdequateAssertions >= 2
  };

  const evaluatedObligations = obligations.map((obligation) => {
    const covered = Boolean(hasSignal[obligation.requiredSignal]);
    return {
      ...obligation,
      status: covered ? 'covered' : 'uncovered'
    };
  });

  const coveredCount = evaluatedObligations.filter((entry) => entry.status === 'covered').length;
  const uncoveredObligations = evaluatedObligations.filter((entry) => entry.status === 'uncovered');
  const coverageRatio = evaluatedObligations.length === 0
    ? 1
    : Number((coveredCount / evaluatedObligations.length).toFixed(4));

  const findings = [];
  const advisories = [];

  for (const decl of inadequateDeclarations) {
    const where = `${decl.sourcePath}${decl.line ? `:${decl.line}` : ''}`;
    const label = decl.name ? `'${decl.name}' in ${where}` : where;
    const isTautological = decl.adequacy === 'tautological';
    const code = isTautological ? 'EVIDENCE_TEST_ASSERTION_TAUTOLOGICAL' : 'EVIDENCE_TEST_ASSERTION_MISSING';
    const message = isTautological
      ? `Test ${label} contains only tautological literal assertions (${decl.tautologicalCount}/${decl.assertionCount}); assert the behavior under test.`
      : `Test ${label} contains no executable assertions; add an assertion verifying the observable outcome.`;
    findings.push({
      code,
      category: 'verification-contracts',
      path: decl.sourcePath,
      line: decl.line,
      value: decl.name,
      clauseIds: decl.clauseIds,
      message
    });
    advisories.push(Object.freeze({
      code: isTautological ? 'code.verification.tautological-assertion' : 'code.verification.missing-assertion',
      category: 'verification-contracts',
      blocking: false,
      path: decl.sourcePath,
      line: decl.line,
      value: decl.name,
      message
    }));
  }

  for (const uncovered of uncoveredObligations) {
    const where = `${uncovered.sourcePath}:${uncovered.line}`;
    const signalAdvice = uncovered.requiredSignal === 'negative'
      ? 'add a negative/error test assertion (e.g. assert.throws, assert.rejects, or expect(...).toThrow)'
      : uncovered.requiredSignal === 'nullability'
        ? 'add a test exercising null, undefined, or empty input'
        : uncovered.requiredSignal === 'boundary'
          ? 'add a boundary-value test assertion (e.g. 0, -1, empty collection, or limit boundary)'
          : 'add assertions covering both branches of the conditional path';
    const message = `Changed ${uncovered.category} in ${uncovered.symbol} at ${where} (${uncovered.construct}) has no matching ${uncovered.requiredSignal} test signal; ${signalAdvice}.`;
    findings.push({
      code: 'EVIDENCE_CORNER_CASE_UNCOVERED',
      category: 'verification-contracts',
      path: uncovered.sourcePath,
      line: uncovered.line,
      value: uncovered.id,
      symbol: uncovered.symbol,
      obligationCategory: uncovered.category,
      message
    });
    advisories.push(Object.freeze({
      code: 'code.verification.corner-case-uncovered',
      category: 'verification',
      blocking: false,
      path: uncovered.sourcePath,
      line: uncovered.line,
      value: uncovered.symbol,
      obligationCategory: uncovered.category,
      message
    }));
  }

  const status = !evaluatedObligations.length && !activeDeclarations.length
    ? 'not-applicable'
    : (uncoveredObligations.length === 0 && inadequateDeclarations.length === 0)
      ? 'satisfied'
      : 'incomplete';

  const harness = synthesizeCornerCaseTestHarness({
    obligations: uncoveredObligations,
    inadequateDeclarations,
    signaturesByPath,
    testPaths
  });

  const core = {
    schemaVersion: 1,
    status,
    summary: {
      ...summarizeObligations(evaluatedObligations),
      covered: coveredCount,
      uncovered: uncoveredObligations.length,
      coverageRatio,
      inspectedDeclarations: activeDeclarations.length,
      adequateDeclarations: adequateDeclarations.length,
      inadequateDeclarations: inadequateDeclarations.length,
      totalAdequateAssertions
    },
    signals: hasSignal,
    obligations: evaluatedObligations,
    uncoveredObligations,
    inadequateDeclarations
  };
  return {
    matrix: { ...core, harness, matrixSha256: cornerCaseMatrixDigest(core) },
    harness,
    findings,
    advisories: advisories.slice(0, CORNER_CASE_LIMITS.advisories)
  };
}

function changedLinesByPath(preview) {
  const byPath = new Map();
  for (const file of preview?.files ?? []) {
    if (!file.pathAfter) continue;
    const lines = byPath.get(file.pathAfter) ?? new Set();
    for (const hunk of file.hunks ?? []) {
      for (let line = hunk.afterStart; line < hunk.afterStart + hunk.afterLines; line += 1) {
        lines.add(line);
      }
    }
    byPath.set(file.pathAfter, lines);
  }
  return byPath;
}

/**
 * Evaluate the diff-scoped corner-case obligation matrix and test assertion adequacy gate for a
 * code delivery candidate.
 */
export async function evaluateDeliveryCornerCaseGate(root, {
  changeSet = null,
  sourcePaths = [],
  testPaths = [],
  enforceCornerCases = false,
  enforceAssertionAdequacy = false
} = {}) {
  const entries = new Map((changeSet?.entries ?? []).flatMap((entry) =>
    [entry.newPath, entry.oldPath].filter(Boolean).map((candidate) => [candidate, entry])));
  const candidateSources = sourcePaths
    .filter((candidate) => !isAllowedTestAutomationPath(candidate) && !isTestSourceName(candidate))
    .slice(0, CORNER_CASE_LIMITS.files);
  const edited = candidateSources.filter((candidate) => {
    const entry = entries.get(candidate);
    return entry && !entry.untracked && entry.status !== 'added' && entry.status !== 'deleted';
  });
  const preview = edited.length && changeSet
    ? buildComprehensionDiffPreview(root, changeSet, {
      contextLines: 0,
      maximumBytes: CORNER_CASE_LIMITS.diffBytes,
      paths: edited
    })
    : { files: [] };
  const changedLines = changedLinesByPath(preview);

  const signaturesByPath = {};
  const { results: sourceObligationBatches } = await runBoundedTaskPool(
    candidateSources,
    async (relative) => {
      const entry = entries.get(relative);
      if (entry?.status === 'deleted') return [];
      const bytes = await readFile(path.join(root, ...relative.split('/'))).catch(() => null);
      if (!bytes || bytes.length > CORNER_CASE_LIMITS.fileBytes || bytes.includes(0)) return [];
      const whole = !entry || entry.untracked || entry.status === 'added';
      const lines = whole ? null : (changedLines.get(relative) ?? new Set());
      if (!whole && lines.size === 0) return [];
      const text = bytes.toString('utf8');
      const extracted = extractCornerCaseObligations(text, {
        sourcePath: relative,
        changedLines: lines,
        root,
        persist: false
      });
      if (extracted.obligations.length > 0) {
        signaturesByPath[relative] = extractFunctionSignatures(text, {
          sourcePath: relative,
          root,
          persist: false
        }).signatures;
      }
      return extracted.obligations;
    }
  );
  const allObligations = sourceObligationBatches.flat();

  const { results: testDeclarationBatches } = await runBoundedTaskPool(
    testPaths.slice(0, CORNER_CASE_LIMITS.files),
    async (relative) => {
      const bytes = await readFile(path.join(root, ...relative.split('/'))).catch(() => null);
      if (!bytes || bytes.length > CORNER_CASE_LIMITS.fileBytes || bytes.includes(0)) return [];
      const analyzed = analyzeTestFileSignals(bytes.toString('utf8'), {
        sourcePath: relative,
        root,
        persist: false
      });
      return analyzed.declarations;
    }
  );
  const allDeclarations = testDeclarationBatches.flat();

  const evaluated = evaluateCornerCaseObligationMatrix({
    obligations: allObligations,
    declarations: allDeclarations,
    signaturesByPath,
    testPaths
  });

  const blockingFindings = evaluated.findings.filter((finding) => {
    if (finding.code === 'EVIDENCE_CORNER_CASE_UNCOVERED') return enforceCornerCases;
    if (finding.code === 'EVIDENCE_TEST_ASSERTION_MISSING' || finding.code === 'EVIDENCE_TEST_ASSERTION_TAUTOLOGICAL') {
      return enforceAssertionAdequacy || enforceCornerCases;
    }
    return false;
  });

  return {
    matrix: evaluated.matrix,
    harness: evaluated.harness,
    matrixSha256: evaluated.matrix.matrixSha256,
    problems: blockingFindings.map((finding) => finding.message),
    findings: blockingFindings,
    allFindings: evaluated.findings,
    advisories: evaluated.advisories
  };
}

/**
 * Read-only inspection of diff-scoped corner-case obligations and test assertion adequacy for an
 * open code generation (used by `phaseDraftCheck`).
 */
export async function inspectCornerCaseObligations(root, config, workflow, phase) {
  try {
    if (!phaseRequiresCodeDelivery(phase) || phase.generationIntent?.status !== 'open') {
      return {
        cornerCases: Object.freeze({
          status: 'not-applicable',
          reason: !phaseRequiresCodeDelivery(phase) ? 'phase-does-not-deliver-code' : 'no-open-code-generation',
          blocking: false
        }),
        findings: [],
        advisories: []
      };
    }
    const baseCommit = phase.generationIntent?.baseline?.commit ?? workflow.workIntervals?.current?.sourceBaseCommit ?? null;
    if (!baseCommit) {
      return {
        cornerCases: Object.freeze({ status: 'unavailable', reason: 'generation-baseline-unknown', blocking: false }),
        findings: [],
        advisories: []
      };
    }
    const itemRoot = posix(config.workItemRoot ?? 'singularity/work-items');
    const changeSet = await buildRepositoryChangeSet(root, { baseCommit });
    const activeEntries = changeSet.entries.filter((entry) =>
      entry.newPath && entry.status !== 'deleted'
      && !entry.newPath.startsWith('singularity/')
      && !entry.newPath.startsWith(`${itemRoot}/`)
      && !entry.newPath.startsWith('.github/'));
    const sourcePaths = activeEntries
      .map((entry) => entry.newPath)
      .filter((candidate) => !isTestAutomationPath(candidate) && !isTestSourceName(candidate) && documentationLanguage(candidate));
    const testPaths = activeEntries
      .map((entry) => entry.newPath)
      .filter((candidate) => isTestAutomationPath(candidate) || isTestSourceName(candidate));
    const enforceCornerCases = Boolean(
      config.governance?.requireCornerCaseCoverage
      || workflow.resolution?.codeDelivery?.cornerCaseObligations === 'enforce'
    );
    const enforceAssertionAdequacy = Boolean(
      enforceCornerCases
      || config.governance?.requireAssertionAdequacy
      || workflow.resolution?.codeDelivery?.assertionAdequacy === 'enforce'
    );
    const gate = await evaluateDeliveryCornerCaseGate(root, {
      changeSet,
      sourcePaths,
      testPaths,
      enforceCornerCases,
      enforceAssertionAdequacy
    });
    return {
      cornerCases: Object.freeze({
        ...gate.matrix,
        blocking: enforceCornerCases || enforceAssertionAdequacy
      }),
      findings: gate.findings,
      advisories: gate.advisories
    };
  } catch (error) {
    return {
      cornerCases: Object.freeze({
        status: 'unavailable',
        reason: error?.code ?? 'inspection-failed',
        blocking: false
      }),
      findings: [],
      advisories: []
    };
  }
}
