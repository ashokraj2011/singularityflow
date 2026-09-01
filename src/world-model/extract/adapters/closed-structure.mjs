import path from 'node:path';

import { maskPolyglotNonCode } from './polyglot-lexical.mjs';

const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const SUPPORTED = new Set([
  'c', 'cpp', 'csharp', 'go', 'java', 'javascript', 'kotlin', 'php', 'python',
  'ruby', 'rust', 'swift', 'typescript'
]);

export const CLOSED_STRUCTURE_LANGUAGES = Object.freeze([...SUPPORTED].sort());
export const TEST_IDENTITY_LANGUAGES = Object.freeze([
  'csharp', 'go', 'java', 'javascript', 'kotlin', 'php', 'python', 'ruby', 'rust', 'typescript'
]);

function maskedSource(source, language) {
  // The reviewed C-like lexer also has the JavaScript comment and literal grammar needed by
  // these single-line recognizers. Passing csharp here keeps this module independent of a second
  // JavaScript masking implementation while still treating templates as opaque literals.
  return maskPolyglotNonCode(
    source,
    language === 'javascript' || language === 'typescript' ? 'csharp' : language
  );
}

function sourceLines(source, language) {
  const original = String(source).split(/\r?\n/);
  const masked = maskedSource(source, language).split(/\r?\n/);
  return original.map((raw, index) => ({ raw, code: masked[index] ?? '', line: index + 1 }));
}

function boundedSignature(value, language = null) {
  let signature = String(value).trim().replace(/\s+/g, ' ');
  const body = signature.indexOf('{');
  if (body >= 0) signature = signature.slice(0, body).trim();
  const arrow = signature.indexOf('=>');
  if (arrow >= 0) signature = signature.slice(0, arrow).trim();
  if (/^(?:export\s+)?(?:const|let|var|type)\b/.test(signature)) {
    const assignment = signature.indexOf('=');
    if (assignment >= 0) signature = signature.slice(0, assignment).trim();
  }
  if (language === 'python') {
    const suite = signature.lastIndexOf(':');
    if (suite >= 0) signature = signature.slice(0, suite).trim();
  }
  if (language === 'kotlin') {
    const expressionBody = signature.indexOf('=');
    if (expressionBody >= 0) signature = signature.slice(0, expressionBody).trim();
  }
  signature = signature.replace(/[;:]$/, '').trim();
  return signature && signature.length <= 240 ? signature : null;
}

