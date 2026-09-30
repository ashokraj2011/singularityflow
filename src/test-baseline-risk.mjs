/**
 * Narrow local acknowledgement of tests already failing before a Story began.
 *
 * This is not a passing test receipt or an authenticated approval. Story start may use an exact-base,
 * unexpired decision only to acknowledge tests that failed before coding. Phase and publication
 * gates remain independent. Callers must retain the failed execution and a distinct verdict;
 * they must never use this module to suppress a
 * missing command, missing report, timeout, changed source, protected path, or new failure.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SUPPORTED_ADAPTERS = new Set(['junit-xml', 'jest-json', 'vitest-json', 'node-tap']);
const MAX_ACCEPTANCE_DAYS = 30;

function digest(value) {
  return `sha256:${recordSha256(value)}`;
}

function argvDigest(argv) {
  return `sha256:${createHash('sha256').update(JSON.stringify(argv)).digest('hex')}`;
}

function validCounts(counts) {
  return ['discovered', 'passed', 'failed', 'skipped']
    .every((key) => Number.isSafeInteger(counts?.[key]) && counts[key] >= 0)
    && counts.passed + counts.failed + counts.skipped === counts.discovered;
}

function displayIdentity(adapter, entry) {
  if (entry?.identityStatus !== 'observed-name-only') return null;
  const safe = (value) => typeof value === 'string' && value.length > 0 && value.length < 256
    && !/[\x00-\x1f\x7f]/u.test(value);
  if (adapter === 'junit-xml') {
    if (!safe(entry.className) || !safe(entry.name)) return null;
    return JSON.stringify([entry.className, entry.name]);
  }
  if (adapter === 'jest-json' || adapter === 'vitest-json') {
    if (!safe(entry.fullName) || !safe(entry.name)
        || !Array.isArray(entry.ancestorTitles)
        || entry.ancestorTitles.length > 16
        || entry.ancestorTitles.some((value) => !safe(value))) return null;
    return JSON.stringify([entry.fullName, entry.name, entry.ancestorTitles]);
  }
  if (adapter === 'node-tap') return safe(entry.name) ? JSON.stringify([entry.name]) : null;
  return null;
}

function uniqueFailureIds(adapter, entries) {
  if (!Array.isArray(entries)) return null;
  const identities = entries.map((entry) => displayIdentity(adapter, entry));
  if (identities.some((identity) => identity === null)
      || new Set(identities).size !== identities.length) return null;
  return identities.sort((left, right) => left.localeCompare(right, 'en'));
}

function testTools(baseline) {
  return Array.isArray(baseline?.testTools) ? baseline.testTools : [];
}

/** Fail closed unless the baseline actually proves *every* required test tool was observed. */
export function assessPreStoryTestBaseline(baseline) {
  const reasons = [];
  try { readRecord('repository-test-baseline', baseline); }
  catch { reasons.push('baseline-schema'); }
  const core = baseline && typeof baseline === 'object' ? { ...baseline } : null;
  if (core) delete core.baselineSha256;
  if (!core || baseline.kind !== 'repository-test-baseline'
      || !DIGEST.test(baseline.baselineSha256 ?? '')
      || digest(core) !== baseline.baselineSha256) reasons.push('baseline-integrity');
  // A full-scope precheck may have build/start checks *after* a failed test, which the runner has
  // not executed. Only the dependency/test scope can be completely observed at this boundary.
  if (baseline?.status !== 'failing-tests' || baseline?.scope !== 'dependency-test'
      || baseline?.sourceTrackedOnly !== true) {
    reasons.push('baseline-not-a-structured-test-failure');
  }
  if (!/^[a-f0-9]{40,64}$/u.test(baseline?.sourceCommit ?? '')
      || !DIGEST.test(baseline?.planId ?? '')
      || !DIGEST.test(baseline?.sourceManifestSha256 ?? '')
      || !baseline?.platform || !baseline?.arch) reasons.push('baseline-binding');
  const tools = testTools(baseline);
  const observations = Array.isArray(baseline?.testObservations) ? baseline.testObservations : [];
  const results = Array.isArray(baseline?.commandResults) ? baseline.commandResults : [];
  if (!tools.length || !results.length || observations.length !== tools.length) {
    reasons.push('incomplete-test-inventory');
  }
  const declaredIds = new Set(tools.map((tool) => tool?.id));
  if (declaredIds.size !== tools.length || tools.some((tool) =>
    !tool || typeof tool.id !== 'string' || !tool.id
      || typeof tool.workingDirectory !== 'string'
      || !Array.isArray(tool.affectedRoots))
      || results.some((entry) => entry?.purpose === 'test' && !declaredIds.has(entry.id))) {
    reasons.push('unmatched-test-command');
  }
  if (results.some((entry) => !entry || (entry.purpose !== 'test' && entry.status !== 'pass'))) {
    reasons.push('non-test-readiness-failed');
  }
  if (baseline?.failedCommandId !== results.find((entry) => entry?.status === 'failed')?.id) {
    reasons.push('failed-command-mismatch');
  }
  const commands = [];
  for (const tool of tools) {
    if (!tool || typeof tool.id !== 'string') {
      reasons.push('test-observation-incomplete:unknown');
      continue;
    }
    const observation = observations.filter((entry) => entry?.commandId === tool.id);
    const result = results.filter((entry) => entry?.purpose === 'test' && entry.id === tool.id);
    if (!SUPPORTED_ADAPTERS.has(tool.adapter)
        || !DIGEST.test(tool.argvSha256 ?? '')
        || !Number.isSafeInteger(tool.minimumDiscovered)
        || tool.minimumDiscovered < 1
        || !observation.length || observation.length !== 1
        || result.length !== 1 || !['pass', 'failed'].includes(result[0].status)
        || observation[0].status !== 'available'
        || observation[0].adapter !== tool.adapter
        || !validCounts(observation[0].counts)
        || observation[0].counts.discovered < tool.minimumDiscovered
        || observation[0].failingCasesTruncated) {
      reasons.push(`test-observation-incomplete:${tool.id}`);
      continue;
    }
    const failedIds = uniqueFailureIds(tool.adapter, observation[0].failingCases);
    if (!failedIds || failedIds.length !== observation[0].counts.failed
        || (result[0].status === 'failed' && (result[0].reason !== 'non-zero-exit'
          || observation[0].counts.failed === 0))
        || (result[0].status === 'pass' && observation[0].counts.failed !== 0)) {
      reasons.push(`test-failure-identity-unavailable:${tool.id}`);
      continue;
    }
    commands.push({
      commandId: tool.id,
      argvSha256: tool.argvSha256,
      adapter: tool.adapter,
      workingDirectory: tool.workingDirectory,
      affectedRoots: tool.affectedRoots,
      counts: observation[0].counts,
      failedIds
    });
  }
  if (commands.length !== tools.length || !commands.some((entry) => entry.failedIds.length)) {
    reasons.push('no-complete-failing-test-baseline');
  }
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], commands };
}

