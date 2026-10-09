/**
 * Python calls resolved by Pyright, the type checker bundled with Singularity Flow.
 *
 * Pyright runs as a language server over stdio. For every function and method the structural
 * preview recorded in the requested files, the call hierarchy names the declarations its calls
 * resolve to (`cart.add()` names the `add` that runs, `Order(...)` names the class). A class's base
 * classes are resolved with go-to-definition, and a method whose name a base class (at any depth in
 * the repository) also defines overrides it. Both ends are named by path, name and the line of the
 * name, which semantic-join.mjs joins to the preview's declaration IDs.
 *
 * Nothing from the analyzed repository is executed. The server is started without a PATH, so it
 * never runs a Python interpreter to find an environment: third-party packages are not resolved,
 * and calls into them (or into the standard library) are left out.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PYTHON_SEMANTIC_PACK = Object.freeze({ id: 'sflow-python-pyright', packVersion: '1.0.0', extractorVersion: '1.0.0' });

const CALLABLE_KINDS = new Set(['function', 'async-function', 'method']);

/**
 * A JSON-RPC connection over a language server's stdio, with LSP's Content-Length framing.
 * `respond(method, params)` answers the server's own requests (configuration, progress).
 */
export class LanguageServerConnection {
  constructor(input, output, { respond = () => null } = {}) {
    this.input = input;
    this.pending = new Map();
    this.next = 1;
    this.buffer = Buffer.alloc(0);
    this.respond = respond;
    output.on('data', (chunk) => this.receive(chunk));
  }

  send(message) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.input.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.input.write(body);
  }

  request(method, params) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method, params) {
    this.send({ method, params });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const header = this.buffer.indexOf('\r\n\r\n');
      if (header < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/iu.exec(this.buffer.subarray(0, header).toString('ascii'))?.[1]);
      if (!Number.isInteger(length) || this.buffer.length < header + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(header + 4, header + 4 + length).toString('utf8'));
      this.buffer = this.buffer.subarray(header + 4 + length);
      if (message.method && message.id != null) this.send({ id: message.id, result: this.respond(message.method, message.params) });
      else if (message.id != null && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message ?? 'language server error'));
        else resolve(message.result);
      }
    }
  }

  /** Reject every outstanding request (the server exited). */
  fail(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

/** Pyright's answers to its `workspace/configuration` requests: analyze open files only, no environment. */
export function pyrightConfiguration(items = []) {
  return items.map((item) => (item?.section === 'python.analysis' || item?.section === 'python'
    ? (item.section === 'python' ? { analysis: { diagnosticMode: 'openFilesOnly', autoSearchPaths: true } } : { diagnosticMode: 'openFilesOnly', autoSearchPaths: true })
    : null));
}

/** A repository-relative POSIX path for a file URI inside `root`, or null outside it. */
export function repositoryPath(root, uri) {
  if (!String(uri).startsWith('file:')) return null;
  const relative = path.relative(root, fileURLToPath(uri)).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) return null;
  return relative.split('/').some((part) => part === 'node_modules' || part.startsWith('.')) ? null : relative;
}

function span(range) {
  const startLine = range.start.line + 1;
  const endLine = range.end.line + 1;
  const startColumn = range.start.character + 1;
  const endColumn = Math.max(endLine === startLine ? startColumn : 1, range.end.character + 1);
  return { startLine, startColumn, endLine, endColumn };
}

/**
 * Call and override edges for the requested files. `files` are repository-relative paths whose
 * skeletons are `skeletons.get(path)`; `skeletonFor(path)` and `readLines(path)` read any
 * repository file's skeleton and source lines (or null); `openFile(path)` opens a document on the
 * server and returns its URI.
 */