function declaration(code, language) {
  let match;
  if (language === 'javascript' || language === 'typescript') {
    match = new RegExp(`^export\\s+(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(function\\*?|class|interface|type|enum|const|let|var)\\s+(${IDENTIFIER})`).exec(code);
    if (match) return { kind: match[1], name: match[2], exported: true };
  } else if (language === 'java' || language === 'csharp') {
    match = new RegExp(`^(public|protected)\\s+(?:(?:static|final|abstract|sealed|partial|virtual|override|async|synchronized|default)\\s+)*(class|interface|enum|record|struct|delegate)\\s+(${IDENTIFIER})`).exec(code);
    if (match) return { kind: match[2], name: match[3], exported: match[1] === 'public' };
    match = new RegExp(`^(public|protected)\\s+(?:(?:static|final|abstract|sealed|partial|virtual|override|async|synchronized|default)\\s+)*[\\w$<>,.?\\[\\]]+\\s+(${IDENTIFIER})\\s*\\(`).exec(code);
    if (match) return { kind: 'function', name: match[2], exported: match[1] === 'public' };
  } else if (language === 'kotlin') {
    match = new RegExp(`^(?:(public|protected|internal)\\s+)?(?:(?:data|sealed|enum)\\s+)?(class|interface|object|fun)\\s+(${IDENTIFIER})`).exec(code);
    if (match) return { kind: match[2], name: match[3], exported: match[1] === 'public' };
  } else if (language === 'python') {
    match = new RegExp(`^(?:async\\s+)?(def|class)\\s+(${IDENTIFIER})`).exec(code);
    if (match) return { kind: match[1], name: match[2], exported: false };
  } else if (language === 'go') {
    match = new RegExp(`^(func|type)\\s+(?:\\([^)]*\\)\\s*)?(${IDENTIFIER})`).exec(code);
    if (match) return { kind: match[1], name: match[2], exported: /^[A-Z]/.test(match[2]) };
  } else if (language === 'rust') {
    match = new RegExp(`^(pub(?:\\([^)]*\\))?\\s+)(struct|enum|trait|fn|type|mod)\\s+(${IDENTIFIER})`).exec(code);
    if (match) return { kind: match[2], name: match[3], exported: true };
  } else if (language === 'ruby') {
    match = /^((?:class|module|def))\s+([A-Za-z_]\w*[!?=]?)/.exec(code);
    if (match) return { kind: match[1], name: match[2], exported: false };
  } else if (language === 'php') {
    match = new RegExp(`^(?:(public|protected)\\s+)?(class|interface|trait|function)\\s+(${IDENTIFIER})`).exec(code.replace(/^<\?php\s*/, ''));
    if (match) return { kind: match[2], name: match[3], exported: match[1] === 'public' };
  } else if (language === 'swift') {
    match = new RegExp(`^(?:(public|open|internal)\\s+)?(class|struct|protocol|enum|actor|func)\\s+(${IDENTIFIER})`).exec(code);
    if (match) return { kind: match[2], name: match[3], exported: match[1] === 'public' || match[1] === 'open' };
  } else if (language === 'c' || language === 'cpp') {
    match = new RegExp(`^(?:(?:extern|inline|static|constexpr|virtual)\\s+)*[\\w:*&<>~,]+(?:\\s+[\\w:*&<>~,]+)*\\s+(${IDENTIFIER})\\s*\\([^;]*\\)`).exec(code);
    if (match) return { kind: 'function', name: match[1], exported: false };
    match = new RegExp(`^(?:class|struct|union|enum)\\s+(${IDENTIFIER})`).exec(code);
    if (match) return { kind: 'type', name: match[1], exported: false };
  }
  return null;
}

/** Closed, single-line declaration grammar. Returned signatures never include a source body. */
export function scanSignaturesAndExports(source, language) {
  if (!SUPPORTED.has(language)) return [];
  const found = [];
  for (const { code: rawCode, line } of sourceLines(source, language)) {
    // Indentation denotes a nested declaration for languages where a lexical top-level boundary is
    // meaningful. Method signatures in brace languages remain useful and are admitted separately.
    const code = rawCode.trim();
    if (!code) continue;
    if ((language === 'python' || language === 'ruby') && /^\s/.test(rawCode)) continue;
    const parsed = declaration(code, language);
    if (!parsed) continue;
    const signature = boundedSignature(code, language);
    if (!signature) continue;
    found.push({ ...parsed, signature, line });
  }
  return found.filter((item, index, values) => values.findIndex((candidate) => (
    candidate.line === item.line && candidate.name === item.name && candidate.signature === item.signature
  )) === index);
}