/** An explicit human decision; no caller can silently infer consent from a failed precheck. */
export function createPreStoryTestRiskAcceptance(baseline, {
  actor, reason, confirmBaselineSha256, acceptedAt = new Date().toISOString(), expiresAt
} = {}) {
  const assessment = assessPreStoryTestBaseline(baseline);
  if (!assessment.eligible || confirmBaselineSha256 !== baseline.baselineSha256) {
    throw new SingularityFlowError('Pre-Story test risk requires an eligible exact baseline and explicit confirmation.', {
      code: 'PRE_STORY_TEST_RISK_INELIGIBLE', details: { reasons: assessment.reasons }
    });
  }
  const principal = typeof actor === 'string' ? actor.trim()
    : String(actor?.login ?? actor?.email ?? actor?.name ?? '').trim();
  if (!principal || principal.length > 256 || /[\x00-\x1f\x7f]/u.test(principal)
      || typeof reason !== 'string' || reason.trim().length < 15 || reason.length > 2000) {
    throw new SingularityFlowError('Risk acceptance requires a human identity and a substantive reason.', {
      code: 'PRE_STORY_TEST_RISK_DECISION_INVALID'
    });
  }
  const startMs = Date.parse(acceptedAt);
  const endMs = Date.parse(expiresAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
      || endMs - startMs > MAX_ACCEPTANCE_DAYS * 24 * 60 * 60 * 1000) {
    throw new SingularityFlowError('Risk acceptance requires an expiry within 30 days.', {
      code: 'PRE_STORY_TEST_RISK_DECISION_INVALID'
    });
  }
  const core = {
    schemaVersion: currentSchemaVersion('preexisting-test-risk-acceptance'),
    kind: 'preexisting-test-risk-acceptance',
    status: 'accepted-known-failures',
    baselineSha256: baseline.baselineSha256,
    sourceCommit: baseline.sourceCommit,
    sourceManifestSha256: baseline.sourceManifestSha256,
    planId: baseline.planId,
    platform: baseline.platform,
    arch: baseline.arch,
    scope: baseline.scope,
    commands: assessment.commands,
    actor: principal,
    reason: reason.trim(),
    acceptedAt,
    expiresAt
  };
  return { ...core, acceptanceSha256: digest(core) };
}

