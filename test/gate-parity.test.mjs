import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { conformanceGateCode } from '../src/governance.mjs';
import { GATE_PARITY, GATE_PARITY_OWNERS, GATE_PARITY_STAGES } from '../src/gate-parity.mjs';

const source = (name) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');

/** Every code the approval gate can refuse with: its literals and the conformance findings it maps. */
async function gateCodes() {
  const codes = new Set([...(await source('governance.mjs')).matchAll(/'(gate\.[a-z0-9.-]+)'/gu)].map((match) => match[1]));
  // The gate's conformance findings come from the shared report checks, with their own codes. The
  // self-approval one is refused by the gate directly under its gate code, already a literal.
  for (const match of (await source('conformance-readiness.mjs')).matchAll(/code: '(conformance\.[a-z-]+)'/gu)) {
    if (match[1] !== 'conformance.self-approval-undisclosed') codes.add(conformanceGateCode(match[1]));
  }
  return codes;
}

test('every approval-gate refusal names who answers it and where it is answered before the gate', async () => {
  const emitted = await gateCodes();
  const listed = new Set(Object.keys(GATE_PARITY));
  assert.deepEqual([...emitted].filter((code) => !listed.has(code)), [],
    'the gate refuses with a code src/gate-parity.mjs does not classify: add it with the check that runs earlier, or its known gap');
  assert.deepEqual([...listed].filter((code) => !emitted.has(code)), [], 'src/gate-parity.mjs lists a code the gate no longer refuses with');
  for (const [code, entry] of Object.entries(GATE_PARITY)) {
    assert.ok(GATE_PARITY_STAGES.includes(entry.stage), `${code}: unknown stage ${entry.stage}`);
    assert.ok(GATE_PARITY_OWNERS.includes(entry.owner), `${code}: unknown owner ${entry.owner}`);
    // An author can fix only what an earlier check shows; anything else is a recorded, known gap.
    if (entry.owner === 'author') {
      assert.ok(entry.stage === 'same-check' || entry.gap, `${code}: an author-owned refusal needs an earlier check or a named gap`);
    }
  }
});

test('each earlier check the registry names exists, so the parity claim cannot rot', async () => {
  const modules = new Map();
  for (const [code, entry] of Object.entries(GATE_PARITY)) {
    if (entry.stage !== 'same-check') continue;
    assert.ok(entry.checks?.length, `${code}: a same-check entry names its checks`);
    for (const named of entry.checks) {
      if (!modules.has(named.module)) modules.set(named.module, await import(`../src/${named.module}`));
      assert.equal(typeof modules.get(named.module)[named.export], 'function', `${code}: ${named.module} has no function ${named.export}`);
      assert.ok(named.at, `${code}: say where ${named.export} runs`);
    }
  }
});
