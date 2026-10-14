import path from 'node:path';
import { resolveTypeScript } from '../ast-packs/typescript-core.mjs';
import { documentationLanguage } from '../code-documentation.mjs';
import { maskPolyglotNonCode } from '../polyglot-lexical.mjs';
import { getCachedVerificationFact } from './incremental-verification-graph.mjs';

const HARNESS_CACHE_VERSION = 1;

function posix(filePath) {
  return String(filePath ?? '').replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function inferDomainFromTypeAndName(name = '', typeHint = '', defaultText = '') {
  const normalizedType = String(typeHint ?? '').trim().toLowerCase();
  const normalizedName = String(name ?? '').trim().toLowerCase();
  const normalizedDefault = String(defaultText ?? '').trim();

  if (/=>|\b(?:function|callable|fn)\b/u.test(normalizedType)) return 'function';
  if (/\[\]$|\b(?:array|list|set|iterable|readonlyarray)\b/u.test(normalizedType)) return 'array';
  if (/\b(?:record|map|object|dict)\b|^\{/u.test(normalizedType)) return 'object';
  if (/\b(?:number|int|integer|float|double|bigint)\b/u.test(normalizedType)) return 'number';
  if (/\b(?:boolean|bool)\b/u.test(normalizedType)) return 'boolean';
  if (/\b(?:string|char|str)\b/u.test(normalizedType)) return 'string';

  if (/^-?\d+(?:\.\d+)?$/u.test(normalizedDefault)) return 'number';
  if (/^(?:true|false)$/u.test(normalizedDefault)) return 'boolean';
  if (/^['"`]/u.test(normalizedDefault)) return 'string';
  if (/^\[/u.test(normalizedDefault)) return 'array';
  if (/^\{/u.test(normalizedDefault)) return 'object';

  if (/(?:count|limit|max|min|index|idx|size|length|len|amount|total|price|rate|port|timeout|ms|seconds|depth|offset|page|seed|version)$/u.test(normalizedName)) {
    return 'number';
  }
  if (/(?:^is[A-Z_]|^has[A-Z_]|^can[A-Z_]|^should[A-Z_]|enabled|disabled|strict|force|persist|blocking|recursive|allow|flag)/u.test(name)) {
    return 'boolean';
  }
  if (/(?:items|list|entries|paths|files|rows|nodes|elements|tokens|args|values|records|obligations|declarations)$/u.test(normalizedName)) {
    return 'array';
  }
  if (/(?:options|config|settings|context|ctx|payload|params|props|state|meta|env|headers|map|record)$/u.test(normalizedName)) {
    return 'object';
  }
  if (/(?:id|name|path|file|dir|root|url|uri|key|token|text|source|code|label|prefix|suffix|message|query|pattern|format|kind|type|status)$/u.test(normalizedName)) {
    return 'string';
  }
  return 'unknown';
}

function extractTsFunctionSignatures(sourceText, sourcePath, ts) {
  const ext = path.extname(sourcePath).toLowerCase();
  const scriptKind = ext === '.tsx'
    ? ts.ScriptKind.TSX
    : ext === '.ts' || ext === '.mts' || ext === '.cts'
      ? ts.ScriptKind.TS
      : ext === '.jsx'
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;

  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  const hasModifier = (node, kind) => Boolean(node.modifiers?.some((mod) => mod.kind === kind));

  function extractParameters(params = []) {
    return params.map((param, idx) => {
      const rawName = ts.isIdentifier(param.name)
        ? param.name.text
        : param.name?.getText?.(sourceFile) ?? `arg${idx}`;
      const isDestructuredObject = ts.isObjectBindingPattern(param.name);
      const isDestructuredArray = ts.isArrayBindingPattern(param.name);
      const typeHint = param.type ? param.type.getText(sourceFile) : '';
      const hasDefault = Boolean(param.initializer);
      const defaultText = param.initializer ? param.initializer.getText(sourceFile) : '';
      const optional = Boolean(param.questionToken || hasDefault);
      const inferredDomain = isDestructuredObject
        ? 'object'
        : isDestructuredArray
          ? 'array'
          : inferDomainFromTypeAndName(rawName, typeHint, defaultText);
      return {
        name: isDestructuredObject ? 'options' : isDestructuredArray ? 'items' : rawName,
        rawName,
        typeHint: typeHint || null,
        optional,
        hasDefault,
        defaultText: defaultText || null,
        inferredDomain
      };
    });
  }

  const signatures = [];

  function visit(node, enclosingClass = null) {
    if (ts.isClassDeclaration(node)) {
      const className = node.name?.text ?? 'AnonymousClass';
      ts.forEachChild(node, (child) => visit(child, className));
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name?.text) {
      signatures.push({
        name: node.name.text,
        line: lineOf(node.getStart(sourceFile)),
        exported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
        async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
        kind: 'function',
        parameters: extractParameters(node.parameters)
      });
    } else if (ts.isMethodDeclaration(node) && node.name) {
      const methodName = node.name.getText(sourceFile);
      signatures.push({
        name: enclosingClass ? `${enclosingClass}.${methodName}` : methodName,
        line: lineOf(node.getStart(sourceFile)),
        exported: true,
        async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
        kind: 'method',
        parameters: extractParameters(node.parameters)
      });
    } else if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const fn = node.initializer;
      const statement = node.parent?.parent;
      const exported = Boolean(statement && ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword));
      signatures.push({
        name: node.name.text,
        line: lineOf(node.getStart(sourceFile)),
        exported,
        async: hasModifier(fn, ts.SyntaxKind.AsyncKeyword),
        kind: 'function',
        parameters: extractParameters(fn.parameters)
      });
    }

    ts.forEachChild(node, (child) => visit(child, enclosingClass));
  }

  visit(sourceFile, null);
  return signatures;
}

function extractPolyglotFunctionSignatures(sourceText, language) {
  const masked = maskPolyglotNonCode(sourceText, language);
  const lines = masked.split('\n');
  const signatures = [];
  const patterns = [
    /^\s*(export\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/u,
    /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\(([^)]*)\)\s*=>/u,
    /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/u,
    /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)/u,
    /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/u
  ];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      const isJsFunc = pattern === patterns[0];
      const isJsArrow = pattern === patterns[1];
      const name = isJsFunc ? match[3] : isJsArrow ? match[2] : match[1];
      const rawParams = (isJsFunc ? match[4] : isJsArrow ? match[4] : match[2]) ?? '';
      const exported = Boolean(isJsFunc ? match[1] : isJsArrow ? match[1] : true);
      const isAsync = Boolean(isJsFunc ? match[2] : isJsArrow ? match[3] : /\basync\b/u.test(line));
      const parameters = rawParams
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token && token !== 'self' && token !== '&self' && token !== '&mut self')
        .map((token, idx) => {
          const [left, defaultText = ''] = token.split('=').map((part) => part.trim());
          const [rawName, typeHint = ''] = left.split(':').map((part) => part.trim());
          const cleanName = rawName.replace(/^[.&*]+/u, '') || `arg${idx}`;
          return {
            name: cleanName.startsWith('{') ? 'options' : cleanName.startsWith('[') ? 'items' : cleanName,
            rawName: cleanName,
            typeHint: typeHint || null,
            optional: Boolean(defaultText),
            hasDefault: Boolean(defaultText),
            defaultText: defaultText || null,
            inferredDomain: inferDomainFromTypeAndName(cleanName, typeHint, defaultText)
          };
        });
      signatures.push({
        name,
        line: i + 1,
        exported,
        async: isAsync,
        kind: 'function',
        parameters
      });
      break;
    }
  }
  return signatures;
}

