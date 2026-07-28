import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverPacketFromOutput } from '../src/worldmodel.mjs';

test('recovers a packet an agent printed instead of writing', () => {
  const output = [
    "I'll analyze the architecture view now. Let me search the repo…",
    'Here is the packet:',
    '',
    '# architecture discovery packet',
    '',
    '## Observed',
    '- Spring Boot service at src/Main.java:1-10',
    ''
  ].join('\n');
  const recovered = recoverPacketFromOutput(output, 'architecture');
  assert.match(recovered, /^# architecture discovery packet/);
  assert.match(recovered, /Spring Boot service at src\/Main\.java:1-10/);
  // The chatty preamble before the header must be dropped.
  assert.doesNotMatch(recovered, /I'll analyze/);
});

test('unwraps a packet the agent wrapped in a Markdown code fence', () => {
  const output = [
    'Sure — here is the packet:',
    '```markdown',
    '# development discovery packet',
    '',
    'Entry point at src/cli.mjs:42.',
    '```',
    'Let me know if you need anything else.'
  ].join('\n');
  const recovered = recoverPacketFromOutput(output, 'development');
  assert.match(recovered, /^# development discovery packet/);
  assert.match(recovered, /Entry point at src\/cli\.mjs:42\./);
  // The closing fence and trailing chatter must be cut.
  assert.doesNotMatch(recovered, /```/);
  assert.doesNotMatch(recovered, /Let me know/);
});

test('returns empty when no packet header is present', () => {
  assert.equal(recoverPacketFromOutput('just some reasoning, no packet here', 'business'), '');
  assert.equal(recoverPacketFromOutput('', 'business'), '');
  assert.equal(recoverPacketFromOutput(undefined, 'business'), '');
});

test('matches only the assigned view header', () => {
  const output = '# security discovery packet\n\nAuth at src/auth.js:1.\n';
  assert.equal(recoverPacketFromOutput(output, 'testing'), '');
  assert.match(recoverPacketFromOutput(output, 'security'), /Auth at src\/auth\.js:1\./);
});
