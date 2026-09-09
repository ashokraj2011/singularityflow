/** Private Git-backed state and exact-file capture for repository-independent local Stories. */
import { randomUUID, createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod, link, lstat, mkdir, open, readdir, readFile, realpath, rm, stat
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run, SingularityFlowError, writeAtomic } from '../util.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { secureWindowsAuthAcl } from '../mcp-auth-profile.mjs';
import {
  assertUniquePortablePaths, LOC_AUDIT_PROFILE, LOC_LIMITS,
  LOC_PACKAGING_PROFILE, LOC_SIGNATURE_PROFILE, localStoryId, locFail,
  locSha256, portablePath
} from './contracts.mjs';
import { canonicalJcs } from './jcs.mjs';

const STATE_FILE = 'state.json';
const ROOT_ENV = 'SINGULARITY_FLOW_LOCAL_MODE_ROOT';
const CLASSIFICATIONS = new Set(['public', 'internal', 'confidential', 'restricted']);

function expectedStateRoot(env = process.env, home = os.homedir()) {
  const configured = env[ROOT_ENV];
  if (configured && !path.isAbsolute(configured)) {
    locFail(ROOT_ENV + ' must be an absolute path.', 'LOCAL_STATE_PATH_UNSAFE');
  }
  return path.resolve(configured || path.join(home, '.singularity-flow', 'local-mode'));
}

