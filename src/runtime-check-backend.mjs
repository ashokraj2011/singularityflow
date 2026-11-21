/**
 * The runtime check of a backend (API or service), step intents spec §12.3. With the service running on a loopback
 * address, SFlow calls each changed endpoint three ways: with valid input, with invalid input and with no credentials.
 * Endpoints come from the OpenAPI file and from the route declarations in the changed files (Express-style routers,
 * Spring and JAX-RS annotations, FastAPI and Flask decorators, Go routers). What becomes a finding:
 *   - a 5xx on bad input, or on the valid call (breaks use);
 *   - an exception or stack trace in the service's log while it was called, or a secret in it (breaks use);
 *   - an endpoint the OpenAPI file says needs credentials that answered without any (breaks use);
 *   - an operation removed from the OpenAPI file, or a request field newly required, against the base (breaks use:
 *     an undeclared contract change, unless the plan declares it);
 *   - a status the OpenAPI file does not declare for that call (advice).
 * The contract comparison needs no running service, so it runs when the service cannot start. SFlow's own work, no
 * model: nothing is sent anywhere but the service's own loopback address.
 */
import YAML from 'yaml';

const METHODS = Object.freeze(['get', 'post', 'put', 'patch', 'delete']);
const BODY_METHODS = new Set(['post', 'put', 'patch']);
const MAXIMUM_ENDPOINTS = 20;
const OPENAPI_FILE = /(?:^|\/)(?:openapi|swagger)(?:[.-][\w-]+)?\.(?:ya?ml|json)$/iu;

export const isOpenApiFile = (file) => OPENAPI_FILE.test(String(file ?? ''));

/** An OpenAPI (or Swagger 2) document from its text, or null. */
export function parseOpenApi(text) {
  try {
    const value = YAML.parse(String(text ?? ''));
    return value && typeof value === 'object' && value.paths && typeof value.paths === 'object' ? value : null;
  } catch { return null; }
}

/** Each operation of a document: `{ method, path, operation, secured }`. */
export function openApiOperations(document) {
  const operations = [];
  for (const [route, item] of Object.entries(document?.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item?.[method];
      if (!operation || typeof operation !== 'object') continue;
      const security = operation.security ?? document.security ?? null;
      operations.push({ method, path: route, operation, secured: Array.isArray(security) && security.some((entry) => entry && Object.keys(entry).length) });
    }
  }
  return operations;
}

const resolve = (document, schema, depth = 0) => {
  if (!schema || typeof schema !== 'object' || depth > 8) return schema ?? null;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const target = schema.$ref.slice(2).split('/').reduce((node, part) => node?.[part.replace(/~1/gu, '/').replace(/~0/gu, '~')], document);
    return resolve(document, target, depth + 1);
  }
  return schema;
};

const requestSchema = (document, operation) => resolve(document, operation?.requestBody?.content?.['application/json']?.schema
  ?? (operation?.parameters ?? []).find((parameter) => parameter?.in === 'body')?.schema ?? null);

/** A value that satisfies `schema` as far as SFlow can tell: its example, else one of its type. */
export function sampleValue(document, schema, depth = 0) {
  const node = resolve(document, schema);
  if (!node || depth > 6) return null;
  if (node.example !== undefined) return node.example;
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];
  const type = Array.isArray(node.type) ? node.type[0] : node.type ?? (node.properties ? 'object' : null);
  if (type === 'object') {
    const value = {};
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      if ((node.required ?? []).includes(name) || depth === 0) value[name] = sampleValue(document, property, depth + 1);
    }
    return value;
  }
  if (type === 'array') return [sampleValue(document, node.items, depth + 1)].filter((entry) => entry !== null);
  if (type === 'integer' || type === 'number') return node.minimum ?? 1;
  if (type === 'boolean') return true;
  if (type === 'string') return node.format === 'email' ? 'ana@example.test' : node.format === 'date' ? '2026-01-31' : node.format === 'uuid' ? '00000000-0000-4000-8000-000000000001' : 'sample';
  return null;
}

/** A value of the wrong type for every field `schema` requires: what a careless caller sends. */
function wrongValue(document, schema) {
  const node = resolve(document, schema);
  if (!node || (node.type ?? (node.properties ? 'object' : null)) !== 'object') return { unexpected: [] };
  const value = {};
  for (const name of node.required?.length ? node.required : Object.keys(node.properties ?? {}).slice(0, 3)) {
    const type = resolve(document, node.properties?.[name])?.type;
    value[name] = type === 'string' ? 12345 : type === 'object' || type === 'array' ? 'not-an-object' : 'not-a-number';
  }
  return value;
}

