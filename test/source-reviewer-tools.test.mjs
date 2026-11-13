/**
 * The reviewer agent's own tools are enough for the whole review path [Story anu-bin, 2026-11-11]. A reviewer
 * started as a sub-agent with execute/read/view (no file-edit tool) read "Author the report at stagingPath"
 * and a file-edit staging protocol, said it could not complete the review, and the person ran
 * /sf-review-source by hand. Then a terminal-only route (`stage --report-json '…'`) broke on shell quoting six times
 * on a real Story [owner, 2026-11-13]: the file is now the one write route, and the reviewer agent declares the
 * file-edit tool it needs. Every route the review hands the reviewer must run with the tools its agent file declares.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sourceReviewStagingProtocol } from '../src/source-review-staging.mjs';
import { sourceReviewProgress } from '../src/source-review-progress.mjs';
import { compactSourceReviewContext } from '../src/source-review-agent-context.mjs';
import { sourceReviewRepairGuide } from '../src/source-review-contract.mjs';

const AGENT = path.join(import.meta.dirname, '..', 'plugin', 'agents', 'sflow-source-reviewer.agent.md');

async function agentTools() {
  const text = await readFile(AGENT, 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(text)[1];
  return { text, tools: JSON.parse(/^tools:\s*(\[.*\])\s*$/mu.exec(frontmatter)[1]) };
}

// What each route needs, in the tool names Copilot agents declare.
const NEEDS = Object.freeze({
  terminal: ['execute', 'bash'], 'native-file-read': ['read', 'view'], 'file-edit': ['edit', 'write', 'create']
});
const can = (tools, need) => NEEDS[need].some((tool) => tools.includes(tool));

test('the staging protocol\'s write and read routes run with the reviewer agent\'s own tools', async () => {
  const { tools } = await agentTools();
  const protocol = sourceReviewStagingProtocol('implement', '/repo/.git/singularity-flow/source-reviews/X-implement-gen2.json');
  assert.equal(protocol.writeTool, 'file-edit');
  assert.equal(protocol.inlineJsonAllowed, false);
  assert.equal(protocol.kernelStage, undefined, 'no inline JSON route is offered');
  assert.ok(can(tools, protocol.writeTool), `writeTool ${protocol.writeTool} needs one of ${NEEDS[protocol.writeTool]}; the reviewer has ${tools}`);
  assert.ok(can(tools, protocol.readTool), `readTool ${protocol.readTool}`);
  for (const route of ['check', 'retain']) {
    assert.match(protocol[route].command, /^singularity-flow review-source /u, `${route} is a terminal command`);
    assert.ok(can(tools, 'terminal'), `${route} needs a terminal`);
  }
  assert.match(protocol.retain.command, / --for-agent --json$/u, 'a host cut a submit result without --for-agent (2026-11-10)');
});

test('every progress instruction names the file-edit route, never JSON in a shell argument', async () => {
  const { tools } = await agentTools();
  assert.equal(can(tools, 'file-edit'), true, 'the reviewer declares the file-edit tool its route needs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-reviewer-tools-'));
  try {
    const stagingPath = path.join(directory, 'X-implement-gen2.json');
    const protocol = sourceReviewStagingProtocol('implement', stagingPath);
    const progress = await sourceReviewProgress({ input: { binding: {}, workId: 'X', phase: 'implement' }, retained: {}, stagingPath,
      gitDirectory: directory, protocol, check: () => { throw new Error('no draft to check'); } });
    assert.equal(progress.state, 'author-report');
    assert.match(progress.instruction, /Write it with your file-edit tool at exactly stagingPath \(stagingProtocol\.path\), then run stagingProtocol\.check/u);
    assert.match(progress.instruction, /Never type the JSON into a shell argument/u);
    assert.match(progress.instruction, /"binding": "from-context"/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
  const repair = sourceReviewRepairGuide({}, { sources: [] }, { findings: [], evaluation: { status: 'correction-required', findings: [] }, retentionReady: false });
  assert.match(repair.instruction, /edit the file at stagingPath with your file-edit tool, then run stagingProtocol\.check/u);
  const compact = compactSourceReviewContext({ canReview: true, kind: 'code', binding: { workId: 'X' }, reportTemplate: { binding: { workId: 'X' } } }, {});
  assert.match(compact.reviewGuide.role, /write it with your file-edit tool at stagingProtocol\.path and run stagingProtocol\.check/u);
  assert.equal(compact.reportTemplate.binding, 'from-context');
});

test('the reviewer agent writes its report with the file-edit tool, never inline, and reports every finding at once', async () => {
  const { text } = await agentTools();
  assert.match(text, /write the whole report as JSON with your file-edit tool at its exact `path`/u);
  assert.match(text, /Never type the report into a shell argument/u);
  assert.doesNotMatch(text, /No file-edit tool is needed/u);
  assert.match(text, /"binding": "from-context"/u);
  assert.match(text, /it is not derivable from the path/u);
  assert.doesNotMatch(text, /with each `\/` as `:`/u, 'no derivation rule: other characters become : too, and a long path a hash');
  // Live: generation 1's review raised one finding and generation 2's another on text already there.
  assert.match(text, /Review the whole artifact every time and report every finding in this one review/u);
});