async function ensurePrivateDirectory(target, {
  protectWindows = false, environment = process.env
} = {}) {
  const before = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (before?.isSymbolicLink() || (before && !before.isDirectory())) {
    locFail('Local state path must be a private ordinary directory.',
      'LOCAL_STATE_PATH_UNSAFE');
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const canonical = await realpath(target);
  // The final component was checked with lstat above. Accept canonical system ancestors such as
  // macOS `/var` → `/private/var`, then use the returned real path for every child operation.
  if (process.platform !== 'win32') {
    await chmod(target, 0o700);
    const info = await stat(target);
    if ((info.mode & 0o077) !== 0) {
      locFail('Local state root must have mode 0700.',
        'LOCAL_STATE_PATH_UNSAFE');
    }
  } else if (protectWindows) {
    try {
      await secureWindowsAuthAcl(canonical, {
        directory: true, apply: true, environment
      });
    } catch (error) {
      locFail('Local state root requires a verified current-user-only Windows ACL.',
        'LOCAL_STATE_PATH_UNSAFE', { causeCode: error?.code ?? 'unknown' });
    }
  }
  return canonical;
}

export async function localModeRoot(options = {}) {
  const root = expectedStateRoot(options.env, options.home);
  return ensurePrivateDirectory(root, {
    protectWindows: true,
    environment: options.env ?? process.env
  });
}

export function localStoryPaths(stateRoot, storyId) {
  const id = localStoryId(storyId);
  const root = path.join(stateRoot, 'stories', id);
  return Object.freeze({
    id,
    root,
    ledger: path.join(root, 'ledger'),
    work: path.join(root, 'work'),
    output: path.join(root, 'work', 'outputs'),
    staging: path.join(root, 'staging'),
    state: path.join(root, 'ledger', STATE_FILE),
    records: path.join(root, 'ledger', 'records'),
    objects: path.join(root, 'ledger', 'objects')
  });
}

function git(root, args, options = {}) {
  const result = run('git', args, { cwd: root, allowFailure: true, ...options });
  if (result.status !== 0) {
    throw new SingularityFlowError(
      'Local Story ledger Git operation failed: '
      + String(result.stderr || result.stdout || args.join(' ')).trim(),
      { code: 'LOCAL_LEDGER_GIT_FAILED' }
    );
  }
  return result;
}

async function initializeLedger(paths) {
  await ensurePrivateDirectory(paths.root);
  await ensurePrivateDirectory(paths.ledger);
  await ensurePrivateDirectory(paths.work);
  await ensurePrivateDirectory(paths.output);
  await ensurePrivateDirectory(paths.staging);
  git(paths.root, [
    '-c', 'init.templateDir=', 'init', '--quiet', '--initial-branch=local', paths.ledger
  ]);
  git(paths.ledger, ['config', '--local', 'user.name', 'Singularity Flow Local Mode']);
  git(paths.ledger, ['config', '--local', 'user.email', 'local-mode@singularity.invalid']);
  git(paths.ledger, ['config', '--local', 'core.autocrlf', 'false']);
  git(paths.ledger, ['config', '--local', 'core.safecrlf', 'true']);
  const hooks = path.join(paths.ledger, '.git', 'sflow-empty-hooks');
  await ensurePrivateDirectory(hooks);
  git(paths.ledger, ['config', '--local', 'core.hooksPath', hooks]);
}

export function commitLocalLedger(paths, message) {
  git(paths.ledger, ['add', '--all', '--', '.']);
  const changed = run('git', ['diff', '--cached', '--quiet'], {
    cwd: paths.ledger, allowFailure: true
  });
  if (changed.status === 0) return null;
  if (changed.status !== 1) {
    locFail('Local Story ledger could not determine its staged state.',
      'LOCAL_LEDGER_GIT_FAILED');
  }
  git(paths.ledger, ['commit', '--quiet', '--no-gpg-sign', '-m', message]);
  return git(paths.ledger, ['rev-parse', 'HEAD']).stdout.trim();
}

export async function readLocalState(paths) {
  let text;
  try { text = await readFile(paths.state, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') {
      locFail('Local Story ' + paths.id + ' does not exist.', 'LOCAL_STORY_NOT_FOUND');
    }
    throw error;
  }
  const parsed = readRecord('local-mode-state', text).record;
  if (parsed.kind !== 'local-mode-state' || parsed.storyId !== paths.id) {
    locFail('Local Story state does not match its registry identity.',
      'LOCAL_STATE_INVALID');
  }
  return parsed;
}

export async function writeLocalState(paths, state, message) {
  const value = {
    ...structuredClone(state),
    schemaVersion: currentSchemaVersion('local-mode-state')
  };
  await writeAtomic(paths.state, canonicalJcs(value), { mode: 0o600 });
  const commit = commitLocalLedger(paths, message);
  return Object.freeze({ state: value, commit });
}

export async function localRecord(paths, family, record) {
  const durable = {
    ...structuredClone(record),
    schemaVersion: currentSchemaVersion(family),
    kind: family
  };
  const bytes = Buffer.from(canonicalJcs(durable));
  const sha256 = locSha256(bytes);
  const target = path.join(paths.records, sha256.slice(7) + '.json');
  await mkdir(paths.records, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readFile(target);
    if (locSha256(existing) !== sha256 || !existing.equals(bytes)) {
      locFail('A local content-addressed record conflicts with retained bytes.',
        'LOCAL_STATE_INVALID');
    }
  }
  return Object.freeze({
    sha256,
    path: 'records/' + sha256.slice(7) + '.json',
    sizeBytes: bytes.length,
    absolute: target,
    record: durable
  });
}

async function objectMatches(target, expectedSha256, expectedSize) {
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const hash = createHash('sha256');
  let size = 0;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expectedSize)) return false;
    const buffer = Buffer.alloc(1024 * 1024);
    while (size < Number(before.size)) {
      const result = await handle.read(buffer, 0,
        Math.min(buffer.length, Number(before.size) - size), size);
      if (!result.bytesRead) return false;
      hash.update(buffer.subarray(0, result.bytesRead));
      size += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs
        || after.ino !== before.ino || after.dev !== before.dev) return false;
  } finally { await handle.close(); }
  return 'sha256:' + hash.digest('hex') === expectedSha256;
}

