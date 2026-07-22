import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { createCanvas, joinSession } from '@github/copilot-sdk/extension';
import {
  DOCUMENTS_CANVAS_ID,
  DOCUMENTS_HELP,
  DOCUMENTS_INSTANCE_ID,
  flowArguments,
  inferWorkId,
  parseDocumentsArguments,
  renderDocumentsHtml
} from './documents.mjs';

const executeFile = promisify(execFile);
const instances = new Map();
let currentWorkingDirectory;
let session;

function updateWorkingDirectory(value) {
  if (typeof value === 'string' && value.trim()) currentWorkingDirectory = value.trim();
}

async function activeWorkingDirectory() {
  if (currentWorkingDirectory) return currentWorkingDirectory;
  const snapshot = await session.rpc.metadata.snapshot();
  updateWorkingDirectory(snapshot?.workingDirectory);
  if (!currentWorkingDirectory) throw new Error('No repository working directory is attached to this Copilot session.');
  return currentWorkingDirectory;
}

async function runFlow(args, { json = false, cwd } = {}) {
  const directory = cwd ?? await activeWorkingDirectory();
  const executable = process.env.SINGULARITY_FLOW_BIN || 'singularity-flow';
  try {
    const result = await executeFile(executable, args, { cwd: directory, encoding: 'utf8', timeout: 30000, maxBuffer: 12 * 1024 * 1024 });
    if (!json) return result.stdout.trimEnd();
    try { return JSON.parse(result.stdout); }
    catch { throw new Error(`Singularity Flow returned invalid JSON for '${args.join(' ')}'.`); }
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error("The 'singularity-flow' executable is not on PATH. Install the package globally, then restart Copilot CLI.");
    throw new Error(String(error?.stderr || error?.stdout || error?.message || error).trim());
  }
}

async function catalog(entry) {
  const request = { action: 'list', workId: entry.workId ?? null, reference: null };
  const documents = await runFlow(flowArguments(request, { json: true }), { json: true, cwd: entry.cwd });
  if (!Array.isArray(documents)) throw new Error('The Singularity Flow document catalog is not an array.');
  return { documents, selectedReference: entry.selectedReference ?? null, workId: entry.workId ?? inferWorkId(documents), cwd: entry.cwd };
}

async function view(entry, reference) {
  return runFlow(flowArguments({ action: 'view', workId: entry.workId ?? null, reference }, { json: true }), { json: true, cwd: entry.cwd });
}

function requireInstance(instanceId) {
  const entry = instances.get(instanceId);
  if (!entry) throw new Error(`Documents canvas instance '${instanceId}' is not open.`);
  return entry;
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function writeHtml(response) {
  const body = renderDocumentsHtml();
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"
  });
  response.end(body);
}

async function handleRequest(entry, request, response) {
  try {
    const url = new URL(request.url || '/', entry.url);
    if (request.method === 'GET' && url.pathname === '/') return writeHtml(response);
    if (request.method === 'GET' && url.pathname === '/api/state') return writeJson(response, 200, await catalog(entry));
    if (request.method === 'GET' && url.pathname === '/api/document') {
      const reference = url.searchParams.get('reference');
      if (!reference) return writeJson(response, 400, { error: 'A document reference is required.' });
      return writeJson(response, 200, await view(entry, reference));
    }
    return writeJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    return writeJson(response, 500, { error: error?.message ?? String(error) });
  }
}

async function startServer(instanceId, input, cwd) {
  const entry = { instanceId, cwd, workId: input?.workId ?? null, selectedReference: input?.reference ?? null, server: null, url: '' };
  entry.server = createServer((request, response) => { handleRequest(entry, request, response); });
  await new Promise((resolve, reject) => {
    entry.server.once('error', reject);
    entry.server.listen(0, '127.0.0.1', resolve);
  });
  const address = entry.server.address();
  entry.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
  return entry;
}

async function openDocumentsCanvas(request) {
  const input = {};
  if (request.workId) input.workId = request.workId;
  if (request.reference) input.reference = request.reference;
  await session.rpc.canvas.open({ canvasId: DOCUMENTS_CANVAS_ID, instanceId: DOCUMENTS_INSTANCE_ID, input });
}

async function timelineFallback(request) {
  const output = await runFlow(flowArguments(request));
  await session.log(output || 'No documents found.', { level: 'info' });
}

async function documentsCommand(context) {
  try {
    const request = parseDocumentsArguments(context.args);
    if (request.action === 'help') return session.log(DOCUMENTS_HELP, { level: 'info' });
    if (session.capabilities.ui?.canvases === false) return timelineFallback(request);
    try { await openDocumentsCanvas(request); }
    catch { await timelineFallback(request); }
  } catch (error) {
    await session.log(error?.message ?? String(error), { level: 'error' });
  }
}

session = await joinSession({
  hooks: {
    onSessionStart: async (input) => updateWorkingDirectory(input?.workingDirectory),
    onUserPromptSubmitted: async (input) => updateWorkingDirectory(input?.workingDirectory),
    onPreToolUse: async (input) => updateWorkingDirectory(input?.workingDirectory)
  },
  commands: [{ name: 'documents', description: 'Browse Singularity Flow generated artifacts and supporting documents.', handler: documentsCommand }],
  canvases: [
    createCanvas({
      id: DOCUMENTS_CANVAS_ID,
      displayName: 'Singularity Flow Documents',
      description: 'Browse generated phase artifacts, uploaded inputs, and workflow documents for the active Singularity Flow work item.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { workId: { type: 'string' }, reference: { type: 'string' } }
      },
      actions: [
        { name: 'list_documents', description: 'Return the active work item document catalog.', handler: async (ctx) => catalog(requireInstance(ctx.instanceId)) },
        {
          name: 'view_document', description: 'Return one document by stable ID or path.',
          inputSchema: { type: 'object', additionalProperties: false, required: ['reference'], properties: { reference: { type: 'string' } } },
          handler: async (ctx) => view(requireInstance(ctx.instanceId), ctx.input.reference)
        }
      ],
      open: async (ctx) => {
        updateWorkingDirectory(ctx.session?.workingDirectory);
        const cwd = await activeWorkingDirectory();
        let entry = instances.get(ctx.instanceId);
        if (!entry) {
          entry = await startServer(ctx.instanceId, ctx.input, cwd);
          instances.set(ctx.instanceId, entry);
        } else {
          entry.cwd = cwd;
          entry.workId = ctx.input?.workId ?? null;
          entry.selectedReference = ctx.input?.reference ?? null;
        }
        const state = await catalog(entry);
        return { title: 'Singularity Flow Documents', status: `${state.documents.length} document${state.documents.length === 1 ? '' : 's'}`, url: entry.url };
      },
      onClose: async (ctx) => {
        const entry = instances.get(ctx.instanceId);
        if (!entry) return;
        instances.delete(ctx.instanceId);
        await new Promise((resolve) => entry.server.close(resolve));
      }
    })
  ]
});