/**
 * A current non-zero test run may be *accepted as a known failure*, never reported as passing.
 * The caller must still separately check source immutability, coverage, and every other command.
 */
export function assessAcceptedTestFailure(acceptance, baseline, {
  command, check, parsed, now = new Date().toISOString()
} = {}) {
  const reasons = [];
  const original = assessPreStoryTestBaseline(baseline);
  if (!original.eligible) reasons.push('baseline-ineligible');
  if (!validAcceptance(acceptance, baseline)) reasons.push('acceptance-record-invalid');
  const core = acceptance && typeof acceptance === 'object' ? { ...acceptance } : null;
  if (core) delete core.acceptanceSha256;
  if (!core || acceptance.kind !== 'preexisting-test-risk-acceptance'
      || acceptance.status !== 'accepted-known-failures'
      || !DIGEST.test(acceptance.acceptanceSha256 ?? '')
      || digest(core) !== acceptance.acceptanceSha256) reasons.push('acceptance-integrity');
  if (acceptance?.baselineSha256 !== baseline?.baselineSha256
      || acceptance?.sourceCommit !== baseline?.sourceCommit
      || acceptance?.sourceManifestSha256 !== baseline?.sourceManifestSha256
      || acceptance?.planId !== baseline?.planId
      || acceptance?.scope !== baseline?.scope
      || acceptance?.platform !== process.platform
      || acceptance?.arch !== process.arch) reasons.push('acceptance-binding');
  if (digest(acceptance?.commands ?? null) !== digest(original.commands)) {
    reasons.push('acceptance-command-set-mismatch');
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) || nowMs < Date.parse(acceptance?.acceptedAt ?? '')
      || nowMs > Date.parse(acceptance?.expiresAt ?? '')) reasons.push('acceptance-expired');
  const selected = original.commands.find((entry) => entry.commandId === command?.id);
  const accepted = acceptance?.commands?.find((entry) => entry.commandId === command?.id);
  if (!selected || !accepted || digest(selected) !== digest(accepted)
      || argvDigest(command.argv) !== selected.argvSha256
      || command.workingDirectory !== selected.workingDirectory
      || digest(command.affectedRoots ?? []) !== digest(selected.affectedRoots)
      || command.result?.adapter !== selected.adapter
      || parsed?.adapter !== selected.adapter) reasons.push('test-command-mismatch');
  if (check?.status !== 'failed' || !Number.isInteger(check?.exitCode)
      || check.exitCode === 0 || !validCounts(parsed?.tests)
      || !parsed?.testcaseObservation?.occurrences
      || parsed.tests.discovered < (selected?.counts?.discovered ?? Number.MAX_SAFE_INTEGER)
      || parsed.tests.passed < (selected?.counts?.passed ?? Number.MAX_SAFE_INTEGER)
      || parsed.tests.skipped > (selected?.counts?.skipped ?? -1)
      || parsed.tests.failed > (selected?.counts?.failed ?? -1)) reasons.push('test-result-regressed-or-unavailable');
  const occurrences = parsed?.testcaseObservation?.occurrences ?? [];
  const failed = occurrences.filter((entry) => entry.outcome === 'failed');
  const currentIds = uniqueFailureIds(parsed?.adapter, failed);
  const observed = {
    passed: occurrences.filter((entry) => entry.outcome === 'passed').length,
    failed: failed.length,
    skipped: occurrences.filter((entry) => entry.outcome === 'skipped').length
  };
  if (!currentIds || currentIds.length !== parsed?.tests?.failed
      || occurrences.length !== parsed?.tests?.discovered
      || Object.keys(observed).some((key) => observed[key] !== parsed?.tests?.[key])
      || currentIds.some((id) => !selected?.failedIds?.includes(id))) reasons.push('new-or-unverifiable-test-failure');
  return {
    accepted: reasons.length === 0,
    reasons: [...new Set(reasons)],
    disposition: reasons.length ? 'blocked' : 'accepted-known-failures',
    commandId: command?.id ?? null,
    baselineSha256: baseline?.baselineSha256 ?? null,
    acceptanceSha256: acceptance?.acceptanceSha256 ?? null,
    currentFailedIds: currentIds ?? []
  };
}