function names(value) {
  return String(value).split(',').map((item) => item.trim())
    .map((item) => item.replace(/<.*$/, '').replace(/\(.*$/, '').trim())
    .filter((item) => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(item));
}

/** Exact interface declarations and explicit implementation syntax; never inferred duck typing. */
export function scanInterfaceContracts(source, language) {
  if (!SUPPORTED.has(language)) return [];
  const found = [];
  for (const { code: rawCode, line } of sourceLines(source, language)) {
    const code = rawCode.trim();
    if (!code) continue;
    let match;
    if (['javascript', 'typescript', 'java', 'csharp', 'kotlin', 'php'].includes(language)) {
      match = /^(?:export\s+)?(?:(?:public|protected|internal)\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(code.replace(/^<\?php\s*/, ''));
      if (match) found.push({ kind: 'interface', name: match[1], signature: boundedSignature(code, language), line });
      match = /^(?:export\s+)?(?:(?:public|protected|internal|abstract|sealed|final)\s+)*class\s+([A-Za-z_$][\w$]*)[^\n{]*?\bimplements\s+([^\n{]+)/.exec(code.replace(/^<\?php\s*/, ''));
      if (match) for (const target of names(match[2])) {
        found.push({ kind: 'implementation', implementation: match[1], interface: target, line });
      }
    } else if (language === 'go') {
      match = /^type\s+([A-Za-z_]\w*)\s+interface\b/.exec(code);
      if (match) found.push({ kind: 'interface', name: match[1], signature: boundedSignature(code, language), line });
    } else if (language === 'rust') {
      match = /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/.exec(code);
      if (match) found.push({ kind: 'interface', name: match[1], signature: boundedSignature(code, language), line });
      match = /^impl(?:<[^>]+>)?\s+([A-Za-z_]\w*)\s+for\s+([A-Za-z_]\w*)/.exec(code);
      if (match) found.push({ kind: 'implementation', implementation: match[2], interface: match[1], line });
    } else if (language === 'swift') {
      match = /^(?:(?:public|internal|private)\s+)?protocol\s+([A-Za-z_]\w*)/.exec(code);
      if (match) found.push({ kind: 'interface', name: match[1], signature: boundedSignature(code, language), line });
    }
  }
  return found.filter((item, index, values) => values.findIndex((candidate) => (
    JSON.stringify(candidate) === JSON.stringify(item)
  )) === index);
}

/** Field/method declarations inside an explicit interface boundary, without implementation bodies. */
export function scanProtocolFields(source, language) {
  if (!SUPPORTED.has(language)) return [];
  const found = [];
  let active = null;
  let depth = 0;
  for (const { code: rawCode, line } of sourceLines(source, language)) {
    const code = rawCode.trim();
    if (!active) {
      const declaration = language === 'go'
        ? /^type\s+([A-Za-z_]\w*)\s+interface\b/.exec(code)
        : language === 'rust'
          ? /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/.exec(code)
          : language === 'swift'
            ? /^(?:(?:public|internal|private)\s+)?protocol\s+([A-Za-z_]\w*)/.exec(code)
            : /^(?:export\s+)?(?:(?:public|protected|internal)\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(code.replace(/^<\?php\s*/, ''));
      if (!declaration || !code.includes('{')) continue;
      active = declaration[1];
      depth = (code.match(/{/g)?.length ?? 0) - (code.match(/}/g)?.length ?? 0);
      if (depth <= 0) active = null;
      continue;
    }
    const before = depth;
    depth += (code.match(/{/g)?.length ?? 0) - (code.match(/}/g)?.length ?? 0);
    if (before === 1 && code && !code.startsWith('}')) {
      let match;
      if (language === 'typescript' || language === 'javascript') {
        match = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*(?:\([^)]*\))?\s*:/.exec(code)
          ?? /^([A-Za-z_$][\w$]*)\??\s*\([^)]*\)\s*:/.exec(code);
      } else if (language === 'kotlin') {
        match = /^(?:public\s+)?(?:fun|val|var)\s+([A-Za-z_]\w*)/.exec(code);
      } else if (language === 'rust') {
        match = /^(?:pub\s+)?(?:fn|type|const)\s+([A-Za-z_]\w*)/.exec(code);
      } else if (language === 'swift') {
        match = /^(?:public\s+)?(?:func|var|let)\s+([A-Za-z_]\w*)/.exec(code);
      } else if (language === 'go') {
        match = /^([A-Za-z_]\w*)\s*\(/.exec(code);
      } else {
        match = /^(?:(?:public|abstract|default|static)\s+)*[\w$<>,.?\[\]]+\s+([A-Za-z_$][\w$]*)\s*\(/.exec(code);
      }
      const signature = boundedSignature(code, language);
      if (match && signature) found.push({ interface: active, name: match[1], signature, line });
    }
    if (depth <= 0) { active = null; depth = 0; }
  }
  return found.filter((item, index, values) => values.findIndex((candidate) => (
    candidate.interface === item.interface && candidate.name === item.name && candidate.line === item.line
  )) === index);
}

export function isTestSourcePath(relative) {
  const normalized = String(relative).replaceAll('\\', '/');
  const basename = path.posix.basename(normalized).toLowerCase();
  return /(?:^|\/)(?:test|tests|__tests__)\//i.test(normalized)
    || /(?:\.test|\.spec)\.[^.]+$/i.test(basename)
    || /(?:^test_.*|.*_test)\.py$/i.test(basename)
    || /(?:test|tests)\.(?:java|kt|cs|php|rb|swift)$/i.test(basename)
    || /_test\.go$/i.test(basename);
}

function safeTitle(value) {
  const title = String(value).replace(/\\(['"\\])/g, '$1').replace(/\s+/g, ' ').trim();
  // Test titles enter a model-readable Fact claim. Keep the useful natural-language subset while
  // refusing Markdown/control syntax that could turn repository bytes into prompt instructions.
  return title && title.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9 .,_:/()'&+-]*$/.test(title)
    ? title
    : null;
}

/** Framework-declared test names only; arbitrary functions in test files are not promoted. */
export function scanTestIdentities(source, language) {
  if (!SUPPORTED.has(language)) return [];
  const lines = sourceLines(source, language);
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    const { raw, code: masked, line } = lines[index];
    const code = masked.trim();
    let match;
    if (language === 'javascript' || language === 'typescript') {
      if (!/\b(?:test|it|describe)\s*\(/.test(code)) continue;
      match = /\b(test|it|describe)\s*\(\s*(['"])((?:\\.|(?!\2).)*)\2/.exec(raw);
      const title = safeTitle(match?.[3] ?? '');
      if (title) found.push({ framework: match[1], name: title, line });
    } else if (language === 'python') {
      match = /^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/.exec(code);
      if (match) found.push({ framework: 'python-test', name: match[1], line });
    } else if (language === 'go') {
      match = /^func\s+(Test[A-Za-z0-9_]+)\s*\(/.exec(code);
      if (match) found.push({ framework: 'go-test', name: match[1], line });
    } else if (language === 'java' || language === 'kotlin') {
      if (!/^@(Test|ParameterizedTest|RepeatedTest)\b/.test(code)) continue;
      for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
        const candidate = lines[next].code.trim();
        match = /(?:fun\s+|[\w$<>,.?\[\]]+\s+)([A-Za-z_$][\w$]*)\s*\(/.exec(candidate);
        if (match) { found.push({ framework: 'junit', name: match[1], line: lines[next].line }); break; }
      }
    } else if (language === 'csharp') {
      if (!/^\[(?:Fact|Theory|Test|TestCase)\b/.test(code)) continue;
      for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
        match = /(?:public|internal|private|protected)?\s*(?:async\s+)?[\w<>,?\[\]]+\s+([A-Za-z_]\w*)\s*\(/.exec(lines[next].code.trim());
        if (match) { found.push({ framework: 'dotnet-test', name: match[1], line: lines[next].line }); break; }
      }
    } else if (language === 'rust') {
      if (!/^#\s*\[\s*test\s*\]/.test(code)) continue;
      const candidate = lines[index + 1];
      match = candidate && /^(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/.exec(candidate.code.trim());
      if (match) found.push({ framework: 'rust-test', name: match[1], line: candidate.line });
    } else if (language === 'ruby') {
      if (!/^(?:it|describe|context)\b/.test(code)) continue;
      match = /^\s*(it|describe|context)\s*(?:\(\s*)?(['"])((?:\\.|(?!\2).)*)\2/.exec(raw);
      const title = safeTitle(match?.[3] ?? '');
      if (title) found.push({ framework: `ruby-${match[1]}`, name: title, line });
    } else if (language === 'php') {
      match = /\bfunction\s+(test[A-Za-z0-9_]+)\s*\(/i.exec(code);
      if (match) found.push({ framework: 'phpunit', name: match[1], line });
    }
  }
  return found.filter((item, index, values) => values.findIndex((candidate) => (
    candidate.framework === item.framework && candidate.name === item.name && candidate.line === item.line
  )) === index);
}

const CLAUSE_TAG = /^(?:\s*)(?:(?:\/\/|#|\/\*+|\*)\s*)(?:[-*]\s*)?@(?:ac|clause)\s*:\s*((?:[A-Za-z][A-Za-z0-9-]*:)?(?:AC|REQ|CON|NFR)-[A-Za-z0-9-]+)\b/i;

/** Explicit clause annotations in source comments; control-flow is never guessed to be a clause. */
export function scanClauseBindings(source) {
  return String(source).split(/\r?\n/).flatMap((line, index) => {
    const match = CLAUSE_TAG.exec(line);
    if (!match) return [];
    return [{ clause: match[1].toUpperCase(), line: index + 1 }];
  });
}