export async function pythonEdges(connection, root, files, { skeletons, skeletonFor, readLines, openFile }) {
  const edges = [];
  for (const file of files) {
    const uri = await openFile(file);
    for (const symbol of skeletons.get(file) ?? []) {
      if (symbol.kind !== 'symbol' || !CALLABLE_KINDS.has(symbol.declarationKind)) continue;
      const position = { line: symbol.span.startLine - 1, character: symbol.span.startColumn - 1 };
      const items = await connection.request('textDocument/prepareCallHierarchy', { textDocument: { uri }, position }).catch(() => null);
      if (!items?.length) continue;
      const outgoing = await connection.request('callHierarchy/outgoingCalls', { item: items[0] }).catch(() => null) ?? [];
      for (const call of outgoing) {
        const target = repositoryPath(root, call.to?.uri);
        if (!target || !target.endsWith('.py')) continue;
        edges.push({
          type: 'calls',
          caller: { path: file, name: symbol.name, line: symbol.span.startLine },
          target: { path: target, name: call.to.name, line: call.to.selectionRange.start.line + 1 },
          span: span(call.fromRanges?.[0] ?? call.to.selectionRange)
        });
      }
    }
  }
  edges.push(...await overrideEdges(connection, root, files, { skeletons, skeletonFor, readLines, openFile }));
  return edges;
}

/** The repository classes a class's bases resolve to, by go-to-definition on each base's name. */
async function baseClasses(connection, root, file, classSymbol, { skeletonFor, readLines, openFile }) {
  const bases = [];
  const facts = await skeletonFor(file) ?? [];
  const named = facts.filter((fact) => fact.kind === 'relationship' && fact.type === 'extends' && fact.sourceId === classSymbol.id);
  if (!named.length) return bases;
  const uri = await openFile(file);
  const text = (await readLines(file))?.[classSymbol.span.startLine - 1] ?? '';
  for (const relationship of named) {
    // `class OrderService(Base, mixins.Audited):` — ask for the definition of the last name part.
    const target = String(relationship.target).split('[')[0].trim();
    const lastPart = target.split('.').at(-1);
    const column = text.indexOf(target, text.indexOf(classSymbol.name) + classSymbol.name.length);
    if (column < 0 || !lastPart) continue;
    const character = column + target.length - lastPart.length;
    const locations = await connection.request('textDocument/definition', {
      textDocument: { uri }, position: { line: classSymbol.span.startLine - 1, character }
    }).catch(() => null);
    for (const location of [].concat(locations ?? [])) {
      const targetUri = location.targetUri ?? location.uri;
      const range = location.targetSelectionRange ?? location.range;
      const basePath = repositoryPath(root, targetUri);
      if (!basePath?.endsWith('.py') || !range) continue;
      const base = (await skeletonFor(basePath) ?? []).find((fact) => fact.kind === 'symbol' && fact.declarationKind === 'class'
        && fact.span.startLine === range.start.line + 1);
      if (base) bases.push({ path: basePath, symbol: base });
    }
  }
  return bases;
}

/**
 * Overrides: a method overrides each same-named method of a repository base class, at any depth.
 * Dunder methods (`__init__`, `__eq__`) are left out: calls to them are not dispatch an injected
 * implementation decides.
 */
async function overrideEdges(connection, root, files, { skeletons, skeletonFor, readLines, openFile }) {
  const edges = [];
  const context = { skeletonFor, readLines, openFile };
  const methodsOf = (facts, classId) => facts.filter((fact) => fact.kind === 'symbol' && fact.containerId === classId
    && fact.declarationKind === 'method' && !/^__.*__$/u.test(fact.name));
  for (const file of files) {
    const facts = skeletons.get(file) ?? [];
    for (const classSymbol of facts.filter((fact) => fact.kind === 'symbol' && fact.declarationKind === 'class')) {
      const methods = methodsOf(facts, classSymbol.id);
      if (!methods.length) continue;
      const visited = new Set([`${file}\0${classSymbol.id}`]);
      const pending = await baseClasses(connection, root, file, classSymbol, context);
      while (pending.length && visited.size < 100) {
        const base = pending.shift();
        const key = `${base.path}\0${base.symbol.id}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const baseMethods = methodsOf(await skeletonFor(base.path) ?? [], base.symbol.id);
        for (const method of methods) {
          const overridden = baseMethods.find((candidate) => candidate.name === method.name);
          if (!overridden) continue;
          edges.push({
            type: 'overrides',
            caller: { path: file, name: method.name, line: method.span.startLine },
            target: { path: base.path, name: overridden.name, line: overridden.span.startLine },
            span: method.span
          });
        }
        pending.push(...await baseClasses(connection, root, base.path, base.symbol, context));
      }
    }
  }
  return edges;
}

