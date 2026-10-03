/**
 * No version issue: every version-sensitive refusal is classified, and every refusal an installed
 * build can meet is healed automatically or guided to one exact step.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { refusalRemediationPlan, UPGRADE_GUIDED_CODES } from '../src/refusal-remediation.mjs';
import {
  AUTOMATIC_UPGRADE_REPAIRS, UPGRADE_CONTRACT, UPGRADE_TRANSITION_GATES, VERSION_SENSITIVE_CODE
} from '../src/upgrade-contract.mjs';

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const GENERIC_STEPS = new Set(['command-help', 'diagnose-repository', 'recommended-next']);

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(file));
    else if (entry.name.endsWith('.mjs')) files.push(file);
  }
  return files;
}

async function versionSensitiveCodes() {
  const codes = new Set();
  for (const file of await sourceFiles(source)) {
    for (const match of (await readFile(file, 'utf8')).matchAll(/code: '([A-Z][A-Z0-9_]*)'/gu)) {
      if (VERSION_SENSITIVE_CODE.test(match[1])) codes.add(match[1]);
    }
  }
  return codes;
}

// A representative refusal per guided code, carrying the details its producer attaches.
const REPRESENTATIVE = Object.freeze({
  WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED: { details: { workType: 'feature' } },
  STORY_ARCHIVED_BY_REBUILD: { details: { workId: 'FEAT-1', plan: 'grb-0123456789abcdef01234567', archivedAt: '2026-10-03T00:00:00.000Z' } },
  CONVERGENCE_LEGACY_MIGRATION_REQUIRED: {
    details: { command: `singularity-flow story converge --work-id FEAT-1 --migrate-legacy --confirm sha256:${'a'.repeat(64)}` }
  }
});
// Guided by a step a person performs outside the CLI; the step still names exactly what to do.
const COMMANDLESS = new Set(['PRODUCT_ALIGNMENT_INSTALL_RECOVERY_PENDING']);

test('every version-sensitive refusal in the source is classified', async () => {
  const found = await versionSensitiveCodes();
  const unclassified = [...found].filter((code) => !Object.hasOwn(UPGRADE_CONTRACT, code)).sort();
  assert.deepEqual(unclassified, [],
    'classify each new version-sensitive code in src/upgrade-contract.mjs: guided (with a remediation step), integrity, development or unrelated');
  const stale = Object.entries(UPGRADE_CONTRACT)
    .filter(([code, entry]) => entry.resolution !== 'guided' && !found.has(code)).map(([code]) => code);
  assert.deepEqual(stale, [], 'a classification whose code no longer exists is removed');
  for (const [code, entry] of Object.entries(UPGRADE_CONTRACT)) {
    assert.ok(['guided', 'integrity', 'development', 'unrelated'].includes(entry.resolution), code);
    if (entry.resolution !== 'guided') assert.ok(entry.reason?.length > 10, `${code} says why it is not guided`);
  }
});

test('the guided codes and the upgrade remediation table are the same set', () => {
  const guidedCodes = Object.entries(UPGRADE_CONTRACT)
    .filter(([, entry]) => entry.resolution === 'guided').map(([code]) => code).sort();
  assert.deepEqual([...UPGRADE_GUIDED_CODES].sort(), guidedCodes);
});

test('every guided refusal carries its own exact next step, not only generic fallbacks', () => {
  for (const code of UPGRADE_GUIDED_CODES) {
    const plan = refusalRemediationPlan({ code, message: `${code} refusal`, ...(REPRESENTATIVE[code] ?? {}) }, []);
    const specific = plan.steps.filter((entry) => entry && !GENERIC_STEPS.has(entry.id));
    assert.ok(specific.length > 0, `${code} has no code-specific step`);
    if (!COMMANDLESS.has(code)) {
      assert.ok(specific.some((entry) => entry.command && entry.copyable),
        `${code} has no exact, copyable command: ${JSON.stringify(specific)}`);
    }
  }
});

test('every automatic repair a classification names exists, and every transition gate is healed first', () => {
  for (const [code, entry] of Object.entries(UPGRADE_CONTRACT)) {
    if (entry.healedBy) assert.ok(Object.hasOwn(AUTOMATIC_UPGRADE_REPAIRS, entry.healedBy), code);
  }
  for (const [gate, entry] of Object.entries(UPGRADE_TRANSITION_GATES)) {
    assert.ok(Object.hasOwn(AUTOMATIC_UPGRADE_REPAIRS, entry.healedBy), gate);
  }
});