/** Route declarations in one source file's text: `[{ method, path, line }]`. */
export function routesInSource(file, text) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const found = [];
  const add = (method, route, index) => { if (route != null) found.push({ method: method.toLowerCase(), path: route || '/', line: index + 1, file }); };
  // A class-level prefix (Spring @RequestMapping, JAX-RS @Path) before the class line.
  const classLine = lines.findIndex((line) => /\b(?:class|interface)\s+\w+/u.test(line));
  const prefixLine = classLine < 0 ? -1 : lines.slice(0, classLine).findLastIndex((line) => /@(?:RequestMapping|Path)\s*\(/u.test(line));
  const prefix = prefixLine < 0 ? '' : (/@(?:RequestMapping|Path)\s*\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)"/u.exec(lines[prefixLine])?.[1] ?? '');
  const join = (route) => `/${[prefix, route].map((part) => String(part ?? '').replace(/^\/+|\/+$/gu, '')).filter(Boolean).join('/')}`;
  lines.forEach((line, index) => {
    let match;
    const router = /\b(?:app|router|server|api|routes|fastify|r|e|g|group|mux)\.(get|post|put|patch|delete|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*(['"`])([^'"`]*)\2/gu;
    while ((match = router.exec(line))) add(match[1], match[3], index);
    const spring = /@(Get|Post|Put|Patch|Delete)Mapping\s*(?:\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)")?/u.exec(line);
    if (spring) add(spring[1], join(spring[2] ?? ''), index);
    const mapped = /@RequestMapping\s*\(([^)]*)\)/u.exec(line);
    if (mapped && index !== prefixLine) {
      const route = /"([^"]*)"/u.exec(mapped[1])?.[1] ?? '';
      const method = /RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/u.exec(mapped[1])?.[1] ?? 'GET';
      add(method, join(route), index);
    }
    const jaxrs = /^\s*@(GET|POST|PUT|PATCH|DELETE)\b/u.exec(line);
    if (jaxrs) {
      const near = lines.slice(Math.max(0, index - 3), index + 4).map((other) => /@Path\s*\(\s*"([^"]*)"/u.exec(other)?.[1]).find((value) => value != null);
      add(jaxrs[1], join(near ?? ''), index);
    }
    const decorator = /@\w+\.(get|post|put|patch|delete)\(\s*['"]([^'"]*)['"]/u.exec(line);
    if (decorator) add(decorator[1], decorator[2], index);
    const flask = /@\w+\.route\(\s*['"]([^'"]*)['"](?:[^)]*methods\s*=\s*\[([^\]]*)\])?/u.exec(line);
    if (flask) for (const method of (flask[2] ?? "'GET'").match(/[A-Za-z]+/gu) ?? ['GET']) add(method, flask[1], index);
  });
  const seen = new Set();
  return found.filter((entry) => METHODS.includes(entry.method) && !seen.has(`${entry.method} ${entry.path}`) && seen.add(`${entry.method} ${entry.path}`));
}

const template = (route) => route.replace(/\{[^}]+\}|:[A-Za-z_]\w*|<(?:\w+:)?\w+>/gu, '{}');
const fill = (route, value) => route.replace(/\{[^}]+\}|:[A-Za-z_]\w*|<(?:\w+:)?\w+>/gu, value);

/**
 * The endpoints a change touches: every operation of a changed OpenAPI file that differs from its base (or all of a
 * new one), and every route declared in a changed source file, matched to its OpenAPI operation when there is one.
 */
export function changedEndpoints({ openapi = null, openapiBase = null, openapiChanged = false, sources = [] }) {
  const operations = openapi ? openApiOperations(openapi) : [];
  const before = new Map((openapiBase ? openApiOperations(openapiBase) : []).map((entry) => [`${entry.method} ${entry.path}`, JSON.stringify(entry.operation)]));
  const endpoints = new Map();
  if (openapiChanged) {
    for (const entry of operations) {
      const id = `${entry.method} ${entry.path}`;
      if (before.get(id) !== JSON.stringify(entry.operation)) endpoints.set(`${entry.method} ${template(entry.path)}`, { ...entry, from: 'openapi' });
    }
  }
  for (const source of sources) {
    for (const route of routesInSource(source.path, source.text)) {
      const id = `${route.method} ${template(route.path)}`;
      if (endpoints.has(id)) continue;
      const declared = operations.find((entry) => `${entry.method} ${template(entry.path)}` === id);
      endpoints.set(id, { method: route.method, path: declared?.path ?? route.path, operation: declared?.operation ?? null, secured: declared?.secured ?? false,
        from: 'route', file: route.file, line: route.line });
    }
  }
  return [...endpoints.values()].slice(0, MAXIMUM_ENDPOINTS);
}

