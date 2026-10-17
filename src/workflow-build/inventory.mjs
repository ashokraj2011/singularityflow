/**
 * What a team's material holds, item by item, each with the file and lines it was found at. Pure:
 * it reads only the screened capture (src/team-import/capture.mjs) and never fetches, runs or calls
 * anything it finds.
 *
 * Found by layout: agents, skills, instructions and prompt files (the team-import format table),
 * the process an agent or prompt describes, request files, MCP settings, scripts and documents.
 * Found by pattern (src/guidance-scan.mjs): API calls, links, check commands and sign-off
 * checkpoints in any text. Found in an API description: each operation of an OpenAPI or Swagger
 * document and each request of a Postman collection.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import { scanGuidanceText } from '../guidance-scan.mjs';

export const ITEM_KINDS = Object.freeze(['process', 'step', 'agent', 'skill', 'instruction', 'prompt', 'document', 'api-call', 'tool',
  'link', 'command', 'checkpoint', 'script', 'withheld']);
export const ITEM_KIND_LABELS = Object.freeze({
  process: 'Process', step: 'Steps', agent: 'Agents', skill: 'Skills', instruction: 'Instructions', prompt: 'Prompt files',
  document: 'Documents', 'api-call': 'API calls', tool: 'Tools and MCP servers', link: 'Links', command: 'Commands',
  checkpoint: 'Sign-off points', script: 'Scripts', withheld: 'Withheld'
});
/** How a count of each kind reads in a sentence: one and many. */
export const ITEM_KIND_WORDS = Object.freeze({
  process: ['process', 'processes'], step: ['step', 'steps'], agent: ['agent', 'agents'], skill: ['skill', 'skills'],
  instruction: ['instruction file', 'instruction files'], prompt: ['prompt file', 'prompt files'], document: ['document', 'documents'],
  'api-call': ['API call', 'API calls'], tool: ['tool or MCP server', 'tools and MCP servers'], link: ['link', 'links'],
  command: ['command', 'commands'], checkpoint: ['sign-off point', 'sign-off points'], script: ['script', 'scripts'], withheld: ['withheld file', 'withheld files']
});
export const countWords = (kind, count) => `${count} ${ITEM_KIND_WORDS[kind][count === 1 ? 0 : 1]}`;
/** Extensions the builder reads as text beyond team import's own (request files and scripts). */
export const BUILD_TEXT_EXTENSIONS = Object.freeze(new Set(['.http', '.rest', '.sh', '.bash', '.zsh', '.ps1']));

const ROLE_KIND = Object.freeze({ agent: 'agent', skill: 'skill', instruction: 'instruction', procedure: 'prompt' });
const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);
const SCRIPT = /\.(?:sh|bash|zsh|ps1)$|(?:^|\/)(?:Makefile|Justfile)$/iu;
const DOCUMENT = /\.(?:md|markdown|txt)$/iu;
const MCP_FILE = /(?:^|\/)(?:\.vscode\/)?\.?mcp\.json$/iu;

function itemId(kind, where, line, name) {
  return `i-${createHash('sha256').update([kind, where, line, name].join('\0')).digest('hex').slice(0, 12)}`;
}

function item(kind, name, file, { startLine = 1, endLine = startLine, detail = null, foundBy, certainty = 'stated', extra = {} }) {
  return {
    id: itemId(kind, file.path, startLine, name),
    kind, name: String(name).slice(0, 200),
    ...(detail ? { detail: String(detail).slice(0, 400) } : {}),
    evidence: [{ path: file.path, sha256: file.sha256 ?? null, startLine, endLine }],
    foundBy, certainty, status: 'open', ...extra
  };
}

/** Line numbers for nodes of a YAML or JSON document (JSON is YAML). */
function parsedWithLines(text) {
  const lineCounter = new YAML.LineCounter();
  try {
    const document = YAML.parseDocument(text, { lineCounter, maxAliasCount: 50, prettyErrors: false });
    if (document.errors.length) return null;
    return { document, lineOf: (node) => (node?.range ? lineCounter.linePos(node.range[0]).line : 1) };
  } catch { return null; }
}

