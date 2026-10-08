/**
 * Source readers the shared analysis engine does not cover: named limits, configuration keys,
 * build and test commands, test cases, client routes, outbound HTTP calls, imports, exception to
 * status mappings, and TypeScript type shapes.
 *
 * Each reader works on text with comments and strings blanked (`maskSource`), so a commented-out
 * line or a word inside a string never counts as code; values are then read back from the
 * original line. They are pattern readers, not parsers, and every result keeps the line it came
 * from so a reader can check it.
 */
import path from 'node:path';

import { isTestPath, maskSource } from '../code-intelligence/generated/code-explainer-model.mjs';

const SECRET_KEY = /(?:pass(?:word)?|secret|token|api[-_.]?key|credential|private[-_.]?key)/iu;
const SCRIPT_LANGUAGES = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);

export function maskedLines(file) {
  file.masked ??= maskSource(file.lines.join('\n'), file.language).split('\n');
  return file.masked;
}

/** A literal value as written: a number, a quoted string, a boolean, or a BigDecimal-style wrapper. */
function literalValue(raw) {
  const text = raw.trim().replace(/[;,]\s*$/u, '').trim();
  const wrapped = text.match(/^new\s+\w+\(\s*(["'])(.*?)\1\s*\)$/u) ?? text.match(/^\w+\.valueOf\(\s*([0-9._]+)\s*\)$/u);
  if (wrapped) return wrapped[2] ?? wrapped[1];
  if (/^-?[0-9][0-9_]*(?:\.[0-9]+)?[lLfFdD]?$/u.test(text)) return text.replace(/_/gu, '').replace(/[lLfFdD]$/u, '');
  const quoted = text.match(/^(["'`])(.*)\1$/u);
  if (quoted && !quoted[2].includes('${')) return quoted[2];
  if (/^(?:true|false)$/u.test(text)) return text;
  return null;
}

/** Upper-case constants with literal values: `export const MAX = 10`, `static final int MAX = 10;`, `MAX = 10`. */
export function namedLimits(file) {
  const masked = maskedLines(file);
  const found = [];
  const patterns = file.language === 'python'
    ? [/^([A-Z][A-Z0-9_]{2,})\s*(?::\s*[\w[\], ]+)?=\s*(.+)$/u]
    : SCRIPT_LANGUAGES.has(file.language)
      ? [/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*(.+)$/u]
      : [/\b(?:static\s+final|final\s+static|const|val)\s+(?:[\w<>,.?[\] ]+\s+)?([A-Z][A-Z0-9_]{2,})\s*(?::\s*[\w<>?]+)?\s*=\s*(.+)$/u];
  masked.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      // The masked line has strings blanked; read the value from the original line.
      const original = file.lines[index].slice(file.lines[index].indexOf(match[1]) + match[1].length);
      const value = literalValue(original.replace(/^\s*(?::[^=]+)?=\s*/u, ''));
      if (value != null) found.push({ name: match[1], value, line: index + 1 });
    }
  });
  return found;
}

/** `key=value` and simple `key: value` configuration, with secret-looking values withheld. */
export function configurationKeys(manifest) {
  if (!/\.(?:properties|ya?ml)$|\.env\.example$/u.test(manifest.path)) return [];
  const keys = [];
  const yaml = /\.ya?ml$/u.test(manifest.path);
  const stack = [];
  manifest.lines.forEach((line, index) => {
    if (!line.trim() || /^\s*[#!]/u.test(line)) return;
    if (!yaml) {
      const match = line.match(/^\s*([\w.-]+)\s*[=:]\s*(.*)$/u);
      if (match) keys.push({ key: match[1], value: SECRET_KEY.test(match[1]) ? '(withheld)' : match[2].trim(), line: index + 1 });
      return;
    }
    const match = line.match(/^(\s*)([\w.-]+):\s*(.*)$/u);
    if (!match) return;
    const depth = match[1].length;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    stack.push({ depth, key: match[2] });
    if (match[3].trim() && !match[3].trim().startsWith('#')) {
      const key = stack.map((entry) => entry.key).join('.');
      keys.push({ key, value: SECRET_KEY.test(key) ? '(withheld)' : match[3].trim().replace(/^["']|["']$/gu, ''), line: index + 1 });
    }
  });
  return keys;
}

/** How a repository is built and tested, from its manifests. */
export function manifestCommands(manifests, codeFiles) {
  const commands = [];
  const frameworks = new Set();
  const byName = new Map(manifests.map((file) => [file.path, file]));
  for (const file of manifests) {
    const base = path.posix.basename(file.path);
    const dir = path.posix.dirname(file.path);
    const prefix = dir === '.' ? '' : `cd ${dir} && `;
    if (base === 'package.json') {
      let parsed = null;
      try { parsed = JSON.parse(file.lines.join('\n')); } catch { parsed = null; }
      if (!parsed) continue;
      for (const script of ['test', 'build', 'start', 'dev', 'lint']) {
        const value = parsed.scripts?.[script];
        if (typeof value !== 'string') continue;
        const line = file.lines.findIndex((text) => text.includes(`"${script}"`)) + 1;
        commands.push({ purpose: script, command: `${prefix}npm ${script === 'test' || script === 'start' ? script : `run ${script}`}`, runs: value, path: file.path, line: line || 1 });
      }
      const deps = { ...parsed.dependencies, ...parsed.devDependencies };
      for (const [name, label] of [['react', 'React'], ['next', 'Next.js'], ['vue', 'Vue'], ['@angular/core', 'Angular'], ['express', 'Express'],
        ['@nestjs/core', 'NestJS'], ['react-router-dom', 'React Router'], ['redux', 'Redux'], ['@reduxjs/toolkit', 'Redux Toolkit'],
        ['vitest', 'Vitest'], ['jest', 'Jest'], ['axios', 'axios'], ['prisma', 'Prisma']]) {
        if (deps[name]) frameworks.add(label);
      }
    } else if (base === 'pom.xml') {
      const text = file.lines.join('\n');
      const wrapper = byName.has(dir === '.' ? 'mvnw' : `${dir}/mvnw`);
      commands.push({ purpose: 'test', command: `${prefix}${wrapper ? './mvnw' : 'mvn'} test`, runs: 'Maven Surefire', path: file.path, line: 1 });
      if (/spring-boot/u.test(text)) frameworks.add('Spring Boot');
      if (/spring-boot-starter-data-jpa|hibernate/u.test(text)) frameworks.add('JPA');
    } else if (/^build\.gradle(?:\.kts)?$/u.test(base)) {
      const text = file.lines.join('\n');
      if (!commands.some((entry) => entry.command.endsWith('gradlew test'))) {
        commands.push({ purpose: 'test', command: `${prefix}./gradlew test`, runs: 'Gradle', path: file.path, line: 1 });
      }
      if (/com\.android\.(?:application|library)/u.test(text)) frameworks.add('Android');
      if (/org\.springframework\.boot/u.test(text)) frameworks.add('Spring Boot');
      if (/kotlin/u.test(text)) frameworks.add('Kotlin');
    } else if (base === 'pyproject.toml' || /^requirements/u.test(base)) {
      const text = file.lines.join('\n').toLowerCase();
      if (/pytest/u.test(text) && !commands.some((entry) => entry.command.endsWith('pytest'))) {
        commands.push({ purpose: 'test', command: `${prefix}pytest`, runs: 'pytest', path: file.path, line: 1 });
      }
      for (const [name, label] of [['fastapi', 'FastAPI'], ['flask', 'Flask'], ['django', 'Django']]) if (text.includes(name)) frameworks.add(label);
    } else if (base === 'go.mod') {
      commands.push({ purpose: 'test', command: `${prefix}go test ./...`, runs: 'go test', path: file.path, line: 1 });
    } else if (base.endsWith('.csproj')) {
      commands.push({ purpose: 'test', command: `${prefix}dotnet test`, runs: 'dotnet test', path: file.path, line: 1 });
    }
  }
  if (codeFiles.some((file) => file.language === 'typescriptreact' || file.language === 'javascriptreact')) frameworks.add('JSX');
  return { commands, frameworks: [...frameworks].sort() };
}

/** Test cases with their titles and the lines of their bodies. */
export function testCases(file) {
  if (!isTestPath(file.path)) return [];
  const masked = maskedLines(file);
  const starts = [];
  if (SCRIPT_LANGUAGES.has(file.language)) {
    file.lines.forEach((line, index) => {
      const match = masked[index].match(/\b(it|test)(?:\.only|\.skip|\.each\([^)]*\))?\s*\(\s*(["'`])/u);
      if (!match) return;
      const quote = match[2];
      const from = line.indexOf(quote, line.indexOf(match[1]));
      const to = line.indexOf(quote, from + 1);
      if (from >= 0 && to > from) starts.push({ title: line.slice(from + 1, to), line: index + 1 });
    });
  } else if (file.language === 'python') {
    masked.forEach((line, index) => {
      const match = line.match(/^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/u);
      if (match) starts.push({ title: match[1].replace(/^test_/u, '').replace(/_/gu, ' '), name: match[1], line: index + 1 });
    });
  } else {
    masked.forEach((line, index) => {
      if (!/@(?:Test|ParameterizedTest|RepeatedTest)\b/u.test(line)) return;
      for (let next = index; next < Math.min(masked.length, index + 5); next += 1) {
        const original = file.lines[next];
        const kotlin = original.match(/\bfun\s+`([^`]+)`\s*\(/u) ?? original.match(/\bfun\s+(\w+)\s*\(/u);
        const java = masked[next].match(/\b(?:void|Unit)\s+(\w+)\s*\(/u);
        const match = kotlin ?? java;
        if (match) { starts.push({ title: match[1], name: match[1], line: next + 1 }); break; }
      }
    });
  }
  return starts.map((start, index) => {
    const end = (starts[index + 1]?.line ?? file.lines.length + 1) - 1;
    const body = masked.slice(start.line - 1, end).join('\n');
    return { ...start, end, identifiers: [...new Set(body.match(/[A-Za-z_$][\w$]*/gu) ?? [])] };
  });
}

/** React Router `<Route path="…" element={<Page />}>` and `{ path: '…', element: <Page /> }` routes. */
export function clientRoutes(file) {
  if (!SCRIPT_LANGUAGES.has(file.language)) return [];
  const routes = [];
  file.lines.forEach((line, index) => {
    const jsx = line.match(/<Route\b[^>]*\bpath=["']([^"']+)["'][^>]*?(?:element=\{\s*<\s*(\w+)|component=\{\s*(\w+))/u);
    const object = line.match(/\bpath:\s*["']([^"']+)["'][^}]*?(?:element:\s*<\s*(\w+)|component:\s*(\w+))/u);
    const match = jsx ?? object;
    if (match) routes.push({ path: match[1], component: match[2] ?? match[3], line: index + 1 });
  });
  return routes;
}

/** Outbound HTTP: `fetch('/x')`, `axios.post('/x')`, `request('/x', { method: 'POST' })`, `restTemplate.getForObject("…")`. */
export function outboundHttp(file) {
  const calls = [];
  file.lines.forEach((line, index) => {
    const verb = line.match(/\b(?:axios|http|client|api)\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*(["'`])([^"'`]+)\2/u);
    const fetchLike = line.match(/\b(fetch|request|apiFetch|httpRequest)\s*(?:<[^>]*>)?\s*\(\s*(["'`])([^"'`$]+)\2/u);
    const spring = line.match(/\b\w+\.(getForObject|getForEntity|postForObject|postForEntity|put|delete|exchange)\s*\(\s*"([^"]+)"/u);
    if (verb) calls.push({ method: verb[1].toUpperCase(), target: verb[3], line: index + 1 });
    else if (fetchLike) {
      const window = file.lines.slice(index, index + 4).join(' ');
      const method = window.match(/method:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/iu)?.[1]?.toUpperCase() ?? 'GET';
      calls.push({ method, target: fetchLike[3], line: index + 1, via: fetchLike[1] });
    } else if (spring) {
      calls.push({ method: /^get/iu.test(spring[1]) ? 'GET' : /^post/iu.test(spring[1]) ? 'POST' : spring[1].toUpperCase(), target: spring[2], line: index + 1 });
    }
  });
  return calls;
}

/** Spring `@ExceptionHandler(X.class)` + `@ResponseStatus(HttpStatus.Y)` pairs. */
export function exceptionStatuses(file) {
  if (!['java', 'kotlin'].includes(file.language)) return [];
  const mappings = [];
  file.lines.forEach((line, index) => {
    const handler = line.match(/@ExceptionHandler\(\s*\{?\s*([\w.]+?)(?:::class|\.class)/u);
    if (!handler) return;
    // The status is an annotation just above or below, or set in the handler body (`ResponseEntity.status(HttpStatus.X)`).
    let stop = index + 1;
    while (stop < Math.min(file.lines.length, index + 16) && !/@ExceptionHandler\b/u.test(file.lines[stop])) stop += 1;
    const window = file.lines.slice(Math.max(0, index - 2), stop).join(' ');
    const status = window.match(/HttpStatus\.([A-Z_]+)/u)?.[1] ?? null;
    mappings.push({ exception: handler[1].split('.').pop(), status, line: index + 1 });
  });
  return mappings;
}

/** TypeScript `interface X { a: T }` and `type X = { a: T }` shapes with their fields. */
export function typeShapes(file) {
  if (!['typescript', 'typescriptreact'].includes(file.language)) return [];
  const masked = maskedLines(file);
  const shapes = [];
  masked.forEach((line, index) => {
    const head = line.match(/^\s*(?:export\s+)?(?:interface\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+[^{]+)?\s*\{|type\s+(\w+)(?:<[^>]*>)?\s*=\s*\{)/u);
    if (!head) return;
    const name = head[1] ?? head[2];
    let depth = 0;
    const body = [];
    for (let at = index; at < Math.min(masked.length, index + 200); at += 1) {
      const text = masked[at];
      const opening = at === index ? text.indexOf('{') : -1;
      for (let column = Math.max(0, opening); column < text.length; column += 1) {
        if (text[column] === '{') depth += 1;
        else if (text[column] === '}') depth -= 1;
      }
      body.push({ text: at === index ? file.lines[at].slice(file.lines[at].indexOf('{') + 1) : file.lines[at], line: at + 1, masked: at === index ? text.slice(text.indexOf('{') + 1) : text });
      if (depth <= 0) break;
    }
    // Split the body at its own top-level separators only, so a nested object type stays one field.
    const fields = [];
    let nesting = 0;
    let current = { text: '', line: body[0]?.line ?? index + 1 };
    const flush = () => {
      const field = current.text.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+?)\s*$/u);
      if (field) fields.push({ name: field[1], type: field[3].replace(/\s+/gu, ' ').trim(), optional: Boolean(field[2]), line: current.line });
    };
    for (const row of body) {
      for (const character of row.text) {
        if ('{([<'.includes(character)) nesting += 1;
        if ('})]>'.includes(character) && nesting > 0) nesting -= 1;
        else if ('})]'.includes(character) && nesting === 0) { flush(); current = { text: '', line: row.line }; break; }
        if (nesting === 0 && (character === ';' || character === ',')) { flush(); current = { text: '', line: row.line }; continue; }
        if (!current.text.trim()) current.line = row.line;
        current.text += character;
      }
      current.text += ' ';
    }
    flush();
    if (fields.length) shapes.push({ name, kind: head[1] ? 'interface' : 'type', fields, line: index + 1 });
  });
  return shapes;
}

/** Import targets resolved to repository files where the target is local. */
export function resolvedImports(file, knownPaths, aliases = []) {
  const masked = maskedLines(file);
  const targets = [];
  if (SCRIPT_LANGUAGES.has(file.language) || ['vue', 'svelte'].includes(file.language)) {
    file.lines.forEach((line, index) => {
      if (/^\s*$/u.test(masked[index])) return;
      const match = line.match(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*["']([^"']+)["']/u)
        ?? line.match(/^\s*import\s*["']([^"']+)["']/u)
        ?? line.match(/\brequire\(\s*["']([^"']+)["']\s*\)/u);
      if (match) targets.push({ spec: match[1], line: index + 1 });
    });
    return targets.flatMap(({ spec, line }) => {
      let base = null;
      if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), spec));
      else {
        const alias = aliases.find((entry) => spec === entry.prefix || spec.startsWith(`${entry.prefix}/`));
        if (alias) base = path.posix.normalize(path.posix.join(alias.target, spec.slice(alias.prefix.length)));
      }
      if (!base) return [];
      const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'].flatMap((extension) => [`${base}${extension}`, `${base}/index${extension}`])];
      const hit = candidates.find((candidate) => knownPaths.has(candidate));
      return hit && hit !== file.path ? [{ to: hit, line }] : [];
    });
  }
  if (['java', 'kotlin', 'scala', 'groovy'].includes(file.language)) {
    const results = [];
    masked.forEach((line, index) => {
      const match = line.match(/^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;?\s*$/u);
      if (!match) return;
      const suffix = `/${match[1].replaceAll('.', '/')}`;
      for (const candidate of knownPaths) {
        if (/\.(?:java|kt|scala|groovy)$/u.test(candidate) && candidate.replace(/\.(?:java|kt|scala|groovy)$/u, '').endsWith(suffix)) {
          results.push({ to: candidate, line: index + 1 });
          break;
        }
      }
    });
    return results;
  }
  if (file.language === 'python') {
    const results = [];
    masked.forEach((line, index) => {
      const match = line.match(/^\s*from\s+([\w.]+)\s+import\b/u) ?? line.match(/^\s*import\s+([\w.]+)/u);
      if (!match) return;
      const parts = match[1].replace(/^\.+/u, '').replaceAll('.', '/');
      const hit = [...knownPaths].find((candidate) => candidate.endsWith(`${parts}.py`) || candidate.endsWith(`${parts}/__init__.py`));
      if (hit && hit !== file.path) results.push({ to: hit, line: index + 1 });
    });
    return results;
  }
  return [];
}

/** `compilerOptions.paths` aliases from a tsconfig/jsconfig, e.g. `@/*` → `src/*`. */
export function pathAliases(manifests, allPaths = []) {
  const aliases = [];
  for (const file of manifests) {
    if (!/(?:^|\/)(?:tsconfig|jsconfig)(?:\.[\w-]+)?\.json$/u.test(file.path)) continue;
    let parsed = null;
    try { parsed = JSON.parse(file.lines.join('\n').replace(/^\s*\/\/.*$/gmu, '').replace(/,(\s*[}\]])/gu, '$1')); } catch { parsed = null; }
    const options = parsed?.compilerOptions ?? {};
    const baseUrl = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), options.baseUrl ?? '.'));
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      const target = Array.isArray(targets) ? targets[0] : null;
      if (typeof target !== 'string') continue;
      aliases.push({ prefix: pattern.replace(/\/\*$/u, ''), target: path.posix.normalize(path.posix.join(baseUrl, target.replace(/\/\*$/u, ''))) });
    }
  }
  if (!aliases.some((entry) => entry.prefix === '@') && allPaths.some((relative) => relative.startsWith('src/'))) {
    aliases.push({ prefix: '@', target: 'src' });
  }
  return aliases;
}

/** Enum constants (`enum Status { PLACED, PAID }`) and Java records (`record Line(String sku, int qty)`). */
export function enumsAndRecords(file) {
  if (!['java', 'kotlin', 'typescript', 'typescriptreact', 'csharp'].includes(file.language)) return [];
  const masked = maskedLines(file);
  const found = [];
  masked.forEach((line, index) => {
    const enumHead = line.match(/\benum\s+(?:class\s+)?(\w+)[^{]*\{/u);
    if (enumHead) {
      const text = masked.slice(index, index + 80).join('\n');
      const body = text.slice(text.indexOf('{') + 1);
      const end = body.search(/[;}]/u);
      const values = (end >= 0 ? body.slice(0, end) : body).split(',')
        .map((part) => part.trim().match(/^([A-Za-z_]\w*)/u)?.[1]).filter(Boolean);
      if (values.length) found.push({ name: enumHead[1], kind: 'enum', values, fields: [], line: index + 1 });
    }
    const record = file.language === 'java' ? line.match(/\brecord\s+(\w+)\s*\(([^)]*)\)/u) : null;
    if (record) {
      const fields = record[2].split(',').map((part) => part.trim().match(/^(?:@\w+\s+)*([\w<>,.?[\] ]+?)\s+(\w+)$/u))
        .filter(Boolean).map((match) => ({ name: match[2], type: match[1].trim() }));
      found.push({ name: record[1], kind: 'record', values: [], fields, line: index + 1 });
    }
  });
  return found;
}