/** Operations a change removed, and request fields it newly requires: undeclared breaking changes to callers. */
export function openApiContractChanges(base, head) {
  if (!base || !head) return [];
  const now = new Map(openApiOperations(head).map((entry) => [`${entry.method} ${template(entry.path)}`, entry]));
  const findings = [];
  for (const entry of openApiOperations(base)) {
    const id = `${entry.method} ${template(entry.path)}`;
    const current = now.get(id);
    if (!current) {
      findings.push({ type: 'contract-removed', class: 'breaks-use', title: `${entry.method.toUpperCase()} ${entry.path} was removed from the API`,
        detail: 'Callers of this operation break unless the change is declared and versioned.', evidence: { method: entry.method, path: entry.path } });
      continue;
    }
    const was = requestSchema(base, entry.operation);
    const is = requestSchema(head, current.operation);
    const added = (is?.required ?? []).filter((name) => !(was?.required ?? []).includes(name));
    if (added.length) findings.push({ type: 'contract-required-field', class: 'breaks-use', title: `${entry.method.toUpperCase()} ${entry.path} now requires ${added.join(', ')}`,
      detail: 'Callers that do not send the new field are refused, unless the change is declared and versioned.', evidence: { method: entry.method, path: entry.path, required: added } });
  }
  return findings;
}