function acceptanceDirectory(root, baselineSha256) {
  if (!DIGEST.test(baselineSha256 ?? '')) throw new SingularityFlowError(
    'Test risk acceptance requires an exact baseline digest.', {
      code: 'PRE_STORY_TEST_RISK_DECISION_INVALID'
    }
  );
  return path.join(gitCommonDir(root), 'singularity-flow', 'repository-readiness',
    'test-risk-acceptances', baselineSha256.slice('sha256:'.length));
}

function validAcceptance(acceptance, baseline) {
  try { readRecord('preexisting-test-risk-acceptance', acceptance); }
  catch { return false; }
  let reconstructed;
  try {
    reconstructed = createPreStoryTestRiskAcceptance(baseline, {
      actor: acceptance.actor, reason: acceptance.reason,
      confirmBaselineSha256: acceptance.baselineSha256,
      acceptedAt: acceptance.acceptedAt, expiresAt: acceptance.expiresAt
    });
  } catch { return false; }
  const core = acceptance && typeof acceptance === 'object' ? { ...acceptance } : null;
  if (core) delete core.acceptanceSha256;
  return core && acceptance.kind === 'preexisting-test-risk-acceptance'
    && acceptance.acceptanceSha256 === reconstructed.acceptanceSha256
    && DIGEST.test(acceptance.acceptanceSha256 ?? '')
    && digest(core) === acceptance.acceptanceSha256
    && acceptance.baselineSha256 === baseline.baselineSha256
    && acceptance.sourceCommit === baseline.sourceCommit
    && acceptance.sourceManifestSha256 === baseline.sourceManifestSha256
    && acceptance.planId === baseline.planId
    && acceptance.platform === baseline.platform
    && acceptance.arch === baseline.arch
    && acceptance.scope === baseline.scope
    && digest(acceptance.commands) === digest(assessPreStoryTestBaseline(baseline).commands);
}

/**
 * Verify a local human decision for the selected immutable Story base. This authorizes only
 * Story creation; it does not turn failing tests into a passing receipt or waive later gates.
 */