/** Each operation of an OpenAPI 3 or Swagger 2 document. */
function openApiCalls(file, text) {
  const parsed = parsedWithLines(text);
  const value = parsed?.document.toJS({ maxAliasCount: 50 });
  if (!value || typeof value !== 'object' || !(value.openapi || value.swagger) || !value.paths || typeof value.paths !== 'object') return null;
  const server = Array.isArray(value.servers) ? value.servers[0]?.url : value.host ? `${(value.schemes ?? ['https'])[0]}://${value.host}${value.basePath ?? ''}` : null;
  let host = null;
  try { host = server ? new URL(server).host : null; } catch {}
  const calls = [];
  const paths = parsed.document.get('paths', true);
  for (const pair of YAML.isMap(paths) ? paths.items : []) {
    const route = YAML.isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    for (const operation of YAML.isMap(pair.value) ? pair.value.items : []) {
      const method = String(YAML.isScalar(operation.key) ? operation.key.value : operation.key).toLowerCase();
      if (!METHODS.has(method)) continue;
      const body = operation.value?.toJSON?.() ?? {};
      const line = parsed.lineOf(operation.key);
      calls.push(item('api-call', `${method.toUpperCase()} ${route}`, file, {
        startLine: line, endLine: line, foundBy: 'api-spec',
        detail: [body.summary ?? body.operationId, host].filter(Boolean).join(' · ') || null,
        extra: { method: method.toUpperCase(), target: route, host }
      }));
    }
  }
  return calls;
}

/** Each request of a Postman collection (v2), with the line its URL is written on. */
function postmanCalls(file, text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value?.info || !Array.isArray(value.item) || !/postman/iu.test(String(value.info.schema ?? value.info._postman_id ?? ''))) return null;
  const lines = text.split('\n');
  const calls = [];
  const walk = (entries, folder) => {
    for (const entry of entries ?? []) {
      if (Array.isArray(entry?.item)) { walk(entry.item, entry.name ?? folder); continue; }
      const request = entry?.request;
      if (!request) continue;
      const raw = typeof request.url === 'string' ? request.url : request.url?.raw ?? '';
      const method = String(request.method ?? 'GET').toUpperCase();
      const at = Math.max(1, lines.findIndex((line) => raw && line.includes(JSON.stringify(raw).slice(1, -1))) + 1);
      let host = null;
      try { host = new URL(raw.replace(/\{\{[^}]*\}\}/gu, 'x')).host; } catch {}
      calls.push(item('api-call', `${method} ${raw || entry.name}`, file, { startLine: at, foundBy: 'api-spec',
        detail: [entry.name, folder].filter(Boolean).join(' · ') || null, extra: { method, target: raw, host } }));
    }
  };
  walk(value.item, null);
  return calls;
}

/** Requests in an .http or .rest file: `METHOD url` lines. */
function requestFileCalls(file, text) {
  return text.split('\n').flatMap((line, index) => {
    const match = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/u.exec(line);
    if (!match) return [];
    let host = null;
    try { host = new URL(match[2]).host; } catch {}
    return [item('api-call', `${match[1]} ${match[2]}`, file, { startLine: index + 1, foundBy: 'layout', extra: { method: match[1], target: match[2], host } })];
  });
}

/** MCP servers an `mcp.json` (VS Code or tool) declares; never started. */
function mcpServers(file, text) {
  const parsed = parsedWithLines(text);
  if (!parsed) return [];
  const servers = parsed.document.get('servers', true) ?? parsed.document.get('mcpServers', true);
  if (!YAML.isMap(servers)) return [];
  return servers.items.map((pair) => {
    const name = YAML.isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const value = pair.value?.toJSON?.() ?? {};
    const line = parsed.lineOf(pair.key);
    return item('tool', name, file, { startLine: line, foundBy: 'layout',
      detail: value.url ? `MCP server at ${value.url}` : value.command ? `MCP server started with ${value.command}` : 'MCP server',
      extra: { tool: 'mcp-server' } });
  });
}

/**
 * The items a capture holds. `capture` and `contents` are what captureTeamDirectory returns.
 * Items found twice (the same kind and name in the same file) are kept once, at their first line.
 */
