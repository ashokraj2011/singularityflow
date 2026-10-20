import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(packageRoot, 'apps', 'vscode', 'src', name);
const { copilotChatCounting } = await import(pathToFileURL(source('copilot-chat-counting-state.ts')).href);
const { copilotActivityHtml } = await import(pathToFileURL(source('views/dashboard-copilot.ts')).href);

const file = '/home/dev/.singularity-flow/copilot-chat-otel.jsonl';

test('Copilot Chat counts only when it writes SFlow\'s file, and any other setup is left alone', () => {
  assert.equal(copilotChatCounting({}, {}, file), 'off');
  assert.equal(copilotChatCounting({ enabled: true, outfile: file }, {}, file), 'on');
  assert.equal(copilotChatCounting({ enabled: true, outfile: file, exporterType: 'file' }, {}, file), 'on');
  for (const [settings, env] of [
    [{ enabled: true, outfile: '/elsewhere/otel.jsonl' }, {}],
    [{ enabled: true }, {}],
    [{ otlpEndpoint: 'https://collector.example.invalid' }, {}],
    [{ enabled: false }, {}],
    [{ enabled: true, outfile: file, captureContent: true }, {}],
    [{ enabled: true, outfile: file }, { COPILOT_OTEL_FILE_EXPORTER_PATH: '/other.jsonl' }],
    [{}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.invalid' }]
  ]) assert.equal(copilotChatCounting(settings, env, file), 'other-setup', JSON.stringify({ settings, env }));
  assert.equal(copilotChatCounting({ enabled: true, outfile: file }, {}, ''), 'other-setup',
    'without the file path, an existing setup is never mistaken for nothing');
});

test('the offer and the background sync never run the CLI while counting is off', async () => {
  const module = await readFile(source('copilot-chat-counting.ts'), 'utf8');
  const offer = module.slice(module.indexOf('export async function offerCopilotChatCounting'), module.indexOf('export function startCopilotChatCounting'));
  assert.match(offer, /copilotChatCounting\(explicitSettings\(\), process\.env, ''\)/);
  assert.doesNotMatch(offer.slice(0, offer.indexOf("'Turn on', 'No thanks'")), /currentCounting|client\.run/);
  const sync = module.slice(module.indexOf('export function startCopilotChatCounting'));
  assert.ok(sync.indexOf("settings.enabled !== true || typeof settings.outfile !== 'string'") < sync.indexOf('currentCounting(client)'));
  assert.match(module, /captureContent/, 'content capture is part of the decision');
  assert.doesNotMatch(module, /update\('captureContent'/, 'SFlow never writes content capture');
});

test('Story Analytics shows Copilot Chat\'s requests and billed usage from the report', () => {
  const count = (value) => ({ value, status: value == null ? 'none' : 'observed' });
  const phase = {
    id: 'design', label: 'Design', generations: 1, sentBack: 0,
    copilot: {
      status: 'observed', requests: count(4), turns: count(null), modelCalls: count(12), toolCalls: count(null),
      failedToolCalls: count(null), premiumRequests: { value: 4, status: 'estimated', missingModels: [] },
      billedAiu: count(1.25), eventCount: 0, prompt: null
    }
  };
  const html = copilotActivityHtml({
    phases: [phase],
    copilot: {
      status: 'observed', requests: count(4), turns: count(null), turnsDerived: false, modelCalls: count(12), toolCalls: count(null),
      premiumRequests: { value: 4, status: 'estimated', missingModels: [] }, premiumMultipliersConfigured: true,
      billedAiu: count(1.25), chat: { counted: true, since: '2026-10-19T09:00:00.000Z', syncedAt: null, requests: 4, cachedShare: 81 },
      events: [], eventsObserved: false, eventCount: 0, omittedEvents: 0, largestPrompt: null, promptsOverBudget: [], captureNotes: []
    }
  });
  assert.match(html, /<strong>1\.25<\/strong><span>Billed usage \(AIU\) · reported by Copilot Chat<\/span>/);
  assert.match(html, /<th>Billed \(AIU\)<\/th>/);
  assert.match(html, /<td>1\.25<\/td>/);
  assert.match(html, /<strong>Unavailable<\/strong><span>Quota and model events<\/span>/,
    'Copilot Chat counts carry no quota events: not a zero');
  assert.match(html, /Copilot Chat on this computer: 4 requests for this Story, counted since 2026-10-19T09:00:00\.000Z; 81% of their input tokens read from Copilot's cache\./);
});
