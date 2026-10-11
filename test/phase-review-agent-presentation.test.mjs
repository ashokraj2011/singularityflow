/**
 * `phase show --for-agent --json`: every authored byte, engine-written blocks as hash-bound references.
 *
 * In a live Copilot Story the managed metadata block and the managed copy of approved inputs were
 * about four fifths of each document an agent re-read for review. The agent view replaces each with
 * one marker line; the document keeps its full-file identity and nothing authored is dropped.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { phaseReviewAgentPresentation } from '../src/agent-packet-presentation.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const metadata = '<!-- singularity-flow:metadata\n{\n  "schemaVersion": 1,\n  "workId": "DEMO-1"\n}\n-->\n';
const inputs = '<!-- singularity-flow:inputs:start -->\n## Approved inputs\n\nIntake text copied by the engine.\n<!-- singularity-flow:inputs:end -->';
const authoredHead = '# DEMO-1 — Code checking\n\n## Traceability comparison\n\n| `DEMO-1:AC-001` | matched |\n\n';
const authoredTail = '\n\n## Final conclusion\n\nThe change meets Intake.\n';
const content = `${metadata}${authoredHead}${inputs}${authoredTail}`;

function review() {
  return {
    schemaVersion: 1, workId: 'DEMO-1', phase: 'conformance',
    displayBinding: { schemaVersion: 1, documents: [{ id: 'PHASE-CONFORMANCE', sha256: sha256(content) }] },
    documents: [
      { id: 'PHASE-CONFORMANCE', kind: 'conformance-report', path: 'work/DEMO-1/report.md', size: Buffer.byteLength(content),
        sha256: sha256(content), binary: false, truncated: false, content },
      { id: 'ART-01', kind: 'code', path: 'src/value.mjs', size: 24, sha256: sha256('export const value = 2;\n'), binary: false,
        truncated: false, display: { mode: 'reference-preview', full: 'export const value = 2;\n' } },
      { id: 'NOTE-01', kind: 'notes', path: 'work/DEMO-1/notes.md', content: 'Plain authored notes.\n' }
    ],
    continuation: { platformCommands: { darwin: 'singularity-flow submit conformance', win32: 'singularity-flow.cmd submit conformance' } }
  };
}

test('engine-written blocks become hash-bound markers and every authored byte remains', () => {
  const agent = phaseReviewAgentPresentation(review(), 'darwin');
  const [report, code, notes] = agent.documents;
  assert.deepEqual(report.managedBlocks, [
    { kind: 'metadata', bytes: Buffer.byteLength(metadata), sha256: sha256(metadata) },
    { kind: 'inputs', bytes: Buffer.byteLength(inputs), sha256: sha256(inputs) }
  ]);
  assert.equal(report.contentForm, 'authored-with-managed-references');
  assert.match(report.content, /^<!-- singularity-flow:metadata block, \d+ bytes, sha256:[a-f0-9]{64}; engine-written\. Full text: singularity-flow documents view PHASE-CONFORMANCE -->\n/u);
  assert.equal(report.content.includes('Intake text copied by the engine'), false);
  const rebuilt = report.content
    .replace(/^<!-- singularity-flow:metadata block, [^\n]*-->\n/u, metadata)
    .replace(/<!-- singularity-flow:inputs block, [^\n]*?-->/u, inputs);
  assert.equal(rebuilt, content, 'putting the blocks back gives the exact document');
  assert.equal(report.size, Buffer.byteLength(content), 'the document keeps its full-file size');
  assert.equal(report.sha256, sha256(content), 'and its full-file digest');
  assert.deepEqual(agent.displayBinding, review().displayBinding, 'the display binding still names the full document');
  assert.deepEqual(code, review().documents[1], 'source displays are untouched');
  assert.deepEqual(notes, review().documents[2], 'a document without managed blocks is untouched');
  assert.deepEqual(agent.continuation.platformCommands, { darwin: 'singularity-flow submit conformance' });
});
