/**
 * Contract readers: what an endpoint takes and returns, which repositories store which entities,
 * and which classes implement which interfaces.
 *
 * - `handlerSignature` reads an endpoint handler's declaration: the request body type, path, query
 *   and header parameters, and the response type with `ResponseEntity<T>`, `Mono<T>`, `Promise<T>`
 *   and similar wrappers removed (Spring, JAX-RS and Micronaut in Java and Kotlin, NestJS, FastAPI).
 * - `repositoryInterfaces` reads Spring Data and Micronaut Data repositories: entity, id and the
 *   finder methods they declare.
 * - `typeRelations` reads interface declarations and the classes that implement them.
 *
 * Pattern readers over masked source, like the other producers; every result keeps its line.
 */
import path from 'node:path';

import { isTestPath } from '../code-intelligence/generated/code-explainer-model.mjs';
import { maskedLines } from './producers.mjs';

const WRAPPERS = /^(?:ResponseEntity|Mono|Flux|Optional|CompletableFuture|CompletionStage|HttpResponse|Response|Promise|Observable|Single|Maybe|Uni|Multi|Callable|DeferredResult|Future|List|Set|Collection|Iterable|Page|Slice)<(.+)>$/u;
const REPOSITORY_BASES = /\b(JpaRepository|CrudRepository|PagingAndSortingRepository|ListCrudRepository|ListPagingAndSortingRepository|MongoRepository|ReactiveCrudRepository|ReactiveMongoRepository|CoroutineCrudRepository|R2dbcRepository|ElasticsearchRepository|PageableRepository)\s*<\s*([\w.]+)\s*,\s*([\w.]+)\s*>/u;

/** `ResponseEntity<List<Order>>` is a list of Order; `Mono<Void>` and `void` return nothing. */
export function unwrapType(type) {
  let value = String(type ?? '').replace(/\s+/gu, '').replace(/^(?:public|static|final|suspend)/u, '');
  let many = /\[\]$/u.test(value);
  for (let depth = 0; depth < 4; depth += 1) {
    const wrapped = WRAPPERS.exec(value);
    if (!wrapped) break;
    // A collection at any level makes the result a list: ResponseEntity<List<Order>> is a list of Order.
    if (/^(?:List|Set|Collection|Iterable|Flux|Page|Slice|Multi|Observable)</u.test(value)) many = true;
    value = wrapped[1];
  }
  if (/\[\]$/u.test(value)) many = true;
  value = value.replace(/\[\]$/u, '');
  if (!value || /^(?:void|Void|Unit|None|undefined|\?)$/u.test(value)) return null;
  return many ? `list of ${value}` : value;
}