export function inventoryCapture(capture, contents) {
  const items = [];
  const seen = new Set();
  const push = (entry) => {
    const key = `${entry.kind}\0${entry.evidence[0].path}\0${entry.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(entry);
  };
  const entries = new Map((capture.entryCandidates ?? []).map((candidate) => [candidate.path, candidate]));
  for (const file of capture.files) {
    if (['withheld', 'blocked'].includes(file.screening)) {
      push(item('withheld', file.path, file, { foundBy: 'layout',
        detail: file.screening === 'blocked' ? 'its name looks like a credential, key or environment file, so it was never read'
          : `it looks like it holds a credential (${(file.findings ?? []).map((finding) => finding.label).filter(Boolean).slice(0, 3).join(', ') || 'secret'}), so it was never read` }));
      continue;
    }
    const text = contents.get(file.path);
    if (file.screening !== 'clean' || text === undefined) continue;
    const lines = file.lines ?? text.split('\n').length;
    const kind = ROLE_KIND[file.role];
    if (kind) {
      push(item(kind, file.id ?? path.posix.basename(file.relative), file, { endLine: lines, foundBy: 'layout',
        detail: file.frontMatter?.description ?? null, extra: { format: file.format } }));
      const tools = (file.frontMatter?.tools ?? []).filter((tool) => /\//u.test(tool));
      for (const tool of tools) push(item('tool', tool, file, { foundBy: 'layout', detail: `a tool ${file.id} asks for`, extra: { tool: 'agent-tool' } }));
    }
    if (entries.has(file.path)) {
      push(item('process', file.id ?? file.relative, file, { endLine: lines, foundBy: 'layout', certainty: 'inferred',
        detail: entries.get(file.path).reasons.join('; ') }));
    }
    const lower = file.relative.toLowerCase();
    let calls = null;
    if (/\.(?:ya?ml|json)$/u.test(lower)) calls = openApiCalls(file, text) ?? (lower.endsWith('.json') ? postmanCalls(file, text) : null);
    if (calls) { calls.forEach(push); continue; }
    if (/\.(?:http|rest)$/u.test(lower)) { requestFileCalls(file, text).forEach(push); continue; }
    if (MCP_FILE.test(lower)) { mcpServers(file, text).forEach(push); continue; }
    if (SCRIPT.test(file.relative)) push(item('script', file.relative, file, { endLine: lines, foundBy: 'layout', detail: 'a script the team runs; recorded, never run' }));
    if (!kind && DOCUMENT.test(lower)) push(item('document', file.relative, file, { endLine: lines, foundBy: 'layout' }));
    if (!DOCUMENT.test(lower) && !SCRIPT.test(file.relative) && !kind) continue;
    const scan = scanGuidanceText(text);
    for (const call of scan.apiCalls) {
      push(item('api-call', `${call.method} ${call.target}`, file, { startLine: call.line, foundBy: 'pattern', detail: `${call.via === 'text' ? 'written as' : call.via}${call.host ? ` · ${call.host}` : ''}`,
        extra: { method: call.method, target: call.target, host: call.host } }));
    }
    for (const link of scan.links.filter((entry) => entry.kind !== 'relative')) {
      push(item('link', link.url, file, { startLine: link.line, foundBy: 'pattern', detail: link.kind, extra: { linkKind: link.kind, host: link.host } }));
    }
    for (const command of scan.commands) push(item('command', command.command, file, { startLine: command.line, foundBy: 'pattern' }));
    for (const checkpoint of scan.checkpoints) {
      push(item('checkpoint', checkpoint.text, file, { startLine: checkpoint.line, foundBy: 'pattern', certainty: 'inferred' }));
    }
  }
  const order = new Map(ITEM_KINDS.map((kind, index) => [kind, index]));
  return items.sort((a, b) => order.get(a.kind) - order.get(b.kind)
    || (a.evidence[0].path < b.evidence[0].path ? -1 : a.evidence[0].path > b.evidence[0].path ? 1 : a.evidence[0].startLine - b.evidence[0].startLine));
}

/** How many items of each kind, in display order, leaving out kinds with none. */
export function itemCounts(items) {
  return Object.fromEntries(ITEM_KINDS.map((kind) => [kind, items.filter((entry) => entry.kind === kind).length]).filter(([, count]) => count));
}
