/**
 * GDP-M3 append-only proof storage.
 *
 * Subject/evidence records use the existing DraftUnitOfWork preimage journal and subject lock.
 * Operational receipts use the hardened Git-common immutable sidecar writer after semantic records
 * are stable. A receipt failure is therefore retryable and can never roll back verified evidence.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { runDraftTransaction } from '../draft-unit-of-work.mjs';
import { branch, gitCommonDir, head } from '../git.mjs';
import { writeImmutablePrivateSidecar } from '../private-sidecar.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { readRecord } from '../schema-migrations.mjs';
import {
  ensureSecureRepositoryDirectory, secureRepositoryPath, SingularityFlowError,
  writeAtomicExclusive
} from '../util.mjs';
import {
  PROOF_KERNEL_LIMITS, PROOF_RECORD_FAMILIES, validateProofRecord
} from './proof-kernel.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROOF_PROFILES = new Set(['standard', 'high-assurance', 'regulated', 'custom-registered']);
const PROOF_SUBJECT_KEYS = [
  'schemaVersion', 'kind', 'workId', 'candidateSha256', 'completionContractSha256',
  'effectPolicySha256', 'proofPolicySha256', 'proofProfile', 'worldModel',
  'proofSubjectSha256'
];

function fail(message, code = 'PFC_PREDICATE_INPUT_INVALID', details = null, cause = undefined) {
  throw new SingularityFlowError(message, { code, details, cause });
}

function rawDigest(value, label) {
  if (!DIGEST.test(String(value ?? ''))) fail(`${label} must be a sha256 digest.`);
  return String(value).slice(7);
}

function proofSubject(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...PROOF_SUBJECT_KEYS].sort())) {
    fail('Proof Subject has an invalid field set.', 'PFC_PROOF_SUBJECT_INVALID');
  }
  const readable = readRecord('proof-subject', record);
  if (readable.migratedThrough.length !== 0
      || record.kind !== 'proof-subject' || !SAFE_WORK_ID.test(String(record.workId ?? ''))) {
    fail('Proof Subject identity is invalid.', 'PFC_PROOF_SUBJECT_INVALID');
  }
  for (const field of [
    'candidateSha256', 'completionContractSha256', 'effectPolicySha256',
    'proofPolicySha256', 'proofSubjectSha256'
  ]) rawDigest(record[field], `proof-subject.${field}`);
  if (!PROOF_PROFILES.has(record.proofProfile)) fail('Proof Subject profile is invalid.', 'PFC_PROOF_SUBJECT_INVALID');
  if (!record.worldModel || typeof record.worldModel !== 'object' || Array.isArray(record.worldModel)
      || JSON.stringify(Object.keys(record.worldModel).sort())
        !== JSON.stringify(['baselineSha256', 'candidateDeltaSha256', 'reasonCode', 'status'])) {
    fail('Proof Subject World Model binding is invalid.', 'PFC_PROOF_SUBJECT_INVALID');
  }
  if (!['ready', 'unavailable', 'not-required'].includes(record.worldModel.status)) {
    fail('Proof Subject World Model status is invalid.', 'PFC_PROOF_SUBJECT_INVALID');
  }
  for (const field of ['baselineSha256', 'candidateDeltaSha256']) {
    if (record.worldModel[field] != null) rawDigest(record.worldModel[field], `proof-subject.worldModel.${field}`);
  }
  if (record.worldModel.reasonCode != null
      && !/^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(String(record.worldModel.reasonCode))) {
    fail('Proof Subject World Model reason is invalid.', 'PFC_PROOF_SUBJECT_INVALID');
  }
  const core = structuredClone(record);
  delete core.proofSubjectSha256;
  if (`sha256:${recordSha256(core)}` !== record.proofSubjectSha256) {
    fail('Proof Subject self hash is invalid.', 'PFC_PROOF_SUBJECT_INVALID');
  }
  if (Buffer.byteLength(canonicalJson(record), 'utf8') > PROOF_KERNEL_LIMITS.maximumOutputBytes) {
    fail('Proof Subject exceeds its byte ceiling.', 'PFC_RECORD_TOO_LARGE');
  }
  return Object.freeze(structuredClone(record));
}

function relativeRecordPath(workId, family, plane, sha256) {
  return path.posix.join(
    'singularity', 'work-items', workId, 'gdp',
    plane === 'decision' ? 'decisions' : plane === 'evidence' ? 'evidence' : 'subjects',
    family, `${rawDigest(sha256, `${family} identity`)}.json`
  );
}

function recordsFromObservation(observation) {
  if (!observation || observation.kind !== 'gdp-proof-observation' || !observation.proofSubject) {
    fail('A complete GDP proof observation is required before persistence.');
  }
  const subject = proofSubject(observation.proofSubject);
  const records = [{
    family: 'proof-subject', plane: 'subject', hashField: 'proofSubjectSha256', record: subject
  }];
  for (const [family, values] of [
    ['proof-predicate-specification', observation.predicateSpecifications],
    ['proof-predicate-result', observation.results],
    ['proof-signal-observation', observation.signals],
    ['proof-gap-item', observation.gaps],
    ['proof-evidence-invalidation', observation.invalidations ?? (observation.invalidation ? [observation.invalidation] : [])]
  ]) {
    for (const record of values ?? []) records.push({
      family,
      plane: PROOF_RECORD_FAMILIES[family].plane,
      hashField: PROOF_RECORD_FAMILIES[family].hashField,
      record: validateProofRecord(family, record)
    });
  }
  for (const [family, record] of [
    ['proof-gap-register', observation.gapRegister],
    ['proof-summary', observation.summary],
    ['proof-profile-selection', observation.profileSelection]
  ]) {
    if (!record) continue;
    records.push({
      family,
      plane: PROOF_RECORD_FAMILIES[family].plane,
      hashField: PROOF_RECORD_FAMILIES[family].hashField,
      record: validateProofRecord(family, record)
    });
  }
  for (const entry of records) {
    if (entry.record.proofSubjectSha256 != null
        && entry.record.proofSubjectSha256 !== subject.proofSubjectSha256) {
      fail(`${entry.family} binds another Proof Subject.`, 'PFC_PROOF_SUBJECT_INVALID');
    }
  }
  const specifications = records
    .filter((entry) => entry.family === 'proof-predicate-specification')
    .map((entry) => entry.record);
  const results = records
    .filter((entry) => entry.family === 'proof-predicate-result')
    .map((entry) => entry.record);
  const signals = records
    .filter((entry) => entry.family === 'proof-signal-observation')
    .map((entry) => entry.record);
  const gaps = records
    .filter((entry) => entry.family === 'proof-gap-item')
    .map((entry) => entry.record);
  const summary = records.find((entry) => entry.family === 'proof-summary')?.record ?? null;
  const gapRegister = records.find((entry) => entry.family === 'proof-gap-register')?.record ?? null;
  const profileSelection = records.find((entry) => entry.family === 'proof-profile-selection')?.record ?? null;
  const predicateIdentities = new Map();
  for (const specification of specifications) {
    const identity = canonicalJson(specification.predicate);
    const previous = predicateIdentities.get(identity);
    if (previous && previous !== specification.specificationSha256) {
      fail('Conflicting Predicate Specifications share one identity.', 'PFC_PROOF_SUBJECT_INVALID');
    }
    predicateIdentities.set(identity, specification.specificationSha256);
  }
  for (const result of results) {
    if (!predicateIdentities.has(canonicalJson(result.predicate))) {
      fail('Predicate Result has no exact Specification in this observation.', 'PFC_PROOF_SUBJECT_INVALID');
    }
    if (result.proofProfile !== subject.proofProfile) {
      fail('Predicate Result profile differs from its Proof Subject.', 'PFC_PROOF_SUBJECT_INVALID');
    }
  }
  const exactSet = (values) => [...new Set(values)].sort();
  if (gapRegister && canonicalJson(gapRegister.gapRefs)
      !== canonicalJson(exactSet(gaps.map((entry) => entry.gapSha256)))) {
    fail('Gap Register does not exactly cover this observation.', 'PFC_PROOF_SUBJECT_INVALID');
  }
  if (summary) {
    const summarizedResults = Object.values(summary.predicateResults).flat().sort();
    if (canonicalJson(summarizedResults)
        !== canonicalJson(exactSet(results.map((entry) => entry.resultSha256)))) {
      fail('Proof Summary does not exactly cover this observation results.', 'PFC_PROOF_SUBJECT_INVALID');
    }
    if (canonicalJson(summary.signals)
        !== canonicalJson(exactSet(signals.map((entry) => entry.observationSha256)))) {
      fail('Proof Summary does not exactly cover this observation Signals.', 'PFC_PROOF_SUBJECT_INVALID');
    }
    if (summary.gapRegisterSha256 !== (gapRegister?.gapRegisterSha256 ?? null)
        || summary.proofProfile !== subject.proofProfile) {
      fail('Proof Summary binding differs from its Proof Subject or Gap Register.', 'PFC_PROOF_SUBJECT_INVALID');
    }
  }
  if (profileSelection && (profileSelection.workId !== subject.workId
      || profileSelection.proofProfile !== subject.proofProfile)) {
    fail('Proof Profile Selection binds another subject.', 'PFC_PROOF_SUBJECT_INVALID');
  }
  const resultIdentities = new Set(results.map((entry) => entry.resultSha256));
  const summaryIdentities = new Set(summary ? [summary.summarySha256] : []);
  for (const invalidation of records
    .filter((entry) => entry.family === 'proof-evidence-invalidation')
    .map((entry) => entry.record)) {
    if (invalidation.invalidatedResults.some((identity) => !resultIdentities.has(identity))
        || invalidation.invalidatedSummaries.some((identity) => !summaryIdentities.has(identity))) {
      fail('Invalidation references evidence outside this observation.', 'PFC_PROOF_SUBJECT_INVALID');
    }
  }
  const unique = new Map();
  for (const entry of records) {
    const sha256 = entry.record[entry.hashField];
    const key = `${entry.family}\0${sha256}`;
    if (unique.has(key) && canonicalJson(unique.get(key).record) !== canonicalJson(entry.record)) {
      fail(`${entry.family} identity conflicts inside the observation.`, 'PFC_PROOF_SUBJECT_INVALID');
    }
    unique.set(key, entry);
  }
  return { subject, records: [...unique.values()] };
}

async function immutableRepositoryWrite(root, relative, record) {
  const bytes = canonicalJson(record);
  if (Buffer.byteLength(bytes, 'utf8') > PROOF_KERNEL_LIMITS.maximumOutputBytes) {
    fail('Proof record exceeds its byte ceiling.', 'PFC_RECORD_TOO_LARGE');
  }
  await ensureSecureRepositoryDirectory(root, path.dirname(relative), {
    label: 'GDP proof record directory'
  });
  let target = await secureRepositoryPath(root, relative, { label: 'GDP proof record' });
  if (!target.exists) {
    try { await writeAtomicExclusive(target.absolute, bytes); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    target = await secureRepositoryPath(root, relative, {
      label: 'GDP proof record', mustExist: true, type: 'file'
    });
  }
  const stored = await readFile(target.absolute, 'utf8');
  if (Buffer.byteLength(stored, 'utf8') > PROOF_KERNEL_LIMITS.maximumOutputBytes || stored !== bytes) {
    fail('Immutable GDP proof record conflicts with existing bytes.', 'PFC_PROOF_SUBJECT_INVALID', {
      family: record.kind
    });
  }
  return target.relative;
}

function operationalReceiptPath(root, receipt) {
  return path.join(
    gitCommonDir(root), 'singularity-flow', 'gdp', 'operations',
    rawDigest(receipt.proofSubjectSha256, 'receipt.proofSubjectSha256'),
    'proof-evaluation-receipt', `${rawDigest(receipt.receiptSha256, 'receipt.receiptSha256')}.json`
  );
}

export function proofObservationWritePlan(observation) {
  const { subject, records } = recordsFromObservation(observation);
  return Object.freeze({
    workId: subject.workId,
    proofSubjectSha256: subject.proofSubjectSha256,
    records: records.map((entry) => Object.freeze({
      family: entry.family,
      sha256: entry.record[entry.hashField],
      path: relativeRecordPath(subject.workId, entry.family, entry.plane, entry.record[entry.hashField])
    })).sort((left, right) => left.path.localeCompare(right.path))
  });
}

export async function persistProofObservation(root, observation, {
  expectedBranch = branch(root), evaluationReceipts = [], fault = null
} = {}) {
  const { subject, records } = recordsFromObservation(observation);
  const plan = proofObservationWritePlan(observation);
  if (!Array.isArray(evaluationReceipts) || evaluationReceipts.length > PROOF_KERNEL_LIMITS.maximumPredicates) {
    fail('evaluationReceipts exceeds the predicate ceiling.');
  }
  const receipts = evaluationReceipts.map((receipt) => {
    const checked = validateProofRecord('proof-evaluation-receipt', receipt);
    if (checked.proofSubjectSha256 !== subject.proofSubjectSha256) {
      fail('Evaluation receipt binds another Proof Subject.');
    }
    return checked;
  });
  const byIdentity = new Map(records.map((entry) => [entry.record[entry.hashField], entry]));
  const resultIdentities = new Set(records
    .filter((entry) => entry.family === 'proof-predicate-result')
    .map((entry) => entry.record.resultSha256));
  for (const receipt of receipts) {
    if (!resultIdentities.has(receipt.resultSha256)) {
      fail('Evaluation receipt references a Predicate Result outside this observation.');
    }
  }
  const branchName = expectedBranch;
  const written = await runDraftTransaction(root, {
    subject: { kind: 'story', id: subject.workId, branch: branchName },
    expectedRevision: { head: head(root) },
    allowedPaths: plan.records.map((entry) => entry.path),
    operation: 'append GDP proof observation',
    write: async () => {
      const paths = [];
      for (let index = 0; index < plan.records.length; index += 1) {
        const item = plan.records[index];
        const entry = byIdentity.get(item.sha256);
        paths.push(await immutableRepositoryWrite(root, item.path, entry.record));
        if (fault) await fault('after-proof-record-write', { index, item });
      }
      return paths;
    },
    validate: async () => {
      for (const item of plan.records) {
        const loaded = await readProofRecord(root, subject.workId, item.family, item.sha256);
        if (loaded[PROOF_RECORD_FAMILIES[item.family]?.hashField ?? 'proofSubjectSha256'] !== item.sha256) {
          fail('Stored proof record failed exact read-back validation.', 'PFC_RECOVERY_REQUIRED');
        }
      }
    }
  });

  const operational = [];
  for (const receipt of receipts) {
    try {
      const publication = await writeImmutablePrivateSidecar(
        root, operationalReceiptPath(root, receipt), canonicalJson(receipt),
        { maximumBytes: PROOF_KERNEL_LIMITS.maximumOutputBytes }
      );
      operational.push({ receiptSha256: receipt.receiptSha256, created: publication.created });
    } catch (error) {
      fail(
        'Semantic proof records are stable, but an operational evaluation receipt was not recorded. '
        + 'Rerun the same append operation to complete the receipt; no proof or lifecycle authority changed.',
        'PFC_RECOVERY_REQUIRED', { proofSubjectSha256: subject.proofSubjectSha256 }, error
      );
    }
  }
  return Object.freeze({
    mode: 'observe', authority: 'none', workId: subject.workId,
    proofSubjectSha256: subject.proofSubjectSha256,
    paths: Object.freeze([...written]),
    operational: Object.freeze(operational),
    lifecycleChanged: false,
    publicationCreated: false
  });
}

export async function readProofRecord(root, workId, family, sha256) {
  if (!SAFE_WORK_ID.test(String(workId ?? ''))) fail('Work ID is invalid.');
  const descriptor = family === 'proof-subject'
    ? { plane: 'subject', hashField: 'proofSubjectSha256' }
    : PROOF_RECORD_FAMILIES[family];
  if (!descriptor || descriptor.plane === 'operational') fail(`Unsupported repository proof family '${family}'.`, 'PFC_SCHEMA_UNAVAILABLE');
  const relative = relativeRecordPath(workId, family, descriptor.plane, sha256);
  const target = await secureRepositoryPath(root, relative, {
    label: 'GDP proof record', mustExist: true, type: 'file'
  });
  const info = target.entry;
  if (!info || info.size > PROOF_KERNEL_LIMITS.maximumOutputBytes) fail('Proof record exceeds its byte ceiling.', 'PFC_RECORD_TOO_LARGE');
  const bytes = await readFile(target.absolute, 'utf8');
  const migrated = readRecord(family, bytes).record;
  const record = family === 'proof-subject' ? proofSubject(migrated) : validateProofRecord(family, migrated);
  if (record[descriptor.hashField] !== sha256) fail('Proof record filename and self hash differ.', 'PFC_PROOF_SUBJECT_INVALID');
  return record;
}

export async function listProofRecords(root, workId, family) {
  if (!SAFE_WORK_ID.test(String(workId ?? ''))) fail('Work ID is invalid.');
  const descriptor = family === 'proof-subject'
    ? { plane: 'subject', hashField: 'proofSubjectSha256' }
    : PROOF_RECORD_FAMILIES[family];
  if (!descriptor || descriptor.plane === 'operational') fail(`Unsupported repository proof family '${family}'.`, 'PFC_SCHEMA_UNAVAILABLE');
  const relative = path.posix.join(
    'singularity', 'work-items', workId, 'gdp',
    descriptor.plane === 'decision' ? 'decisions' : descriptor.plane === 'evidence' ? 'evidence' : 'subjects',
    family
  );
  const directory = await secureRepositoryPath(root, relative, { label: 'GDP proof record directory' });
  if (!directory.exists) return [];
  if (!directory.entry?.isDirectory()) fail('GDP proof record directory is not a directory.');
  const records = [];
  for (const entry of await readdir(directory.absolute, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    records.push(await readProofRecord(root, workId, family, `sha256:${entry.name.slice(0, -5)}`));
  }
  return records.sort((left, right) => left[descriptor.hashField].localeCompare(right[descriptor.hashField]));
}
