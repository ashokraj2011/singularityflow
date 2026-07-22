import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCanvas, joinSession } from '@github/copilot-sdk/extension';
import {
  createDocumentsCanvasResult,
  DOCUMENTS_CANVAS_ID,
  DOCUMENTS_HELP,
  DOCUMENTS_INSTANCE_ID,
  flowArguments,
  inferWorkId,
  parseDocumentsArguments
} from './documents.mjs';

const executeFile = promisify(execFile);
const MAX_CANVAS_PREVIEW_BYTES = 256 * 1024;
const MAX_CANVAS_TOTAL_PREVIEW_BYTES = 4 * 1024 * 1024;
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

function truncatePreview(content, byteLimit) {
  const data = Buffer.from(content, 'utf8');
  if (data.length <= byteLimit) return content;
  return `${data.subarray(0, Math.max(0, byteLimit)).toString('utf8')}\n… canvas preview truncated …\n`;
}

async function canvasSnapshot(entry) {
  const state = await catalog(entry);
  const loaded = new Map();
  const queue = [...state.documents];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const record = queue.shift();
      try { loaded.set(record.id, await view(entry, record.id)); }
      catch (error) { loaded.set(record.id, { record, error: error?.message ?? String(error) }); }
    }
  });
  await Promise.all(workers);

  let remaining = MAX_CANVAS_TOTAL_PREVIEW_BYTES;
  const details = {};
  for (const record of state.documents) {
    const result = loaded.get(record.id) ?? { record, error: 'Document preview was unavailable.' };
    if (typeof result.content === 'string') {
      const allowance = Math.min(MAX_CANVAS_PREVIEW_BYTES, remaining);
      result.content = truncatePreview(result.content, allowance);
      remaining = Math.max(0, remaining - Buffer.byteLength(result.content, 'utf8'));
    }
    details[record.id] = result;
  }
  return { ...state, details };
}

function requireInstance(instanceId) {
  const entry = instances.get(instanceId);
  if (!entry) throw new Error(`Documents canvas instance '${instanceId}' is not open.`);
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
          entry = { instanceId: ctx.instanceId, cwd, workId: ctx.input?.workId ?? null, selectedReference: ctx.input?.reference ?? null };
          instances.set(ctx.instanceId, entry);
        } else {
          entry.cwd = cwd;
          entry.workId = ctx.input?.workId ?? null;
          entry.selectedReference = ctx.input?.reference ?? null;
        }
        return createDocumentsCanvasResult(await canvasSnapshot(entry));
      },
      onClose: async (ctx) => {
        instances.delete(ctx.instanceId);
      }
    })
  ]
});