export function assessPreStoryRiskForStoryStart(acceptance, baseline, {
  baseCommit, now = new Date().toISOString()
} = {}) {
  const assessment = assessPreStoryTestBaseline(baseline);
  const reasons = [...assessment.reasons];
  if (!assessment.eligible || !validAcceptance(acceptance, baseline)) {
    reasons.push('acceptance-record-invalid');
  }
  if (!/^[a-f0-9]{40,64}$/u.test(baseCommit ?? '')
      || baseline?.sourceCommit !== baseCommit
      || acceptance?.sourceCommit !== baseCommit
      || acceptance?.sourceManifestSha256 !== baseline?.sourceManifestSha256
      || acceptance?.planId !== baseline?.planId
      || acceptance?.platform !== process.platform
      || acceptance?.arch !== process.arch
      || baseline?.scope !== 'dependency-test') reasons.push('story-base-or-host-mismatch');
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) || nowMs < Date.parse(acceptance?.acceptedAt ?? '')
      || nowMs > Date.parse(acceptance?.expiresAt ?? '')) reasons.push('acceptance-expired');
  return Object.freeze({
    accepted: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]),
    baselineSha256: baseline?.baselineSha256 ?? null,
    acceptanceSha256: acceptance?.acceptanceSha256 ?? null,
    sourceCommit: baseline?.sourceCommit ?? null
  });
}

/** Append-only Git-private decision. No application checkout, Story, or branch is changed. */
export async function storePreStoryTestRiskAcceptance(root, acceptance, baseline) {
  if (!assessPreStoryTestBaseline(baseline).eligible || !validAcceptance(acceptance, baseline)) {
    throw new SingularityFlowError('Test risk acceptance does not match the exact eligible baseline.', {
      code: 'PRE_STORY_TEST_RISK_DECISION_INVALID'
    });
  }
  const directory = acceptanceDirectory(root, baseline.baselineSha256);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${acceptance.acceptanceSha256.slice('sha256:'.length)}.json`);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file');
      const existing = readRecord('preexisting-test-risk-acceptance', await readFile(target, 'utf8')).record;
      if (!validAcceptance(existing, baseline)
          || existing.acceptanceSha256 !== acceptance.acceptanceSha256) throw new Error('invalid record');
      return { acceptance: existing, file: target, created: false };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new SingularityFlowError(
        'Existing test risk decision cannot be safely reconciled.', {
          code: 'PRE_STORY_TEST_RISK_DECISION_INVALID', cause: error
        }
      );
    }
    await writeFile(temporary, `${JSON.stringify(acceptance, null, 2)}\n`, {
      flag: 'wx', mode: 0o600
    });
    await rename(temporary, target);
    return { acceptance, file: target, created: true };
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Read only the bounded decisions for the exact current baseline; fail closed on malformed data. */
export async function listPreStoryTestRiskAcceptances(root, baseline) {
  if (!assessPreStoryTestBaseline(baseline).eligible) return [];
  const directory = acceptanceDirectory(root, baseline.baselineSha256);
  let names;
  try { names = await readdir(directory); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (names.length > 100 || names.some((name) => !/^[a-f0-9]{64}\.json$/u.test(name))) {
    throw new SingularityFlowError('Test risk decision directory contains unexpected entries.', {
      code: 'PRE_STORY_TEST_RISK_DECISION_INVALID'
    });
  }
  const decisions = [];
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('invalid file');
      const acceptance = readRecord('preexisting-test-risk-acceptance', await readFile(file, 'utf8')).record;
      if (!validAcceptance(acceptance, baseline)
          || `${acceptance.acceptanceSha256.slice('sha256:'.length)}.json` !== name) {
        throw new Error('decision digest mismatch');
      }
      decisions.push({ acceptance, file });
    } catch (error) {
      throw new SingularityFlowError('A Git-private test risk decision failed integrity validation.', {
        code: 'PRE_STORY_TEST_RISK_DECISION_INVALID', cause: error, details: { file }
      });
    }
  }
  return decisions.sort((left, right) => right.acceptance.acceptedAt.localeCompare(left.acceptance.acceptedAt));
}