// What a stack trace or an unhandled error looks like in Java, Node, Python, Go and .NET logs.
const STACK_TRACES = Object.freeze([
  /\b[\w.$]*(?:Exception|Error)\b[^\n]*\r?\n\s+at\s+[\w.$<>]+\s?\(/u,
  /\r?\n\s+at\s+(?:async\s+)?(?:[\w.$<>[\] ]+\s\()?(?:file:\/\/|\/|[A-Za-z]:\\|node:)[^\n]*:\d+:\d+\)?/u,
  /Traceback \(most recent call last\)/u,
  /\bpanic: /u,
  /\bUnhandled(?:PromiseRejection| exception| error| rejection)/iu,
  /\bException in thread "/u
]);
const stackTraceAt = (log) => Math.min(...STACK_TRACES.map((pattern) => { const at = log.search(pattern); return at < 0 ? Infinity : at; }));

/** Findings in the service's log while SFlow called it: a stack trace, an unhandled error or a secret. */
export async function logFindings(text) {
  const findings = [];
  const log = String(text ?? '');
  const at = stackTraceAt(log);
  if (Number.isFinite(at)) {
    // From the start of the line the trace begins on.
    const start = log.lastIndexOf('\n', at) + 1;
    const excerpt = log.slice(start, start + 800).trim();
    const { redactDiagnosticText } = await import('./git-remote-diagnostics.mjs');
    findings.push({ type: 'exception-in-log', class: 'breaks-use', title: 'An exception in the service\'s log while it was called',
      detail: redactDiagnosticText(excerpt.split('\n').slice(0, 6).join('\n'), { multiline: true }), evidence: { excerpt: redactDiagnosticText(excerpt, { multiline: true }) } });
  }
  const { scanText } = await import('./secrets.mjs');
  const secrets = scanText(log, { path: 'application log' }).filter((entry) => !entry.waived && entry.severity !== 'likely');
  if (secrets.length) findings.push({ type: 'secret-in-log', class: 'breaks-use', title: 'A secret in the service\'s log',
    detail: `${secrets.length} value${secrets.length === 1 ? '' : 's'} that look like ${[...new Set(secrets.map((entry) => entry.label))].slice(0, 3).join(', ')} (log line ${secrets[0].line}).`,
    evidence: { kinds: [...new Set(secrets.map((entry) => entry.rule))], lines: secrets.slice(0, 5).map((entry) => entry.line) } });
  return findings;
}

/** One loopback call: `{ status, ms, body }` or `{ error }`. Never follows a redirect or sends credentials. */
async function call(baseUrl, method, route, { body = undefined, raw = null, timeoutMs = 8_000 } = {}) {
  const started = Date.now();
  try {
    const response = await fetch(new URL(route.replace(/^\/?/u, '/'), baseUrl), { method: method.toUpperCase(), redirect: 'manual',
      headers: { accept: 'application/json', ...(raw != null || body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(timeoutMs) });
    const text = (await response.text()).slice(0, 2_000);
    return { status: response.status, ms: Date.now() - started, body: text };
  } catch (error) { return { error: String(error?.cause?.code ?? error?.name ?? error?.message ?? error), ms: Date.now() - started }; }
}

const declaredStatus = (operation, status) => {
  const responses = Object.keys(operation?.responses ?? {});
  if (!responses.length || responses.includes('default')) return true;
  return responses.some((code) => code === String(status) || (/^\dXX$/iu.test(code) && code[0] === String(status)[0]));
};

/**
 * Call each endpoint at `baseUrl` with valid input, invalid input and no credentials; `logs()` returns the service's
 * output so far. Returns `{ calls, findings }`; `document` is the head OpenAPI document, when there is one.
 */
export async function probeEndpoints(baseUrl, endpoints, { document = null, logs = () => '', deadline = Date.now() + 60_000 } = {}) {
  const calls = [];
  const findings = [];
  const logStart = logs().length;
  for (const endpoint of endpoints) {
    if (Date.now() > deadline) break;
    const named = `${endpoint.method.toUpperCase()} ${endpoint.path}`;
    const schema = requestSchema(document, endpoint.operation);
    const valid = { path: fill(endpoint.path, '1'), body: BODY_METHODS.has(endpoint.method) ? (schema ? sampleValue(document, schema) : {}) : undefined };
    const invalid = BODY_METHODS.has(endpoint.method)
      ? [{ what: 'a malformed JSON body', path: valid.path, raw: '{"broken": ' }, ...(schema ? [{ what: 'fields of the wrong type', path: valid.path, body: wrongValue(document, schema) }] : [])]
      : /\{[^}]+\}|:[A-Za-z_]|<[^>]+>/u.test(endpoint.path) ? [{ what: 'a malformed path value', path: fill(endpoint.path, 'not-a-valid-id%27') }] : [];
    const result = await call(baseUrl, endpoint.method, valid.path, { body: valid.body });
    calls.push({ endpoint: named, input: 'valid', ...result });
    if (result.status >= 500) findings.push({ type: 'server-error', class: 'breaks-use', title: `${named} answered ${result.status} to a valid call`,
      detail: `${endpoint.method.toUpperCase()} ${valid.path}${valid.body !== undefined ? ` with ${JSON.stringify(valid.body).slice(0, 200)}` : ''} answered ${result.status}.`,
      evidence: { endpoint: named, call: 'valid', status: result.status, body: result.body?.slice(0, 300) ?? null }, where: endpoint });
    else if (result.status && endpoint.operation && !declaredStatus(endpoint.operation, result.status)) findings.push({ type: 'contract-status', class: 'improvement',
      title: `${named} answered ${result.status}, which its OpenAPI description does not declare`, detail: `Declared: ${Object.keys(endpoint.operation.responses ?? {}).join(', ')}.`,
      evidence: { endpoint: named, status: result.status }, where: endpoint });
    if (endpoint.secured && result.status >= 200 && result.status < 300) findings.push({ type: 'open-endpoint', class: 'breaks-use',
      title: `${named} answered ${result.status} with no credentials`, detail: 'Its OpenAPI description says it needs credentials; SFlow sent none.',
      evidence: { endpoint: named, call: 'no credentials', status: result.status }, where: endpoint });
    for (const bad of invalid) {
      const answer = await call(baseUrl, endpoint.method, bad.path, { body: bad.body, raw: bad.raw ?? null });
      calls.push({ endpoint: named, input: bad.what, ...answer });
      if (answer.status >= 500) findings.push({ type: 'server-error-on-bad-input', class: 'breaks-use', title: `${named} answered ${answer.status} to ${bad.what}`,
        detail: `Bad input should get a 4xx with a clear message, never a ${answer.status}.`, evidence: { endpoint: named, call: bad.what, status: answer.status, body: answer.body?.slice(0, 300) ?? null }, where: endpoint });
    }
  }
  findings.push(...await logFindings(logs().slice(logStart)));
  return { calls, findings };
}