/** Split `a, b<c, d>, e` at depth zero. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0; let current = '';
  for (const character of text) {
    if ('(<[{'.includes(character)) depth += 1;
    if (')>]}'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += character;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function annotationName(text, names) {
  for (const name of names) {
    const match = new RegExp(`@${name}\\b(?:\\s*\\(\\s*(?:(?:value|name)\\s*=\\s*)?["']?([\\w.-]*)["']?[^)]*\\))?`, 'u').exec(text);
    if (match) return { name, argument: match[1] || null };
  }
  return null;
}

/** One parameter: where it comes from (body, path, query, header), its name and type. */
function readParameter(raw, language) {
  const text = raw.trim();
  if (!text) return null;
  if (language === 'python') {
    const match = /^([a-zA-Z_]\w*)\s*:\s*([^=]+?)(?:\s*=\s*(.+))?$/u.exec(text);
    if (!match || ['self', 'request', 'response', 'db', 'session'].includes(match[1])) return null;
    const source = /\b(?:Query)\s*\(/u.test(match[3] ?? '') ? 'query' : /\bHeader\s*\(/u.test(match[3] ?? '') ? 'header'
      : /\bPath\s*\(/u.test(match[3] ?? '') ? 'path' : /\bDepends\s*\(/u.test(match[3] ?? '') ? null : 'auto';
    return source ? { in: source, name: match[1], type: match[2].trim() } : null;
  }
  const body = annotationName(text, ['RequestBody', 'Body', 'Valid']);
  const pathParam = annotationName(text, ['PathVariable', 'PathParam', 'Param']);
  const query = annotationName(text, ['RequestParam', 'QueryParam', 'QueryValue', 'Query']);
  const header = annotationName(text, ['RequestHeader', 'HeaderParam', 'Header', 'Headers']);
  const bare = text.replace(/@[\w.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?/gu, '').replace(/\bfinal\s+/u, '').trim();
  const kotlinOrTs = /^([a-zA-Z_]\w*)\??\s*:\s*(.+)$/u.exec(bare);
  const java = /^([\w.<>,?[\]\s]+?)\s+([a-zA-Z_]\w*)$/u.exec(bare);
  const name = kotlinOrTs ? kotlinOrTs[1] : java?.[2];
  const type = (kotlinOrTs ? kotlinOrTs[2] : java?.[1])?.trim();
  if (!name || !type) return null;
  if (body && body.name !== 'Valid') return { in: 'body', name, type };
  if (pathParam) return { in: 'path', name: pathParam.argument || name, type };
  if (query) return { in: 'query', name: query.argument || name, type };
  if (header) return { in: 'header', name: header.argument || name, type };
  if (/@RequestBody\b|@Body\b/u.test(text)) return { in: 'body', name, type };
  return null;
}

/**
 * The declaration of method `name` at or after `line` (1-based): its parameters and return type.
 * Returns null when the declaration cannot be read.
 */
export function handlerSignature(file, name, line = 1) {
  if (!name) return null;
  const masked = maskedLines(file);
  const language = path.posix.extname(file.path) === '.py' ? 'python' : file.language;
  const start = Math.max(0, line - 1);
  const at = masked.slice(start, start + 40).findIndex((code) => new RegExp(`\\b${name}\\s*\\(`, 'u').test(code));
  if (at < 0) return null;
  const first = start + at;
  let joined = '';
  let end = first;
  for (; end < Math.min(masked.length, first + 15); end += 1) {
    joined += ` ${file.lines[end]}`;
    if (/[{]|=>|:\s*$|;\s*$/u.test(masked[end]) && (joined.match(/\(/gu) ?? []).length <= (joined.match(/\)/gu) ?? []).length) break;
  }
  const open = joined.indexOf('(', joined.search(new RegExp(`\\b${name}\\s*\\(`, 'u')));
  let depth = 0; let close = -1;
  for (let index = open; index < joined.length; index += 1) {
    if (joined[index] === '(') depth += 1;
    if (joined[index] === ')') { depth -= 1; if (depth === 0) { close = index; break; } }
  }
  if (open < 0 || close < 0) return null;
  const parameters = splitTopLevel(joined.slice(open + 1, close)).map((raw) => readParameter(raw, language)).filter(Boolean);
  const before = joined.slice(0, open).replace(new RegExp(`\\b${name}\\s*$`, 'u'), '').trim();
  const after = joined.slice(close + 1);
  let response = null;
  if (language === 'python') {
    response = /->\s*([^:]+):/u.exec(after)?.[1]?.trim() ?? null;
    const decorator = file.lines.slice(Math.max(0, first - 3), first).join(' ');
    response = /response_model\s*=\s*([\w.[\]]+)/u.exec(decorator)?.[1] ?? response;
  } else if (/^\s*:\s*/u.test(after)) {
    response = /^\s*:\s*([^{=]+?)\s*(?:\{|=|$)/u.exec(after)?.[1] ?? null;
  } else {
    response = /([\w.<>,?[\]\s]+?)\s*$/u.exec(before.replace(/@[\w.]+(?:\s*\((?:[^()]|\([^()]*\))*\))?/gu, '').replace(/\b(?:public|private|protected|static|final|async|synchronized|override|suspend|fun|def)\b/gu, '').trim())?.[1]?.trim() ?? null;
  }
  const body = parameters.find((entry) => entry.in === 'body')
    ?? (language === 'python' ? parameters.find((entry) => entry.in === 'auto' && /^[A-Z]/u.test(entry.type)) : null);
  return {
    request: body ? { type: unwrapType(body.type), name: body.name } : null,
    response: unwrapType(response),
    params: parameters.filter((entry) => entry !== body && entry.in !== 'body').map((entry) => ({ in: entry.in === 'auto' ? 'query' : entry.in, name: entry.name, type: entry.type }))
  };
}

/** Spring Data / Micronaut Data repositories in one file, with their entity, id and finders. */
export function repositoryInterfaces(file) {
  if (isTestPath(file.path)) return [];
  const masked = maskedLines(file);
  const out = [];
  masked.forEach((code, index) => {
    const declared = /\binterface\s+([A-Z]\w*)\b([^{]*)/u.exec(code);
    if (!declared) return;
    const base = REPOSITORY_BASES.exec(`${declared[2]} ${masked[index + 1] ?? ''}`);
    if (!base) return;
    const methods = [];
    let depth = 0;
    for (let line = index; line < Math.min(masked.length, index + 200); line += 1) {
      for (const character of masked[line]) { if (character === '{') depth += 1; if (character === '}') depth -= 1; }
      const method = /\b((?:find|exists|count|delete|get|read|query|search|stream|remove)\w*)\s*\(/u.exec(masked[line]);
      if (line > index && method) methods.push(method[1]);
      if (line > index && depth <= 0 && masked[line].includes('}')) break;
    }
    out.push({ name: declared[1], base: base[1], entity: base[2].split('.').pop(), id: base[3].split('.').pop(), methods: [...new Set(methods)], line: index + 1 });
  });
  return out;
}

/** Interfaces declared in one file, and the classes there that implement or extend them. */
export function typeRelations(file) {
  if (isTestPath(file.path)) return { interfaces: [], classes: [] };
  const masked = maskedLines(file);
  const interfaces = [];
  const classes = [];
  masked.forEach((code, index) => {
    const iface = /\b(?:interface|protocol|trait)\s+([A-Z]\w*)/u.exec(code);
    if (iface && !REPOSITORY_BASES.test(code)) interfaces.push({ name: iface[1], line: index + 1 });
    const abstract = /\babstract\s+class\s+([A-Z]\w*)/u.exec(code);
    if (abstract) interfaces.push({ name: abstract[1], line: index + 1, abstract: true });
    const javaClass = /\bclass\s+([A-Z]\w*)(?:<[^>]*>)?(?:\s+extends\s+([\w.]+)(?:<[^>]*>)?)?(?:\s+implements\s+([^{]+))?/u.exec(code);
    const kotlinClass = /\bclass\s+([A-Z]\w*)(?:<[^>]*>)?\s*(?:\([^)]*\))?\s*:\s*([^{]+)/u.exec(code);
    const pythonClass = /^\s*class\s+([A-Z]\w*)\s*\(([^)]+)\)\s*:/u.exec(code);
    let parents = [];
    let name = null;
    if (pythonClass && path.posix.extname(file.path) === '.py') { name = pythonClass[1]; parents = pythonClass[2].split(','); }
    else if (kotlinClass && /\.kt$/u.test(file.path)) { name = kotlinClass[1]; parents = splitTopLevel(kotlinClass[2]); }
    else if (javaClass && (javaClass[2] || javaClass[3])) { name = javaClass[1]; parents = [javaClass[2], ...splitTopLevel(javaClass[3] ?? '')].filter(Boolean); }
    if (name) {
      const supertypes = parents.map((parent) => parent.replace(/\(.*$/u, '').replace(/<.*$/u, '').trim().split('.').pop()).filter((parent) => /^[A-Z]\w*$/u.test(parent) && parent !== 'ABC' && parent !== 'Object');
      if (supertypes.length) classes.push({ name, supertypes, line: index + 1 });
    }
  });
  return { interfaces, classes };
}