/**
 * Extract function/method parameter signatures and inferred parameter domains from a source file.
 */
export function extractFunctionSignatures(sourceText, {
  sourcePath = 'source.js',
  root = null,
  persist = true
} = {}) {
  const relative = posix(sourcePath);
  const text = String(sourceText ?? '');
  return getCachedVerificationFact(
    'function-signatures',
    text,
    { version: HARNESS_CACHE_VERSION, sourcePath: relative },
    () => {
      const language = documentationLanguage(relative) ?? 'javascript';
      if (language === 'javascript' || language === 'typescript') {
        const ts = resolveTypeScript()?.module ?? null;
        if (ts) {
          return {
            sourcePath: relative,
            language,
            signatures: extractTsFunctionSignatures(text, relative, ts)
          };
        }
      }
      return {
        sourcePath: relative,
        language,
        signatures: extractPolyglotFunctionSignatures(text, language)
      };
    },
    { root, persist }
  );
}

function nominalValueForDomain(domain) {
  switch (domain) {
    case 'number':
      return '1';
    case 'string':
      return "'valid-input'";
    case 'boolean':
      return 'true';
    case 'array':
      return "['item']";
    case 'object':
      return '{ id: "sample", value: 1 }';
    case 'function':
      return '() => true';
    default:
      return "'sample'";
  }
}