async function captureRegularFile(paths, source, logicalPath) {
  portablePath(logicalPath);
  const sourceHandle = await open(source,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const temporary = path.join(paths.objects,
    '.capture-' + process.pid + '-' + randomUUID());
  let targetHandle;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.nlink > 1n) {
      locFail('Selected file is not an independent regular file: ' + source,
        'LOCAL_PATH_INVALID');
    }
    if (before.size > BigInt(LOC_LIMITS.maximumFileBytes)) {
      locFail('Selected file exceeds the local-mode size limit.',
        'LOCAL_RESOURCE_LIMIT');
    }
    await mkdir(paths.objects, { recursive: true, mode: 0o700 });
    targetHandle = await open(temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    const hash = createHash('sha256');
    let position = 0;
    const buffer = Buffer.alloc(1024 * 1024);
    while (position < Number(before.size)) {
      const result = await sourceHandle.read(buffer, 0,
        Math.min(buffer.length, Number(before.size) - position), position);
      if (!result.bytesRead) locFail('Selected file changed during capture.', 'INPUT_CHANGED');
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const resultWrite = await targetHandle.write(
          chunk, written, chunk.length - written, position + written
        );
        if (!resultWrite.bytesWritten) {
          locFail('Local object writer made no progress.', 'LOCAL_STATE_INVALID');
        }
        written += resultWrite.bytesWritten;
      }
      position += result.bytesRead;
    }
    const after = await sourceHandle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs
        || after.ino !== before.ino || after.dev !== before.dev) {
      locFail('Selected file changed during capture.', 'INPUT_CHANGED');
    }
    await targetHandle.sync();
    await targetHandle.close();
    targetHandle = null;
    const sha256 = 'sha256:' + hash.digest('hex');
    const objectRelative = 'objects/' + sha256.slice(7);
    const objectAbsolute = path.join(paths.ledger, objectRelative);
    try { await link(temporary, objectAbsolute); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!await objectMatches(objectAbsolute, sha256, Number(before.size))) {
        locFail('A local content-addressed object conflicts with retained bytes.',
          'LOCAL_STATE_INVALID');
      }
    }
    return Object.freeze({
      path: logicalPath,
      kind: 'regular',
      mode: process.platform !== 'win32' && (before.mode & 0o111n) !== 0n
        ? '0755' : '0644',
      sizeBytes: Number(before.size),
      sha256,
      object: objectRelative
    });
  } finally {
    await sourceHandle.close().catch(() => {});
    await targetHandle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function collectTree(paths, selected, { output = false } = {}) {
  const result = [];
  const selectedPaths = selected.map((value) => path.resolve(value));
  async function visit(absolute, logical) {
    const info = await lstat(absolute).catch((error) => {
      if (error?.code === 'ENOENT') {
        locFail('Selected path does not exist: ' + absolute, 'LOCAL_INPUT_MISSING');
      }
      throw error;
    });
    if (info.isSymbolicLink()) {
      locFail('Selected trees cannot contain symbolic links: ' + absolute,
        'LOCAL_PATH_INVALID');
    }
    if (info.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      entries.sort((left, right) => Buffer.compare(
        Buffer.from(left.name), Buffer.from(right.name)
      ));
      for (const entry of entries) {
        await visit(path.join(absolute, entry.name),
          logical ? logical + '/' + entry.name : entry.name);
      }
      return;
    }
    if (!info.isFile()) {
      locFail('Selected trees may contain regular files only: ' + absolute,
        'LOCAL_PATH_INVALID');
    }
    result.push(await captureRegularFile(paths, absolute, portablePath(logical)));
    if (result.length > LOC_LIMITS.maximumFiles) {
      locFail('Selected tree exceeds the local-mode file limit.',
        'LOCAL_RESOURCE_LIMIT');
    }
    const total = result.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    if (total > LOC_LIMITS.maximumContentBytes) {
      locFail('Selected tree exceeds the local-mode byte limit.',
        'LOCAL_RESOURCE_LIMIT');
    }
  }
  for (const absolute of selectedPaths) {
    const info = await lstat(absolute).catch((error) => {
      if (error?.code === 'ENOENT') {
        locFail('Selected path does not exist: ' + absolute, 'LOCAL_INPUT_MISSING');
      }
      throw error;
    });
    const logical = output && info.isDirectory() ? '' : path.basename(absolute);
    await visit(absolute, logical);
  }
  assertUniquePortablePaths(result.map((entry) => entry.path));
  return result.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

function basePolicy() {
  return Object.freeze({
    id: 'standalone-local-output-v1',
    trustScope: 'standalone',
    review: {
      eligibleRole: 'local-output-owner',
      quorum: 1,
      selfReview: true,
      maximumClassification: 'restricted'
    },
    publication: {
      destinations: ['proven-local-filesystem'],
      createOnly: true,
      signatureRequired: true
    }
  });
}

function baseWorkflow() {
  return Object.freeze({
    id: 'local-output-v1',
    phases: ['intake', 'build', 'freeze', 'verify', 'review', 'publish-bundle'],
    verification: ['exact-output-tree'],
    auditProfile: LOC_AUDIT_PROFILE,
    packagingProfile: LOC_PACKAGING_PROFILE,
    signatureProfile: LOC_SIGNATURE_PROFILE
  });
}

export async function createLocalStory({
  name, intent, inputs, classification, allowEmptyOutput = false, env, home
}) {
  if (!String(name ?? '').trim() || !String(intent ?? '').trim()) {
    locFail('Local Story start requires a display name and intent.',
      'LOCAL_INTAKE_INCOMPLETE');
  }
  if (!CLASSIFICATIONS.has(classification)) {
    locFail('Classification must be public, internal, confidential, or restricted.',
      'LOCAL_CLASSIFICATION_REQUIRED');
  }
  if (!Array.isArray(inputs) || !inputs.length) {
    locFail('Local Story start requires at least one explicit input.',
      'LOCAL_INTAKE_INCOMPLETE');
  }
  const stateRoot = await localModeRoot({ env, home });
  const id = 'LOC-' + randomUUID().replaceAll('-', '').toUpperCase();
  const paths = localStoryPaths(stateRoot, id);
  await initializeLedger(paths);
  try {
    const captured = await collectTree(paths, inputs);
    const input = await localRecord(paths, 'local-input-manifest', {
      files: captured,
      fileCount: captured.length,
      totalBytes: captured.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      observation: 'explicit-non-atomic-filesystem-capture'
    });
    const intentRecord = await localRecord(paths, 'local-intent', {
      text: String(intent).trim(),
      allowEmptyOutput: Boolean(allowEmptyOutput)
    });
    const workflow = await localRecord(paths, 'local-workflow', baseWorkflow());
    const policy = await localRecord(paths, 'local-policy', basePolicy());
    const classificationRecord = await localRecord(paths, 'local-classification', {
      level: classification,
      source: 'explicit-user-selection',
      unknowns: []
    });
    const disclosure = await localRecord(paths, 'local-disclosure-plan', {
      includeInputs: true,
      includeOutputs: true,
      includeEvidence: true,
      maximumClassification: classification
    });
    const verificationPlan = await localRecord(paths, 'local-verification-plan', {
      checks: [{
        id: 'exact-output-tree',
        kind: 'structural',
        runner: 'singularity-flow/local-mode',
        modelPolicy: 'never',
        effects: 'read-only',
        claim: 'The materialized output tree exactly equals the frozen output manifest.'
      }]
    });
    const now = new Date().toISOString();
    const state = {
      schemaVersion: currentSchemaVersion('local-mode-state'),
      kind: 'local-mode-state',
      storyId: id,
      displayName: String(name).trim(),
      generationId: 'generation-1',
      revision: 1,
      status: 'building',
      mode: 'local-bundle',
      trustScope: 'standalone',
      authorityDomainId: 'standalone:' + id,
      createdAt: now,
      updatedAt: now,
      records: {
        inputs: input.path,
        intent: intentRecord.path,
        workflow: workflow.path,
        policy: policy.path,
        classification: classificationRecord.path,
        disclosurePlan: disclosure.path,
        verificationPlan: verificationPlan.path
      },
      roots: {
        inputRoot: input.sha256,
        intentRoot: intentRecord.sha256,
        workflowRoot: workflow.sha256,
        policyRoot: policy.sha256,
        classificationRoot: classificationRecord.sha256,
        disclosurePlanRoot: disclosure.sha256,
        verificationPlanRoot: verificationPlan.sha256
      },
      candidate: null,
      verification: null,
      review: null,
      operations: [],
      deliveries: []
    };
    const written = await writeLocalState(paths, state,
      '[local-mode] create ' + id);
    return Object.freeze({
      storyId: id,
      status: written.state.status,
      ledgerCommit: written.commit,
      outputDirectory: paths.output,
      inputRoot: input.sha256,
      nextAction: 'singularity-flow local freeze --story ' + id
        + ' --output ' + JSON.stringify(paths.output)
    });
  } catch (error) {
    await rm(paths.root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function openLocalStory(storyId, options = {}) {
  const stateRoot = await localModeRoot(options);
  const paths = localStoryPaths(stateRoot, storyId);
  return { paths, state: await readLocalState(paths) };
}

export async function listLocalStories(options = {}) {
  const stateRoot = await localModeRoot(options);
  const directory = path.join(stateRoot, 'stories');
  const names = await readdir(directory).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const stories = [];
  for (const name of names.sort()) {
    if (!/^LOC-[0-9A-F]{32}$/.test(name)) continue;
    const paths = localStoryPaths(stateRoot, name);
    try {
      const state = await readLocalState(paths);
      stories.push({
        storyId: state.storyId,
        displayName: state.displayName,
        status: state.status,
        generationId: state.generationId,
        updatedAt: state.updatedAt
      });
    } catch {
      stories.push({ storyId: name, status: 'unavailable' });
    }
  }
  return stories;
}

async function lockedStory(storyId, options, callback) {
  const opened = await openLocalStory(storyId, options);
  return withSubjectLock(opened.paths.ledger,
    { kind: 'local-story', id: opened.paths.id },
    async () => callback(opened.paths, await readLocalState(opened.paths)));
}

export async function freezeLocalCandidate(storyId, outputs, options = {}) {
  return lockedStory(storyId, options, async (paths, state) => {
    if (!['building', 'frozen', 'verified', 'reviewed'].includes(state.status)) {
      locFail('Local Story cannot freeze outputs from status ' + state.status + '.',
        'LOCAL_PHASE_INVALID');
    }
    const selected = outputs?.length ? outputs : [paths.output];
    const captured = await collectTree(paths, selected, { output: true });
    const intent = JSON.parse(await readFile(
      path.join(paths.ledger, state.records.intent), 'utf8'
    ));
    if (!captured.length && !intent.allowEmptyOutput) {
      locFail('Local Story output is empty and its pinned intent did not allow that.',
        'CANDIDATE_MISMATCH');
    }
    const output = await localRecord(paths, 'local-output-manifest', {
      files: captured,
      fileCount: captured.length,
      totalBytes: captured.reduce((sum, entry) => sum + entry.sizeBytes, 0)
    });
    const candidate = await localRecord(paths, 'local-candidate', {
      mode: 'local-bundle',
      storyId: state.storyId,
      generationId: state.generationId,
      inputRoot: state.roots.inputRoot,
      outputRoot: output.sha256,
      intentRoot: state.roots.intentRoot,
      workflowRoot: state.roots.workflowRoot,
      policyRoot: state.roots.policyRoot,
      classificationRoot: state.roots.classificationRoot,
      disclosurePlanRoot: state.roots.disclosurePlanRoot,
      verificationPlanRoot: state.roots.verificationPlanRoot
    });
    const claims = await localRecord(paths, 'local-claims', {
      candidateDigest: candidate.sha256,
      claims: [{
        id: 'LOC-OUTPUT-001',
        statement: 'The exported output membership, bytes, and logical modes equal the frozen candidate.',
        requiredCheckIds: ['exact-output-tree']
      }]
    });
    const next = {
      ...state,
      revision: state.revision + 1,
      status: 'frozen',
      updatedAt: new Date().toISOString(),
      records: {
        ...state.records,
        outputs: output.path,
        candidate: candidate.path,
        claims: claims.path
      },
      roots: {
        ...state.roots,
        outputRoot: output.sha256,
        candidateDigest: candidate.sha256,
        claimsRoot: claims.sha256
      },
      candidate: {
        candidateDigest: candidate.sha256,
        outputRoot: output.sha256,
        frozenAt: new Date().toISOString()
      },
      verification: null,
      review: null
    };
    const written = await writeLocalState(paths, next,
      '[local-mode] freeze ' + state.storyId);
    return Object.freeze({
      storyId: state.storyId,
      status: written.state.status,
      candidateDigest: candidate.sha256,
      outputRoot: output.sha256,
      files: captured.length,
      ledgerCommit: written.commit,
      nextAction: 'singularity-flow local verify --story ' + state.storyId
        + ' --candidate ' + candidate.sha256
    });
  });
}

async function manifestMatches(paths, manifestPath) {
  const manifest = JSON.parse(await readFile(path.join(paths.ledger, manifestPath), 'utf8'));
  for (const file of manifest.files) {
    const absolute = path.join(paths.ledger, file.object);
    if (!await objectMatches(absolute, file.sha256, file.sizeBytes)) return false;
  }
  return true;
}

export async function verifyLocalCandidate(storyId, candidateDigest, options = {}) {
  return lockedStory(storyId, options, async (paths, state) => {
    if (!state.candidate || state.roots.candidateDigest !== candidateDigest) {
      locFail('Verification selector does not equal the current frozen candidate.',
        'CANDIDATE_MISMATCH');
    }
    const passed = await manifestMatches(paths, state.records.outputs)
      && await manifestMatches(paths, state.records.inputs);
    if (!passed) {
      locFail('Frozen candidate or input objects no longer match their manifest.',
        'CANDIDATE_MISMATCH');
    }
    const receipt = await localRecord(paths, 'local-evidence-receipt', {
      checkId: 'exact-output-tree',
      candidateDigest,
      verificationPlanDigest: state.roots.verificationPlanRoot,
      claimIds: ['LOC-OUTPUT-001'],
      runner: {
        id: 'singularity-flow/local-mode',
        assurance: 'deterministic-local-integrity'
      },
      result: 'passed',
      executedAt: new Date().toISOString()
    });
    const evidence = await localRecord(paths, 'local-evidence-index', {
      candidateDigest,
      verificationPlanDigest: state.roots.verificationPlanRoot,
      requiredChecks: ['exact-output-tree'],
      attempts: [{ checkId: 'exact-output-tree', receiptSha256: receipt.sha256 }],
      eligibility: 'passed'
    });
    const next = {
      ...state,
      revision: state.revision + 1,
      status: 'verified',
      updatedAt: new Date().toISOString(),
      records: {
        ...state.records,
        evidenceReceipt: receipt.path,
        evidence: evidence.path
      },
      roots: { ...state.roots, evidenceRoot: evidence.sha256 },
      verification: { status: 'passed', evidenceRoot: evidence.sha256 },
      review: null
    };
    const written = await writeLocalState(paths, next,
      '[local-mode] verify ' + state.storyId);
    return Object.freeze({
      storyId: state.storyId,
      status: written.state.status,
      candidateDigest,
      evidenceRoot: evidence.sha256,
      ledgerCommit: written.commit,
      nextAction: 'singularity-flow local signer-create --story ' + state.storyId
        + ' --signer local-owner'
    });
  });
}

export { lockedStory };