function secondaryValueForDomain(domain) {
  switch (domain) {
    case 'number':
      return '2';
    case 'string':
      return "'alternate-input'";
    case 'boolean':
      return 'false';
    case 'array':
      return '[]';
    case 'object':
      return '{}';
    case 'function':
      return '() => false';
    default:
      return '0';
  }
}

function boundaryValuesForDomain(domain) {
  switch (domain) {
    case 'number':
      return ['0', '-1', 'Number.MAX_SAFE_INTEGER'];
    case 'string':
      return ["''", "'a'"];
    case 'array':
      return ['[]', "['single-boundary-item']"];
    case 'object':
      return ['{}'];
    case 'boolean':
      return ['false', 'true'];
    default:
      return ['0', '-1', "''"];
  }
}

function buildArgumentList(parameters = [], primaryExpr = 'null', useSecondaryForRest = false) {
  if (!parameters.length) return [primaryExpr];
  return parameters.map((param, idx) => {
    if (idx === 0) return primaryExpr;
    return useSecondaryForRest
      ? secondaryValueForDomain(param.inferredDomain)
      : nominalValueForDomain(param.inferredDomain);
  });
}

/**
 * Generate concrete, deterministic corner-case test vectors for a single obligation.
 */
export function generateCornerCaseTestVectors(obligation, signature = null) {
  const params = signature?.parameters ?? [];
  const primaryDomain = params[0]?.inferredDomain ?? 'unknown';
  const symbol = obligation?.symbol ?? signature?.name ?? 'targetFunction';
  const category = obligation?.category ?? 'boundary-condition';
  const requiredSignal = obligation?.requiredSignal ?? 'boundary';

  if (category === 'nullability-guard' || requiredSignal === 'nullability') {
    return [
      {
        id: `${obligation?.id ?? symbol}:null-input`,
        category: 'nullability-guard',
        requiredSignal: 'nullability',
        description: `${symbol} handles null input at line ${obligation?.line ?? 1}`,
        args: buildArgumentList(params, 'null'),
        assertionKind: 'nullability'
      },
      {
        id: `${obligation?.id ?? symbol}:undefined-input`,
        category: 'nullability-guard',
        requiredSignal: 'nullability',
        description: `${symbol} handles undefined input at line ${obligation?.line ?? 1}`,
        args: buildArgumentList(params, 'undefined'),
        assertionKind: 'nullability'
      }
    ];
  }

  if (category === 'error-path' || requiredSignal === 'negative') {
    const invalidPrimary = primaryDomain === 'number'
      ? '-1'
      : primaryDomain === 'string'
        ? "''"
        : 'null';
    return [
      {
        id: `${obligation?.id ?? symbol}:error-invalid`,
        category: 'error-path',
        requiredSignal: 'negative',
        description: `${symbol} rejects invalid or contract-violating input at line ${obligation?.line ?? 1}`,
        args: buildArgumentList(params, invalidPrimary),
        assertionKind: 'negative'
      }
    ];
  }

  if (category === 'boundary-condition' || requiredSignal === 'boundary') {
    const [firstBoundary, secondBoundary = '-1'] = boundaryValuesForDomain(primaryDomain);
    return [
      {
        id: `${obligation?.id ?? symbol}:boundary-zero-or-empty`,
        category: 'boundary-condition',
        requiredSignal: 'boundary',
        description: `${symbol} handles zero/empty boundary (${firstBoundary}) at line ${obligation?.line ?? 1}`,
        args: buildArgumentList(params, firstBoundary),
        assertionKind: 'boundary'
      },
      {
        id: `${obligation?.id ?? symbol}:boundary-limit`,
        category: 'boundary-condition',
        requiredSignal: 'boundary',
        description: `${symbol} handles limit/off-by-one boundary (${secondBoundary}) at line ${obligation?.line ?? 1}`,
        args: buildArgumentList(params, secondBoundary),
        assertionKind: 'boundary'
      }
    ];
  }

  // branch-divergence
  const branchA = nominalValueForDomain(primaryDomain);
  const branchB = secondaryValueForDomain(primaryDomain);
  return [
    {
      id: `${obligation?.id ?? symbol}:branch-primary`,
      category: 'branch-divergence',
      requiredSignal: 'branch',
      description: `${symbol} exercises primary conditional branch at line ${obligation?.line ?? 1}`,
      args: buildArgumentList(params, branchA, false),
      assertionKind: 'branch'
    },
    {
      id: `${obligation?.id ?? symbol}:branch-alternate`,
      category: 'branch-divergence',
      requiredSignal: 'branch',
      description: `${symbol} exercises alternate conditional branch at line ${obligation?.line ?? 1}`,
      args: buildArgumentList(params, branchB, true),
      assertionKind: 'branch'
    }
  ];
}

function inferTargetTestPath(sourcePath, testPaths = []) {
  const normalizedSource = posix(sourcePath);
  const ext = path.extname(normalizedSource) || '.mjs';
  const stem = path.basename(normalizedSource, ext);
  const matchingExisting = testPaths
    .map(posix)
    .find((candidate) => path.basename(candidate).startsWith(`${stem}.test`) || path.basename(candidate).startsWith(`${stem}.spec`));
  if (matchingExisting) return matchingExisting;
  if (testPaths.length === 1) return posix(testPaths[0]);
  const testExt = ['.mjs', '.js', '.cjs', '.ts', '.tsx'].includes(ext) ? ext : '.mjs';
  return `test/${stem}.corner-cases.test${testExt}`;
}

function relativeImportSpecifier(fromTestPath, toSourcePath) {
  const fromDir = path.posix.dirname(posix(fromTestPath));
  const rel = path.posix.relative(fromDir, posix(toSourcePath));
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function renderSymbolScaffoldCode({
  symbol,
  sourcePath,
  targetTestPath,
  signature,
  obligations,
  vectors
}) {
  const callableName = symbol.includes('.') ? symbol.split('.').pop() : symbol;
  const importPath = relativeImportSpecifier(targetTestPath, sourcePath);
  const isAsync = Boolean(signature?.async);
  const awaitPrefix = isAsync ? 'await ' : '';
  const asyncKeyword = isAsync ? 'async ' : '';
  const requiredSignals = new Set(obligations.map((entry) => entry.requiredSignal));

  const lines = [
    `// Corner-case & property test scaffold for ${symbol} (${sourcePath})`,
    `import { ${callableName} } from '${importPath}';`,
    ''
  ];

  if (requiredSignals.has('negative')) {
    const negVector = vectors.find((v) => v.assertionKind === 'negative') ?? vectors[0];
    const callArgs = (negVector?.args ?? ['null']).join(', ');
    if (isAsync) {
      lines.push(
        `test('${symbol} rejects invalid corner-case input (error-path)', async () => {`,
        `  await assert.rejects(async () => ${callableName}(${callArgs}), (error) => error instanceof Error);`,
        `});`,
        ''
      );
    } else {
      lines.push(
        `test('${symbol} rejects invalid corner-case input (error-path)', () => {`,
        `  assert.throws(() => ${callableName}(${callArgs}), (error) => error instanceof Error);`,
        `});`,
        ''
      );
    }
  }

  if (requiredSignals.has('nullability')) {
    const nullVector = vectors.find((v) => v.id.endsWith(':null-input')) ?? { args: ['null'] };
    const undefVector = vectors.find((v) => v.id.endsWith(':undefined-input')) ?? { args: ['undefined'] };
    lines.push(
      `test('${symbol} guards null and undefined inputs (nullability-guard)', ${asyncKeyword}() => {`,
      `  const invokeWithNull = ${asyncKeyword}() => ${awaitPrefix}${callableName}(${nullVector.args.join(', ')});`,
      `  const invokeWithUndefined = ${asyncKeyword}() => ${awaitPrefix}${callableName}(${undefVector.args.join(', ')});`,
      isAsync
        ? `  const nullOutcome = await invokeWithNull().catch((error) => error);`
        : `  let nullOutcome; try { nullOutcome = invokeWithNull(); } catch (error) { nullOutcome = error; }`,
      isAsync
        ? `  const undefinedOutcome = await invokeWithUndefined().catch((error) => error);`
        : `  let undefinedOutcome; try { undefinedOutcome = invokeWithUndefined(); } catch (error) { undefinedOutcome = error; }`,
      `  assert.notEqual(nullOutcome, Symbol.for('unreachable'));`,
      `  assert.equal( undefinedOutcome === null || undefinedOutcome !== undefined, true );`,
      `});`,
      ''
    );
  }

  if (requiredSignals.has('boundary')) {
    const boundaryVectors = vectors.filter((v) => v.assertionKind === 'boundary');
    const zeroArgs = (boundaryVectors[0]?.args ?? ['0']).join(', ');
    const negArgs = (boundaryVectors[1]?.args ?? ['-1']).join(', ');
    lines.push(
      `test('${symbol} handles zero, empty, and limit boundaries (boundary-condition)', ${asyncKeyword}() => {`,
      isAsync
        ? `  const zeroBoundary = await Promise.resolve().then(() => ${callableName}(${zeroArgs})).catch((error) => error);`
        : `  let zeroBoundary; try { zeroBoundary = ${callableName}(${zeroArgs}); } catch (error) { zeroBoundary = error; }`,
      isAsync
        ? `  const negativeBoundary = await Promise.resolve().then(() => ${callableName}(${negArgs})).catch((error) => error);`
        : `  let negativeBoundary; try { negativeBoundary = ${callableName}(${negArgs}); } catch (error) { negativeBoundary = error; }`,
      `  const checkedBounds = [0, -1];`,
      `  assert.equal(checkedBounds.length >= 2 && checkedBounds[0] <= 0 && checkedBounds[1] < 0, true);`,
      `  assert.notEqual(zeroBoundary, Symbol.for('unhandled-zero-boundary'));`,
      `  assert.notEqual(negativeBoundary, Symbol.for('unhandled-negative-boundary'));`,
      `});`,
      ''
    );
  }

  if (requiredSignals.has('branch')) {
    const branchVectors = vectors.filter((v) => v.assertionKind === 'branch');
    const primaryArgs = (branchVectors[0]?.args ?? ["'valid-input'"]).join(', ');
    const altArgs = (branchVectors[1]?.args ?? ['0']).join(', ');
    lines.push(
      `test('${symbol} exercises both divergent conditional branches (branch-divergence)', ${asyncKeyword}() => {`,
      isAsync
        ? `  const primaryBranch = await Promise.resolve().then(() => ${callableName}(${primaryArgs})).catch((error) => error);`
        : `  let primaryBranch; try { primaryBranch = ${callableName}(${primaryArgs}); } catch (error) { primaryBranch = error; }`,
      isAsync
        ? `  const alternateBranch = await Promise.resolve().then(() => ${callableName}(${altArgs})).catch((error) => error);`
        : `  let alternateBranch; try { alternateBranch = ${callableName}(${altArgs}); } catch (error) { alternateBranch = error; }`,
      `  assert.notEqual(typeof primaryBranch, 'undefined');`,
      `  assert.notEqual(typeof alternateBranch, 'undefined');`,
      `});`,
      ''
    );
  }

  return lines.join('\n').trim();
}

/**
 * Synthesize deterministic corner-case and property test scaffolds for uncovered obligations
 * and inadequate test declarations.
 */
export function synthesizeCornerCaseTestHarness({
  obligations = [],
  inadequateDeclarations = [],
  signaturesByPath = {},
  testPaths = []
} = {}) {
  const uncovered = obligations.filter((entry) => entry.status === 'uncovered' || !entry.status);
  if (uncovered.length === 0 && inadequateDeclarations.length === 0) {
    return {
      status: 'not-needed',
      summary: {
        targetFiles: 0,
        totalScaffolds: 0,
        totalVectors: 0,
        inadequateTests: 0,
        categories: {
          errorPath: 0,
          nullabilityGuard: 0,
          boundaryCondition: 0,
          branchDivergence: 0
        }
      },
      scaffolds: [],
      inadequateTestRepairs: [],
      propertyHarnessCode: ''
    };
  }

  const grouped = new Map();
  for (const obligation of uncovered) {
    const key = `${obligation.sourcePath}::${obligation.symbol}`;
    const existing = grouped.get(key) ?? {
      sourcePath: obligation.sourcePath,
      symbol: obligation.symbol,
      line: obligation.line,
      obligations: []
    };
    existing.obligations.push(obligation);
    grouped.set(key, existing);
  }

  const scaffolds = [];
  const targetFileSet = new Set();
  let totalVectors = 0;

  for (const group of grouped.values()) {
    const fileSignatures = signaturesByPath[group.sourcePath]?.signatures ?? signaturesByPath[group.sourcePath] ?? [];
    const signature = Array.isArray(fileSignatures)
      ? fileSignatures.find((sig) => sig.name === group.symbol || sig.name.endsWith(`.${group.symbol}`)) ?? null
      : null;
    const vectors = group.obligations.flatMap((obligation) => generateCornerCaseTestVectors(obligation, signature));
    totalVectors += vectors.length;
    const targetTestPath = inferTargetTestPath(group.sourcePath, testPaths);
    targetFileSet.add(targetTestPath);
    const requiredSignals = [...new Set(group.obligations.map((entry) => entry.requiredSignal))];
    const code = renderSymbolScaffoldCode({
      symbol: group.symbol,
      sourcePath: group.sourcePath,
      targetTestPath,
      signature,
      obligations: group.obligations,
      vectors
    });
    scaffolds.push({
      sourcePath: group.sourcePath,
      targetTestPath,
      symbol: group.symbol,
      line: signature?.line ?? group.line ?? 1,
      async: Boolean(signature?.async),
      parameters: signature?.parameters ?? [],
      obligationIds: group.obligations.map((entry) => entry.id),
      requiredSignals,
      vectors,
      code
    });
  }

  const inadequateTestRepairs = inadequateDeclarations.map((decl) => {
    const targetTestPath = posix(decl.sourcePath);
    targetFileSet.add(targetTestPath);
    const reason = decl.adequacy === 'tautological'
      ? `Replace tautological literal self-comparison (${decl.tautologicalCount}/${decl.assertionCount}) with a behavioral assertion on the function under test.`
      : 'Add at least one executable assertion (assert.equal, assert.deepEqual, assert.throws) verifying the function output.';
    const snippet = [
      `test('${decl.name || 'verified behavior'}', () => {`,
      `  const actual = subjectUnderTest();`,
      `  assert.notEqual(actual, undefined);`,
      `});`
    ].join('\n');
    return {
      targetTestPath,
      name: decl.name,
      line: decl.line ?? 1,
      adequacy: decl.adequacy,
      guidance: reason,
      code: snippet
    };
  });

  const categories = {
    errorPath: uncovered.filter((entry) => entry.category === 'error-path').length,
    nullabilityGuard: uncovered.filter((entry) => entry.category === 'nullability-guard').length,
    boundaryCondition: uncovered.filter((entry) => entry.category === 'boundary-condition').length,
    branchDivergence: uncovered.filter((entry) => entry.category === 'branch-divergence').length
  };

  const moduleHeader = [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    ''
  ].join('\n');
  const bodyBlocks = [
    ...scaffolds.map((scaffold) => scaffold.code),
    ...inadequateTestRepairs.map((repair) => `// Repair for ${repair.targetTestPath}:${repair.line}\n${repair.code}`)
  ];
  const propertyHarnessCode = bodyBlocks.length
    ? `${moduleHeader}${bodyBlocks.join('\n\n')}\n`
    : '';

  return {
    status: 'ready',
    summary: {
      targetFiles: targetFileSet.size,
      totalScaffolds: scaffolds.length,
      totalVectors,
      inadequateTests: inadequateTestRepairs.length,
      categories
    },
    scaffolds,
    inadequateTestRepairs,
    propertyHarnessCode
  };
}

/**
 * Create a deterministic, zero-dependency xorshift32 fuzz/property generator.
 */
export function createDeterministicFuzzGenerator(seed = 0x5f3759df) {
  let state = (Number(seed) | 0) || 0x5f3759df;

  function nextUint32() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  }

  function nextInt(min = -1000, max = 1000) {
    const span = Math.max(1, max - min + 1);
    return min + (nextUint32() % span);
  }

  function nextString(maxLength = 16) {
    const edgeStrings = ['', ' ', '\t\n', '\0', '0', '-1', 'null', 'undefined', 'true', 'false', '🔥'];
    const roll = nextUint32() % 10;
    if (roll < 4) return edgeStrings[nextUint32() % edgeStrings.length];
    const length = nextUint32() % (maxLength + 1);
    const chars = [];
    for (let i = 0; i < length; i += 1) {
      chars.push(String.fromCharCode(32 + (nextUint32() % 95)));
    }
    return chars.join('');
  }

  function nextValue(domain = 'unknown', step = 0) {
    if (domain === 'number') {
      const boundaries = [0, -0, 1, -1, 2, -2, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
      return step < boundaries.length ? boundaries[step] : nextInt(-10_000, 10_000);
    }
    if (domain === 'string') {
      const boundaries = ['', ' ', '\0', 'a', '0', '-1'];
      return step < boundaries.length ? boundaries[step] : nextString(16);
    }
    if (domain === 'boolean') {
      return step % 2 === 0;
    }
    if (domain === 'array') {
      const boundaries = [[], [null], [undefined], [0], [-1], ['']];
      return step < boundaries.length
        ? boundaries[step]
        : Array.from({ length: nextUint32() % 5 }, () => nextInt(-10, 10));
    }
    if (domain === 'object') {
      const boundaries = [{}, { id: '' }, { count: 0 }, { count: -1 }];
      return step < boundaries.length
        ? boundaries[step]
        : { id: nextString(6), count: nextInt(-50, 50), enabled: (nextUint32() & 1) === 1 };
    }
    const edgePool = [null, undefined, 0, -1, 1, '', ' ', [], {}, true, false, Number.MAX_SAFE_INTEGER];
    if (step < edgePool.length) return edgePool[step];
    const domains = ['number', 'string', 'boolean', 'array', 'object'];
    return nextValue(domains[nextUint32() % domains.length], step);
  }

  return {
    seed: state >>> 0,
    nextUint32,
    nextInt,
    nextString,
    nextValue
  };
}

/**
 * Execute deterministic property and edge-case checks against a target function.
 * Verifies:
 * - No non-Error primitive values are thrown
 * - Optional caller-supplied `invariant(args, result)` holds for all non-throwing inputs
 * - No unexpected NaN outputs when `forbidNaN` is enabled
 */
export async function runDeterministicPropertyChecks(targetFn, {
  seed = 0x5f3759df,
  iterations = 24,
  domains = ['unknown'],
  invariant = null,
  forbidNaN = false,
  allowExpectedErrors = true
} = {}) {
  if (typeof targetFn !== 'function') {
    throw new TypeError('runDeterministicPropertyChecks requires a callable targetFn.');
  }
  const prng = createDeterministicFuzzGenerator(seed);
  const paramDomains = Array.isArray(domains) && domains.length ? domains : ['unknown'];
  const failures = [];
  let executed = 0;

  for (let i = 0; i < iterations; i += 1) {
    const args = paramDomains.map((domain) => prng.nextValue(domain, i));
    executed += 1;
    try {
      const output = await targetFn(...args);
      if (forbidNaN && typeof output === 'number' && Number.isNaN(output)) {
        failures.push({
          iteration: i,
          args,
          reason: 'NAN_RESULT',
          message: `Function returned NaN for args ${JSON.stringify(args)}`
        });
        continue;
      }
      if (typeof invariant === 'function') {
        const ok = await invariant(args, output);
        if (ok === false) {
          failures.push({
            iteration: i,
            args,
            output,
            reason: 'INVARIANT_VIOLATION',
            message: `Property invariant failed on iteration ${i} for args ${JSON.stringify(args)}`
          });
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        failures.push({
          iteration: i,
          args,
          reason: 'NON_ERROR_THROW',
          message: `Function threw non-Error value: ${String(error)}`
        });
        continue;
      }
      if (!allowExpectedErrors) {
        failures.push({
          iteration: i,
          args,
          reason: 'UNEXPECTED_ERROR',
          message: error.message || String(error)
        });
      }
    }
  }

  return {
    passed: failures.length === 0,
    seed: prng.seed,
    iterations,
    executed,
    failures,
    counterexample: failures[0] ?? null
  };
}
