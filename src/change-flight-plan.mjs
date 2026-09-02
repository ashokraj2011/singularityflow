/**
 * Change Flight Plans: deterministic preview, explicit acceptance, and lifecycle-bound deltas.
 *
 * Preview reads source from a single committed Git tree. The only preview persistence is a
 * machine-local, disposable cache below the repository's Git common directory; no branch,
 * work-item, commit, approval, or lifecycle record is created until start is explicitly confirmed.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { astQuery } from './ast-intelligence.mjs';
import { loadDefinition } from './config.mjs';
import {
  resolveWorldModelSource, validateWorldModelDirectory, worldModelFreshness, worldModelSourceSnapshot
} from './grounding.mjs';
import { worldModelStateAuthority } from './world-model/authority-config.mjs';
import { contextPacketTelemetryForWork } from './context-packet-telemetry.mjs';
import { gitCommonDir } from './git.mjs';
import { applicationPathContext, isApplicationPath } from './application-paths.mjs';
import { withApprovedConfigurationRead } from './approved-configuration-reader.mjs';
import {
  configurationReadAuthority, configurationReadRoot, isConfigurationReadPath
} from './configuration-read-scope.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { recordSha256 } from './records.mjs';
import {
  assertCredentialFreeRemote, configuredRemoteIdentity, frozenRemoteTransport,
  remoteFingerprint
} from './git-remote-diagnostics.mjs';
import { runRemoteGit } from './git-execution.mjs';
import {
  nowIso, posix, readJson, run, secureRepositoryPath, SingularityFlowError, writeAtomic, writeJson, writeText
} from './util.mjs';

const PLAN_ID = /^cfp-[a-f0-9]{20}$/;
const TEST_PATH = /(^|\/)(?:tests?|__tests__|spec)(?:\/|\.)|(?:\.test|\.spec)\.[^/]+$/i;
const BUILD_PATH = /(^|\/)(?:package\.json|pom\.xml|build\.gradle(?:\.kts)?|Cargo\.toml|go\.mod|Makefile|Dockerfile|[^/]+\.(?:csproj|sln)|\.github\/workflows\/[^/]+\.ya?ml)$/i;
const CONFIG_PATH = /(^|\/)(?:config|configs|\.github|deploy|deployment|infra|k8s)(?:\/|$)|\.(?:ya?ml|toml|ini|properties)$/i;
const MIGRATION_PATH = /(^|\/)(?:migrations?|schema)(?:\/|$)/i;
const STOP_WORDS = new Set([
  'about', 'after', 'before', 'change', 'from', 'into', 'make', 'replace', 'safely', 'should',
  'that', 'their', 'then', 'this', 'using', 'want', 'what', 'when', 'where', 'with', 'without'
]);
const DEFAULT_BUDGETS = Object.freeze({ maxFiles: 4_000, maxFindings: 120, maxOutputBytes: 2 * 1024 * 1024 });
const CONTEXT_BUDGET_BYTES = 32 * 1024;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function canonical(value) { return JSON.stringify(stable(value)); }
function sha256(value) { return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex'); }
export function changeFlightPlanSha256(value) { return sha256(value); }
function splitNull(value) { return String(value ?? '').split('\0').filter(Boolean); }

function gitTextAt(root, revision, relative) {
  const result = run('git', ['show', `${revision}:${relative}`], { cwd: root, allowFailure: true, maxBuffer: 8 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function gitJsonAt(root, revision, relative) {
  const text = gitTextAt(root, revision, relative);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function treeEntries(root, revision) {
  const output = run('git', ['ls-tree', '-r', '-z', revision], {
    cwd: root, maxBuffer: 16 * 1024 * 1024
  }).stdout;
  return splitNull(output).flatMap((entry) => {
    const tab = entry.indexOf('\t');
    if (tab < 0) return [];
    const [mode, type, object] = entry.slice(0, tab).split(' ');
    return [{ mode, type, object, path: posix(entry.slice(tab + 1)) }];
  });
}

function repositoryIdentity(root) {
  const remote = run('git', ['config', '--get', 'remote.origin.url'], { cwd: root, allowFailure: true }).stdout.trim();
  return remote || path.resolve(root);
}

function committedDigest(root, revision, relative) {
  const readRoot = configurationReadRoot(root);
  if (path.resolve(readRoot) !== path.resolve(root) && isConfigurationReadPath(relative)) {
    try { return sha256(readFileSync(path.join(readRoot, relative), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  const text = gitTextAt(root, revision, relative);
  return text == null ? null : sha256(text);
}

function approvedSpecificationSnapshot(root, revision, entries) {
  const workflows = entries.filter((entry) => /(^|\/)singularity\/work-items\/[^/]+\/workflow\.json$/.test(entry.path)).slice(0, 200);
  const indexes = entries.filter((entry) => entry.path.includes('/context/spec-indexes/') && entry.path.endsWith('.json'));
  const claims = entries.filter((entry) => entry.path.includes('/context/claims/') && entry.path.endsWith('.json'));
  const active = [];
  const activeKeys = new Set();
  for (const workflowEntry of workflows) {
    const workflow = gitJsonAt(root, revision, workflowEntry.path);
    if (!workflow?.workItem?.id) continue;
    for (const phase of Object.values(workflow.phases ?? {})) {
      if (phase?.status !== 'approved' || !Number.isInteger(phase.generation) || phase.generation < 1) continue;
      activeKeys.add(`${workflow.workItem.id}\0${phase.id}\0${phase.generation}`);
    }
  }
  const fullIndexes = [];
  for (const entry of indexes.slice(0, 500)) {
    const index = gitJsonAt(root, revision, entry.path);
    const key = `${index?.workId}\0${index?.phase}\0${index?.generation}`;
    if (!index || !activeKeys.has(key)) continue;
    fullIndexes.push({ path: entry.path, ...index });
    active.push({
      workId: index.workId, phase: index.phase, generation: index.generation,
      indexSha256: index.indexSha256 ?? sha256(index), source: index.source ?? null
    });
  }
  const plannedClaims = [];
  for (const entry of claims.slice(0, 500)) {
    const record = gitJsonAt(root, revision, entry.path);
    if (record?.kind !== 'planned') continue;
    const match = entry.path.match(/singularity\/work-items\/([^/]+)\//);
    const workId = record.workId ?? match?.[1];
    const phase = record.phase ?? entry.path.match(/\/([^/]+)-gen\d+[^/]*\.json$/)?.[1];
    const generation = Number(record.generation ?? entry.path.match(/gen(\d+)/)?.[1]);
    if (workId && phase && activeKeys.has(`${workId}\0${phase}\0${generation}`)) {
      plannedClaims.push({ path: entry.path, workId, phase, generation, record });
    }
  }
  active.sort((left, right) => `${left.workId}\0${left.phase}`.localeCompare(`${right.workId}\0${right.phase}`));
  return { generations: active, indexes: fullIndexes, claims: plannedClaims, digest: active.length ? sha256(active) : null };
}

async function resolvedFlightWorldModel(root, revision) {
  const definition = await loadDefinition(root);
  const outputDir = definition.worldModel?.outputDir ?? 'singularity/world-model';
  const projectionManifestPath = `${outputDir}/manifest.json`;
  const projectedText = gitTextAt(root, revision, projectionManifestPath);
  const dirty = run('git', ['status', '--porcelain'], { cwd: root, allowFailure: true }).stdout.trim().length > 0;
  if (dirty) {
    return {
      valid: false,
      manifest: null,
      directory: null,
      outputDir,
      manifestDigest: projectedText == null ? null : sha256(projectedText),
      source: 'application-projection',
      snapshotRef: revision,
      reason: projectedText == null
        ? 'The committed application projection contains no world model. Governed state was not selected against dirty working-tree bytes.'
        : 'The committed application projection contains a world-model manifest, but full exact-source validation was not performed against dirty working-tree bytes.'
    };
  }
  try {
    const state = worldModelStateAuthority(definition);
    const source = await worldModelSourceSnapshot(root, definition);
    const located = await resolveWorldModelSource(root, {
      ...(definition.worldModel ?? {}),
      outputDir,
      stateBranch: state.branch,
      remote: state.remote,
      ledger: definition.ledger,
      definition
    }, { sourceTreeSha256: source.sha256 });
    const validated = await validateWorldModelDirectory(located.directory, {
      integrity: 'full',
      sourceLabel: located.source === 'state-branch'
        ? `governed state-branch world model '${located.branch}'`
        : 'application-projection world model'
    });
    const freshness = await worldModelFreshness(root, definition, validated.manifest);
    if (!freshness.fresh || freshness.built !== source.sha256) {
      throw new SingularityFlowError(`Preserved model describes ${freshness.built ?? 'an unknown source'}, not ${source.sha256}.`);
    }
    const finalRevision = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).stdout.trim();
    const finalDirty = run('git', ['status', '--porcelain'], { cwd: root, allowFailure: true }).stdout.trim().length > 0;
    const finalSource = await worldModelSourceSnapshot(root, definition);
    if (finalRevision !== revision || finalDirty || finalSource.sha256 !== source.sha256) {
      throw new SingularityFlowError('Repository source changed while the exact world-model baseline was being resolved.');
    }
    const manifestText = await readFile(path.join(located.directory, 'manifest.json'), 'utf8');
    return {
      valid: true,
      manifest: validated.manifest,
      directory: located.directory,
      outputDir,
      manifestDigest: sha256(manifestText),
      source: located.source,
      authority: located.authority ?? null,
      historical: located.historical === true,
      snapshotRef: located.snapshotRef ?? located.commit ?? revision,
      treeSha: located.treeSha ?? (run('git', ['rev-parse', `${revision}:${outputDir}`], {
        cwd: root, allowFailure: true
      }).stdout.trim() || null),
      sourceTreeSha256: source.sha256,
      reason: null
    };
  } catch (error) {
    return {
      valid: false,
      manifest: null,
      directory: null,
      outputDir,
      manifestDigest: projectedText == null ? null : sha256(projectedText),
      source: projectedText == null ? null : 'application-projection',
      snapshotRef: revision,
      treeSha: null,
      reason: `No exact-source validated model was selected from governed state or the application projection: ${error.message}`
    };
  }
}

async function baselineAt(root) {
  const revision = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).stdout.trim();
  const branch = run('git', ['branch', '--show-current'], { cwd: root, allowFailure: true }).stdout.trim() || null;
  const entries = treeEntries(root, revision);
  const specifications = approvedSpecificationSnapshot(root, revision, entries);
  const worldModel = await resolvedFlightWorldModel(root, revision);
  const finalRevision = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).stdout.trim();
  if (finalRevision !== revision) {
    throw new SingularityFlowError('Repository HEAD changed while the Change Flight Plan baseline was being prepared; retry the preview.');
  }
  return {
    baseline: {
      repository: repositoryIdentity(root), revision, branch,
      configurationDigest: committedDigest(root, revision, 'singularity/workflow.yml'),
      worldModelDigest: worldModel.manifestDigest,
      worldModelSource: worldModel.source,
      worldModelSnapshotRef: worldModel.snapshotRef,
      worldModelTreeSha: worldModel.treeSha,
      worldModelSourceTreeSha256: worldModel.sourceTreeSha256 ?? null,
      worldModelOutputDir: worldModel.outputDir,
      specificationGenerations: specifications.generations,
      specificationDigest: specifications.digest
    },
    entries,
    specifications,
    worldModel
  };
}

function impactKind(relative) {
  if (TEST_PATH.test(relative)) return 'test-file';
  if (MIGRATION_PATH.test(relative)) return 'database-migration';
  if (BUILD_PATH.test(relative)) return 'build-configuration';
  if (CONFIG_PATH.test(relative)) return 'configuration';
  return 'code-file';
}

function defaultDisposition(classification) { return classification === 'unknown' ? 'investigate' : 'included'; }

function makeFinding({ classification, kind, subject, relationship, source, explanation, disposition = null }) {
  const body = { classification, kind, subject, relationship, source, explanation };
  return {
    findingId: `impact-${sha256(body).slice(0, 20)}`,
    ...body,
    disposition: disposition ?? defaultDisposition(classification)
  };
}

function dedupeFindings(findings) {
  return [...new Map(findings.map((finding) => [finding.findingId, finding])).values()];
}

function intentTokens(text) {
  return [...new Set(String(text ?? '').toLowerCase().match(/[a-z_][a-z0-9_.-]{3,}/g) ?? [])]
    .filter((token) => !STOP_WORDS.has(token)).sort((a, b) => b.length - a.length || a.localeCompare(b)).slice(0, 6);
}

function normalizeTarget({ target = null, file = null, symbol = null, issue = null, build = null, intent = '' } = {}) {
  const explicit = [
    target,
    file ? { kind: 'file', reference: file } : null,
    symbol ? { kind: 'symbol', reference: symbol } : null,
    issue ? { kind: 'issue', reference: issue } : null,
    build ? { kind: 'build', reference: build } : null
  ].filter(Boolean);
  if (explicit.length > 1) throw new SingularityFlowError('Choose one Change Flight Plan target: --file, --symbol, --issue, or --build.', { code: 'CFP_TARGET_NOT_FOUND' });
  if (explicit.length) return { kind: String(explicit[0].kind), reference: String(explicit[0].reference).trim() };
  if (!String(intent).trim()) throw new SingularityFlowError('Describe the change or select a --file, --symbol, --issue, or --build target.', { code: 'CFP_TARGET_NOT_FOUND' });
  return { kind: 'intent', reference: sha256(String(intent).trim()).slice(0, 16) };
}

async function validateFileTarget(root, target, entries) {
  if (target.kind !== 'file') return;
  const selected = await secureRepositoryPath(root, target.reference, {
    label: 'Change Flight Plan target', mustExist: true, type: 'file'
  });
  target.reference = selected.relative;
  const entry = entries.find((candidate) => candidate.path === selected.relative);
  if (!entry || entry.type !== 'blob') {
    throw new SingularityFlowError(`Change Flight Plan target is not tracked at HEAD: ${selected.relative}`, {
      code: 'CFP_TARGET_NOT_FOUND', details: { nextAction: 'Select a Git-tracked file or commit it before preview.' }
    });
  }
  if (entry.mode === '120000') {
    throw new SingularityFlowError(`Change Flight Plan target cannot be a symbolic link: ${selected.relative}`, {
      code: 'CFP_TARGET_NOT_FOUND', details: { nextAction: 'Select the tracked file the link refers to.' }
    });
  }
}

function grepAt(root, revision, needles, maxOutputBytes) {
  const findings = [];
  for (const needle of [...new Set(needles.filter(Boolean))]) {
    const result = run('git', ['grep', '-n', '-I', '-F', '--no-color', '-e', needle, revision, '--'], {
      cwd: root, allowFailure: true, maxBuffer: maxOutputBytes
    });
    if (![0, 1].includes(result.status)) continue;
    for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
      const match = line.match(/^[^:]+:(.+?):(\d+):(.*)$/);
      if (!match) continue;
      findings.push({ path: posix(match[1]), line: Number(match[2]), needle });
    }
  }
  return findings;
}

function ownershipFindings(root, revision, affectedPaths) {
  const candidates = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];
  const codeownersPath = candidates.find((relative) => gitTextAt(root, revision, relative) != null);
  if (!codeownersPath) return [];
  const lines = gitTextAt(root, revision, codeownersPath).split(/\r?\n/);
  const findings = [];
  for (const affected of affectedPaths) {
    let matched = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line || line.startsWith('#')) continue;
      const [pattern, ...owners] = line.split(/\s+/);
      const normalized = pattern.replace(/^\//, '').replace(/\*\*?$/, '').replace(/\/$/, '');
      if (owners.length && (affected === normalized || affected.startsWith(`${normalized}/`))) {
        matched = { owners, line: index + 1 };
      }
    }
    if (matched) findings.push(makeFinding({
      classification: 'proven', kind: 'ownership-policy', subject: matched.owners.join(' '),
      relationship: 'owns-path',
      source: { type: 'codeowners', reference: `${codeownersPath}:${matched.line}`, revision },
      explanation: `${codeownersPath} assigns review ownership for ${affected}.`
    }));
  }
  return findings;
}

function specificationFindings(specifications, affectedPaths, revision) {
  const findings = [];
  const indexes = new Map(specifications.indexes.map((index) => [
    `${index.workId}\0${index.phase}\0${index.generation}`, index
  ]));
  for (const claimRecord of specifications.claims) {
    const index = indexes.get(`${claimRecord.workId}\0${claimRecord.phase}\0${claimRecord.generation}`);
    if (!index) continue;
    const clauses = new Map((index.clauses ?? []).map((clause) => [clause.id, clause]));
    for (const [clauseId, claim] of Object.entries(claimRecord.record.claims ?? {})) {
      const claimedPaths = [...(claim.expectedPaths ?? []), ...(claim.tests ?? [])];
      const hits = claimedPaths.filter((candidate) => affectedPaths.includes(candidate));
      if (!hits.length || !clauses.has(clauseId)) continue;
      findings.push(makeFinding({
        classification: 'proven', kind: 'requirement-clause', subject: clauseId,
        relationship: 'claims-affected-path',
        source: {
          type: 'specification-claim', reference: claimRecord.path, revision,
          generation: { workId: claimRecord.workId, phase: claimRecord.phase, generation: claimRecord.generation },
          indexSha256: index.indexSha256
        },
        explanation: `Approved generation ${claimRecord.generation} deterministically claims ${hits.join(', ')} for ${clauseId}.`
      }));
    }
  }
  return findings;
}

async function worldModelFindings(root, revision, model, affectedPaths) {
  const manifest = model?.manifest;
  if (!manifest?.path_index?.path) return [];
  const relative = posix(path.join(model.outputDir, manifest.path_index.path));
  const outputPrefix = `${posix(model.outputDir).replace(/\/$/, '')}/`;
  if (relative.includes('../') || !relative.startsWith(outputPrefix)) return [];
  let index = null;
  let digest = null;
  if (model.directory) {
    try {
      const text = await readFile(path.join(model.directory, manifest.path_index.path), 'utf8');
      index = JSON.parse(text);
      digest = sha256(text);
    } catch { return []; }
  } else {
    index = gitJsonAt(root, revision, relative);
    digest = committedDigest(root, revision, relative);
  }
  const indexed = new Set([...(index?.representativePaths ?? []), ...(index?.paths ?? []), ...(index?.entries ?? []).flatMap((entry) => typeof entry === 'string' ? [entry] : [entry?.path].filter(Boolean))]);
  return affectedPaths.filter((candidate) => indexed.has(candidate)).map((candidate) => makeFinding({
    classification: 'proven', kind: 'architecture-context', subject: candidate,
    relationship: 'indexed-by-world-model',
    source: { type: 'world-model-index', reference: relative, revision: model.snapshotRef ?? revision, sha256: digest },
    explanation: `The pinned world-model path index contains ${candidate}.`
  }));
}

async function structuralFindings(root, target, paths, budgets) {
  if (!['file', 'symbol'].includes(target.kind)) {
    return { findings: [], unavailable: 'A precise file or symbol target is required for bounded AST analysis.' };
  }
  try {
    const predicate = target.kind === 'file' ? 'path' : 'symbol';
    const envelope = await astQuery(root, {
      predicate, value: target.reference,
      ...(paths.length ? { paths: paths.slice(0, 60) } : {}),
      'evidence-class': 'recorded-context',
      'max-files': Math.min(budgets.maxFiles, 120),
      'max-bytes': Math.min(budgets.maxOutputBytes * 2, 8 * 1024 * 1024),
      'max-facts': Math.min(budgets.maxFindings, 120)
    });
    const derivationKey = envelope?.provenance?.evidence;
    if (!derivationKey) return { findings: [], unavailable: 'AST returned preview facts without a complete reproducible derivation key.' };
    const findings = (envelope.facts ?? []).filter((fact) => ['symbol', 'import', 'relationship'].includes(fact.kind)).map((fact) => {
      const subject = fact.qualifiedName ?? fact.name ?? fact.target ?? fact.path ?? fact.id;
      return makeFinding({
        classification: 'proven', kind: fact.kind === 'symbol' ? 'code-symbol' : fact.kind === 'import' ? 'import' : 'code-relationship',
        subject, relationship: fact.type ?? (fact.kind === 'import' ? 'imports' : 'matches-structural-target'),
        source: {
          type: 'ast', reference: fact.path ?? fact.id ?? target.reference,
          revision: envelope.provenance?.repositoryRevision ?? null,
          derivationKey: structuredClone(derivationKey)
        },
        explanation: `Reproducible AST evidence relates ${subject} to the selected ${target.kind}.`
      });
    });
    return { findings, unavailable: envelope.status === 'partial' ? 'AST analysis exhausted its bound and returned partial evidence.' : null, envelopeStatus: envelope.status };
  } catch (error) {
    return { findings: [], unavailable: error.message, code: error.code ?? 'CFP_AST_UNAVAILABLE' };
  }
}

function verificationCandidates(findings) {
  const candidates = [];
  for (const finding of findings) {
    if (finding.kind === 'test-file') candidates.push({
      id: `verify-${sha256(['test', finding.subject]).slice(0, 16)}`, kind: 'existing-test',
      subject: finding.subject, reason: finding.findingId, status: 'candidate', evidence: null
    });
    if (finding.kind === 'requirement-clause') candidates.push({
      id: `verify-${sha256(['clause', finding.subject]).slice(0, 16)}`, kind: 'requirement-verification',
      subject: finding.subject, reason: finding.findingId, status: 'candidate', evidence: null
    });
    if (['build-configuration', 'database-migration'].includes(finding.kind)) candidates.push({
      id: `verify-${sha256([finding.kind, finding.subject]).slice(0, 16)}`, kind: 'policy-check',
      subject: finding.subject, reason: finding.findingId, status: 'candidate', evidence: null
    });
  }
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
}

function predictedPathFindings(value, revision) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 200) {
    throw new SingularityFlowError('Change Flight Plan predictedPaths must be an array of at most 200 paths.', {
      code: 'CFP_TARGET_NOT_FOUND'
    });
  }
  return [...new Set(value.map((candidate) => {
    if (typeof candidate !== 'string') throw new SingularityFlowError('Change Flight Plan predictedPaths must contain strings.', {
      code: 'CFP_TARGET_NOT_FOUND'
    });
    const portable = candidate.trim().replaceAll('\\', '/').replace(/\/$/, '');
    const normalized = path.posix.normalize(portable);
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')
      || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(candidate)
      || /[*?{}[\]\0]/.test(candidate)) {
      throw new SingularityFlowError(`Predicted path '${candidate}' is not a bounded repository-relative path.`, {
        code: 'CFP_TARGET_NOT_FOUND'
      });
    }
    return normalized;
  }))].map((subject) => makeFinding({
    classification: 'inferred', kind: impactKind(subject), subject,
    relationship: 'ratifiable-predicted-scope',
    source: { type: 'planning-proposal', reference: subject, revision },
    explanation: `${subject} was proposed as expected change scope and must be explicitly confirmed with the Plan before execution.`
  }));
}

function localRoot(root) { return path.join(gitCommonDir(root), 'singularity-flow', 'change-flight-plans'); }
function planFile(root, planId) { return path.join(localRoot(root), 'plans', `${planId}.json`); }
function startFile(root, planId) { return path.join(localRoot(root), 'starts', `${planId}.json`); }

function cfpStagingBranch(planId, workId) {
  return `sflow-cfp-${sha256([planId, workId]).slice(0, 16)}`;
}

function localRefHead(root, ref) {
  const result = run('git', ['rev-parse', '--verify', ref], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function autoRecoveryError(message, details = {}) {
  return new SingularityFlowError(message, { code: 'CFP_RECOVERY_REQUIRED', details });
}

function exactAutoStartIdentity(root, id, cfpPlan, options) {
  const auto = options.auto;
  const plan = auto?.plan;
  const repository = plan?.repositories?.[0];
  const workId = String(options.workId ?? '').trim();
  const mismatches = [
    [!auto, 'missing-auto-authority'],
    [auto?.executionOrigin?.mode !== 'auto', 'execution-origin-mode'],
    [auto?.flightId !== auto?.executionOrigin?.flightId, 'flight-id'],
    [plan?.planId !== auto?.executionOrigin?.planId, 'plan-id'],
    [plan?.planSha256 !== auto?.executionOrigin?.planSha256, 'plan-sha256'],
    [plan?.bindings?.flightPlanId !== id, 'flight-plan-id'],
    [plan?.bindings?.flightPlanSha256 !== `sha256:${recordSha256(cfpPlan)}`,
      'flight-plan-sha256'],
    [plan?.story?.workId !== workId || plan?.story?.branch !== workId, 'story-id'],
    [repository?.baseCommit !== cfpPlan.baseline.revision, 'baseline'],
    [auto?.ratification?.planId !== plan?.planId, 'ratification-plan-id'],
    [auto?.ratification?.planSha256 !== plan?.planSha256, 'ratification-plan-sha256']
  ].filter(([failed]) => failed).map(([, label]) => label);
  if (mismatches.length) {
    throw autoRecoveryError(
      'Auto start recovery identity does not match the accepted Change Flight Plan.',
      { mismatches }
    );
  }
  const expectedWorktree = path.join(
    gitCommonDir(root), 'singularity-flow', 'auto-worktrees', auto.flightId, repository.id
  );
  if (path.resolve(String(options.worktree ?? '')) !== path.resolve(expectedWorktree)) {
    throw autoRecoveryError('Auto start recovery worktree is outside its exact managed flight path.');
  }
  return Object.freeze({ auto, plan, repository, workId, expectedWorktree });
}

function autoRemoteAuthority(root, repository) {
  const remoteName = repository.remote ?? 'origin';
  const configured = configuredRemoteIdentity(root, remoteName, { direction: 'fetch' });
  const expected = assertCredentialFreeRemote(repository.remoteUrl ?? configured.url);
  if (!configured.url || configured.ambiguous
      || configured.fingerprint !== (repository.remoteFingerprint ?? remoteFingerprint(expected))) {
    throw autoRecoveryError('Auto start recovery repository authority differs from the ratified Plan.', {
      repository: repository.id
    });
  }
  const transport = frozenRemoteTransport(expected);
  return Object.freeze({
    remoteName, transportRemote: transport.remote, url: transport.url, env: transport.env
  });
}

function remoteStoryHead(root, authority, workId) {
  const result = runRemoteGit([
    'ls-remote', '--heads', '--', authority.transportRemote, `refs/heads/${workId}`
  ], {
    cwd: root, operation: 'remote-probe', env: authority.env
  });
  if (result.status !== 0) {
    throw autoRecoveryError('Auto start recovery could not inspect the exact Story remote authority.', {
      classification: result.failure?.classification ?? 'unknown'
    });
  }
  return result.stdout.trim().split(/\s+/u)[0] || null;
}

async function validateRecoveredAutoStory(worktree, id, cfpPlan, identity) {
  const definition = await loadDefinition(worktree);
  const { loadStoryAggregate } = await import('./state-stores.mjs');
  const workflow = await loadStoryAggregate(worktree, definition, identity.workId);
  const actualBranch = run('git', ['branch', '--show-current'], {
    cwd: worktree, allowFailure: true
  }).stdout.trim();
  if (actualBranch !== identity.workId
      || workflow.workItem?.id !== identity.workId
      || workflow.workItem?.branch !== identity.workId
      || workflow.changeFlightPlan?.planId !== id
      || workflow.changeFlightPlan?.acceptedPlanSha256 !== sha256(cfpPlan)) {
    throw autoRecoveryError('Existing branch is not the exact Change Flight Plan Story being recovered.', {
      workId: identity.workId
    });
  }
  const { readVerifiedAcceptedAutoBinding } = await import('./auto/auto-origin.mjs');
  await readVerifiedAcceptedAutoBinding(worktree, definition, workflow, {
    flightId: identity.auto.flightId,
    planId: identity.plan.planId,
    planSha256: identity.plan.planSha256,
    story: { workId: identity.workId }
  });
  return { definition, workflow, commit: localRefHead(worktree, 'HEAD') };
}

async function removeExactPreparedAutoWorktree(root, id, cfpPlan, identity) {
  const stagingBranch = cfpStagingBranch(id, identity.workId);
  const actualBranch = run('git', ['branch', '--show-current'], {
    cwd: identity.expectedWorktree, allowFailure: true
  }).stdout.trim();
  const actualHead = localRefHead(identity.expectedWorktree, 'HEAD');
  const dirty = run('git', ['status', '--porcelain=v2', '-z'], {
    cwd: identity.expectedWorktree, allowFailure: true
  });
  if (actualBranch !== stagingBranch || actualHead !== cfpPlan.baseline.revision
      || dirty.status !== 0 || dirty.stdout.length) {
    throw autoRecoveryError('Prepared Auto worktree changed before recovery and was preserved for review.', {
      expectedBranch: stagingBranch, actualBranch, expectedHead: cfpPlan.baseline.revision,
      actualHead
    });
  }
  const removed = run('git', [
    'worktree', 'remove', '--force', '--', identity.expectedWorktree
  ], { cwd: root, allowFailure: true });
  if (removed.status !== 0) {
    throw autoRecoveryError('Exact prepared Auto worktree could not be removed for idempotent replay.');
  }
  const deleted = run('git', [
    'update-ref', '-d', `refs/heads/${stagingBranch}`, cfpPlan.baseline.revision
  ], { cwd: root, allowFailure: true });
  if (deleted.status !== 0) {
    throw autoRecoveryError('Exact prepared Auto staging ref changed during recovery.');
  }
}

/**
 * Recover only effects owned by one already-claimed Auto start.
 *
 * The claimed flight, deterministic worktree, governed execution origin, accepted Auto Plan, and
 * accepted Change Flight Plan must all agree. A coincidentally named branch is never adopted.
 */
async function recoverExactAutoStart(root, id, cfpPlan, options, existing = null) {
  const identity = exactAutoStartIdentity(root, id, cfpPlan, options);
  let worktreePresent = Boolean(await lstat(identity.expectedWorktree).catch((error) => (
    error?.code === 'ENOENT' ? null : Promise.reject(error)
  )));
  if (worktreePresent) {
    const { recoverStoryStart } = await import('./story-start-journal.mjs');
    await recoverStoryStart(identity.expectedWorktree, identity.workId);
    const currentBranch = run('git', ['branch', '--show-current'], {
      cwd: identity.expectedWorktree, allowFailure: true
    }).stdout.trim();
    if (currentBranch === cfpStagingBranch(id, identity.workId)) {
      await removeExactPreparedAutoWorktree(root, id, cfpPlan, identity);
      return null;
    }
  }

  const localStoryCommit = localRefHead(root, `refs/heads/${identity.workId}`);
  const stagingBranch = cfpStagingBranch(id, identity.workId);
  const stagingCommit = localRefHead(root, `refs/heads/${stagingBranch}`);
  if (!worktreePresent && !localStoryCommit && stagingCommit) {
    if (stagingCommit !== cfpPlan.baseline.revision) {
      throw autoRecoveryError('Detached Auto staging ref changed and was preserved for review.', {
        stagingBranch
      });
    }
    const deleted = run('git', [
      'update-ref', '-d', `refs/heads/${stagingBranch}`, cfpPlan.baseline.revision
    ], { cwd: root, allowFailure: true });
    if (deleted.status !== 0) {
      throw autoRecoveryError('Detached exact Auto staging ref could not be retired.');
    }
    return null;
  }
  const definition = await loadDefinition(root);
  const publishRequired = (definition.git?.publish ?? 'required') !== 'off';
  const authority = autoRemoteAuthority(root, identity.repository);
  const publishedCommit = publishRequired || !localStoryCommit
    ? remoteStoryHead(root, authority, identity.workId)
    : null;

  if (!worktreePresent && !localStoryCommit && !publishedCommit) {
    if (existing) {
      throw autoRecoveryError('The recorded Auto Story has no reachable local or remote branch.');
    }
    return null;
  }
  if (publishedCommit && localStoryCommit && publishedCommit !== localStoryCommit) {
    throw autoRecoveryError('Local and remote Auto Story refs differ; neither was changed.', {
      workId: identity.workId
    });
  }
  if (publishRequired && !publishedCommit) {
    throw autoRecoveryError('The exact Auto Story was not retained by its required remote authority.');
  }
  if (!localStoryCommit && publishedCommit) {
    const remoteRef = `refs/remotes/${authority.remoteName}/${identity.workId}`;
    const fetched = runRemoteGit([
      'fetch', '--no-tags', '--quiet', authority.transportRemote,
      `refs/heads/${identity.workId}:${remoteRef}`
    ], { cwd: root, operation: 'remote-configuration', env: authority.env });
    if (fetched.status !== 0 || localRefHead(root, remoteRef) !== publishedCommit) {
      throw autoRecoveryError('The exact remote Auto Story could not be fetched for recovery.');
    }
    const created = run('git', [
      'update-ref', `refs/heads/${identity.workId}`, publishedCommit, '0'.repeat(publishedCommit.length)
    ], { cwd: root, allowFailure: true });
    if (created.status !== 0) {
      throw autoRecoveryError('The exact local Auto Story ref could not be reconstructed.');
    }
  }
  if (!worktreePresent) {
    await mkdir(path.dirname(identity.expectedWorktree), { recursive: true });
    const added = run('git', [
      'worktree', 'add', '--', identity.expectedWorktree, identity.workId
    ], { cwd: root, allowFailure: true });
    if (added.status !== 0) {
      throw autoRecoveryError('The exact Auto Story worktree could not be reconstructed.', {
        diagnostic: String(added.stderr || added.stdout).slice(0, 2048).trim()
      });
    }
    worktreePresent = true;
  }

  let verified;
  try {
    verified = await validateRecoveredAutoStory(
      identity.expectedWorktree, id, cfpPlan, identity
    );
  } catch (error) {
    if (error?.code === 'CFP_RECOVERY_REQUIRED') throw error;
    throw autoRecoveryError(
      `Existing Story branch failed its exact Auto recovery binding: ${error.message}`,
      { workId: identity.workId }
    );
  }
  if (publishedCommit && verified.commit !== publishedCommit) {
    throw autoRecoveryError('Recovered worktree does not name the exact published Auto Story commit.');
  }
  const stagingHead = localRefHead(root, `refs/heads/${stagingBranch}`);
  if (stagingHead) {
    if (stagingHead !== cfpPlan.baseline.revision) {
      throw autoRecoveryError('Auto staging ref changed after Story publication and was preserved.', {
        stagingBranch
      });
    }
    const deleted = run('git', [
      'update-ref', '-d', `refs/heads/${stagingBranch}`, cfpPlan.baseline.revision
    ], { cwd: root, allowFailure: true });
    if (deleted.status !== 0) {
      throw autoRecoveryError('Exact Auto staging ref could not be retired after recovery.');
    }
  }
  const record = {
    schemaVersion: currentSchemaVersion('change-flight-plan-start'),
    planId: id, workId: identity.workId, worktree: identity.expectedWorktree,
    branch: identity.workId, baselineRevision: cfpPlan.baseline.revision,
    acceptedPlanSha256: sha256(cfpPlan),
    publication: {
      sha: verified.commit, commit: verified.commit,
      pushed: Boolean(publishedCommit), remote: authority.remoteName,
      branch: identity.workId, ref: `refs/heads/${identity.workId}`
    },
    startedAt: nowIso()
  };
  await writeAtomic(startFile(root, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return {
    ...record, idempotent: true, recovered: true,
    workflow: verified.workflow, definition: verified.definition
  };
}

function validatePlanId(planId) {
  if (!PLAN_ID.test(String(planId ?? ''))) throw new SingularityFlowError(`Invalid Change Flight Plan ID '${planId ?? ''}'.`, { code: 'CFP_TARGET_NOT_FOUND' });
  return String(planId);
}

async function persistLocalPlan(root, plan) {
  const bytes = `${JSON.stringify(plan, null, 2)}\n`;
  await writeAtomic(planFile(root, plan.planId), bytes, { mode: 0o600 });
}

export async function readChangeFlightPlan(root, planId) {
  const id = validatePlanId(planId);
  try {
    return readRecord('change-flight-plan', await readJson(planFile(root, id))).record;
  } catch (error) {
    throw new SingularityFlowError(`Change Flight Plan '${id}' is not available in this repository's local preview cache.`, {
      code: 'CFP_TARGET_NOT_FOUND', details: { nextAction: 'Run sflow impact preview again.' }, cause: error
    });
  }
}

async function previewChangeFlightPlanInScope(root, input = {}) {
  const started = performance.now();
  const budgets = { ...DEFAULT_BUDGETS, ...(input.budgets ?? {}) };
  for (const [name, value] of Object.entries(budgets)) {
    if (!Number.isInteger(value) || value < 1) throw new SingularityFlowError(`Change Flight Plan ${name} must be a positive integer.`);
  }
  const intentText = String(input.intent ?? '').trim();
  const target = normalizeTarget({ ...input, intent: intentText });
  const { baseline, entries, specifications, worldModel } = await baselineAt(root);
  await validateFileTarget(root, target, entries);
  const tracked = entries.filter((entry) => entry.type === 'blob' && entry.mode !== '120000');
  const selected = tracked.slice(0, budgets.maxFiles);
  const truncatedFiles = tracked.length > selected.length;
  const needles = target.kind === 'file'
    ? [target.reference, path.posix.basename(target.reference), path.posix.basename(target.reference).replace(/\.[^.]+$/, '')]
    : target.kind === 'symbol'
    ? [target.reference, target.reference.split(/[.#:]/).at(-1)]
    : intentTokens(intentText);
  const textMatches = grepAt(root, baseline.revision, needles, budgets.maxOutputBytes)
    .filter((match) => selected.some((entry) => entry.path === match.path));
  let findings = [];
  if (target.kind === 'file') findings.push(makeFinding({
    classification: 'proven', kind: impactKind(target.reference), subject: target.reference,
    relationship: 'selected-target',
    source: { type: 'git-tree', reference: target.reference, revision: baseline.revision, object: entries.find((entry) => entry.path === target.reference)?.object },
    explanation: `${target.reference} is the selected tracked file at the pinned revision.`
  }));
  if (target.kind === 'file') {
    const stem = path.posix.basename(target.reference).replace(/\.[^.]+$/, '').toLowerCase();
    findings.push(...selected.filter((entry) => TEST_PATH.test(entry.path)
      && path.posix.basename(entry.path).toLowerCase().includes(stem)
      && entry.path !== target.reference).slice(0, 20).map((entry) => makeFinding({
      classification: 'inferred', kind: 'test-file', subject: entry.path,
      relationship: 'test-name-correlates-with-target',
      source: { type: 'path-heuristic', reference: entry.path, revision: baseline.revision },
      explanation: `${entry.path} shares the selected file's name by repository test convention; confirm the behavioral binding.`
    })));
  }
  findings.push(...textMatches.map((match) => makeFinding({
    classification: 'proven', kind: impactKind(match.path), subject: match.path,
    relationship: 'text-reference',
    source: { type: 'git-grep', reference: `${match.path}:${match.line}`, revision: baseline.revision, needleSha256: sha256(match.needle) },
    explanation: `${match.path}:${match.line} contains an exact reference to the selected target or intent term.`
  })));
  findings = dedupeFindings(findings).slice(0, budgets.maxFindings);
  const affectedPaths = [...new Set(findings.filter((finding) => /-file$|configuration|migration/.test(finding.kind)).map((finding) => finding.subject))].sort();
  findings.push(...ownershipFindings(root, baseline.revision, affectedPaths));
  findings.push(...specificationFindings(specifications, affectedPaths, baseline.revision));
  findings.push(...await worldModelFindings(root, baseline.revision, worldModel, affectedPaths));

  const categories = {
    pathsAndText: { status: truncatedFiles ? 'partial' : 'evaluated' },
    ownership: { status: committedDigest(root, baseline.revision, '.github/CODEOWNERS') || committedDigest(root, baseline.revision, 'CODEOWNERS') ? 'evaluated' : 'not-evaluated', reason: 'No committed CODEOWNERS file was available.' },
    specifications: { status: specifications.generations.length ? 'evaluated' : 'not-evaluated', reason: 'No approved specification generation with deterministic claims was available.' },
    worldModel: worldModel.valid
      ? {
          status: 'evaluated', source: worldModel.source,
          snapshotRef: worldModel.snapshotRef, outputDir: worldModel.outputDir
        }
      : {
          status: 'not-evaluated', source: worldModel.source,
          snapshotRef: worldModel.snapshotRef, outputDir: worldModel.outputDir,
          reason: worldModel.reason
        },
    ast: { status: input.ast === false ? 'not-evaluated' : 'pending', reason: input.ast === false ? 'AST analysis was disabled for this preview.' : null },
    runtimeEvidence: { status: 'not-evaluated', reason: 'No build, test-run, or production evidence provider was selected.' }
  };
  if (input.ast !== false) {
    const structural = await structuralFindings(root, target, affectedPaths, budgets);
    findings.push(...structural.findings);
    categories.ast = structural.unavailable
      ? { status: structural.envelopeStatus === 'partial' ? 'partial' : 'not-evaluated', reason: structural.unavailable }
      : { status: 'evaluated' };
  }
  findings.push(...predictedPathFindings(input.predictedPaths, baseline.revision));
  findings = dedupeFindings(findings).slice(0, budgets.maxFindings);

  const unknowns = Object.entries(categories).filter(([, value]) => value.status === 'not-evaluated').map(([category, value]) => makeFinding({
    classification: 'unknown', kind: 'evidence-category', subject: category,
    relationship: 'not-evaluated',
    source: { type: 'availability', reference: category, revision: baseline.revision },
    explanation: value.reason
  }));
  if (['issue', 'build'].includes(target.kind)) unknowns.push(makeFinding({
    classification: 'unknown', kind: 'external-source', subject: target.reference,
    relationship: 'not-imported',
    source: { type: target.kind, reference: target.reference, revision: null },
    explanation: `No authenticated ${target.kind} provider imported a revision-bound snapshot for this preview.`
  }));
  const partial = truncatedFiles || findings.length >= budgets.maxFindings || Object.values(categories).some((category) => category.status === 'partial');
  const completedCategories = Object.entries(categories).filter(([, value]) => value.status === 'evaluated').map(([name]) => name);
  const pendingCategories = Object.entries(categories).filter(([, value]) => value.status !== 'evaluated').map(([name]) => name);
  const planCore = {
    schemaVersion: currentSchemaVersion('change-flight-plan'),
    status: partial ? 'partial' : 'preview',
    intent: { text: intentText || `Change ${target.reference}`, digest: sha256(intentText || `Change ${target.reference}`), source: input.source ?? 'cli' },
    target,
    baseline,
    findings,
    unknowns: dedupeFindings(unknowns),
    recommendedStart: {
      subject: target.kind === 'file' ? target.reference : findings.find((finding) => finding.kind === 'code-symbol')?.subject
        ?? affectedPaths.find((candidate) => !TEST_PATH.test(candidate)) ?? affectedPaths[0] ?? target.reference,
      workType: input.workType ?? null,
      reason: 'Closest reproducible code or file evidence to the selected target.'
    },
    verificationCandidates: verificationCandidates(findings),
    completedCategories,
    pendingCategories,
    resumeHandle: partial ? `resume-${sha256({ baseline, target, findings: findings.map((finding) => finding.findingId) }).slice(0, 20)}` : null,
    provenance: {
      engine: { id: 'sflow-change-flight-plan', version: 1, modelInvoked: false },
      bounds: budgets,
      categories
    }
  };
  const planId = `cfp-${sha256(planCore).slice(0, 20)}`;
  const plan = {
    ...planCore, planId, generatedAt: nowIso(),
    provenance: { ...planCore.provenance, durationMs: Math.round(performance.now() - started) }
  };
  if (input.persist !== false) await persistLocalPlan(root, plan);
  return plan;
}

export async function previewChangeFlightPlan(root, input = {}) {
  if (configurationReadAuthority(root)) return previewChangeFlightPlanInScope(root, input);
  return withApprovedConfigurationRead(root, () => previewChangeFlightPlanInScope(root, input), {
    preferAuthority: true
  });
}

export async function explainChangeFlightPlanFinding(root, planId, findingId = null) {
  const plan = await readChangeFlightPlan(root, planId);
  if (!findingId) return {
    planId: plan.planId, baseline: plan.baseline, categories: plan.provenance.categories,
    findings: plan.findings.map((finding) => ({ findingId: finding.findingId, classification: finding.classification, subject: finding.subject, relationship: finding.relationship }))
  };
  const finding = [...plan.findings, ...plan.unknowns].find((candidate) => candidate.findingId === findingId);
  if (!finding) throw new SingularityFlowError(`Change Flight Plan '${planId}' has no finding '${findingId}'.`, { code: 'CFP_TARGET_NOT_FOUND' });
  return { planId: plan.planId, finding, baseline: plan.baseline, reproducible: finding.source.type !== 'ast' || Boolean(finding.source.derivationKey) };
}

export async function refreshChangeFlightPlan(root, planId, options = {}) {
  const prior = await readChangeFlightPlan(root, planId);
  const refreshed = await previewChangeFlightPlan(root, {
    intent: prior.intent.text, target: prior.target, source: prior.intent.source,
    ast: options.ast ?? prior.provenance?.categories?.ast?.status !== 'not-evaluated',
    budgets: options.budgets ?? prior.provenance?.bounds,
    persist: options.persist !== false
  });
  return { priorPlanId: prior.planId, changed: refreshed.planId !== prior.planId, plan: refreshed };
}

const FINDING_DISPOSITIONS = new Set([
  'included', 'excluded', 'investigate', 'create-follow-up', 'challenge-requirement', 'ask-owner'
]);

export async function recordChangeFlightPlanDisposition(root, planId, findingId, { disposition, reason = null } = {}) {
  const prior = await readChangeFlightPlan(root, planId);
  if (!FINDING_DISPOSITIONS.has(disposition)) {
    throw new SingularityFlowError(`Flight Plan disposition must be ${[...FINDING_DISPOSITIONS].join(', ')}.`);
  }
  const findings = [...prior.findings, ...prior.unknowns];
  const finding = findings.find((candidate) => candidate.findingId === findingId);
  if (!finding) throw new SingularityFlowError(`Change Flight Plan '${planId}' has no finding '${findingId}'.`, { code: 'CFP_TARGET_NOT_FOUND' });
  if (disposition === 'excluded' && !String(reason ?? '').trim()) {
    throw new SingularityFlowError('Excluding impact evidence requires --reason TEXT. The evidence itself will remain in the plan.');
  }
  const amend = (candidate) => candidate.findingId === findingId
    ? { ...candidate, disposition, dispositionReason: String(reason ?? '').trim() || null }
    : candidate;
  const planCore = {
    ...prior,
    findings: prior.findings.map(amend),
    unknowns: prior.unknowns.map(amend),
    supersedes: prior.planId
  };
  delete planCore.planId;
  delete planCore.generatedAt;
  planCore.provenance = { ...planCore.provenance };
  delete planCore.provenance.durationMs;
  const next = {
    ...planCore,
    planId: `cfp-${sha256(planCore).slice(0, 20)}`,
    generatedAt: nowIso(),
    provenance: { ...planCore.provenance, durationMs: 0 }
  };
  await persistLocalPlan(root, next);
  return next;
}

function baselineDifference(expected, actual) {
  const fields = [
    'repository', 'revision', 'configurationDigest', 'worldModelDigest', 'worldModelSource',
    'worldModelSnapshotRef', 'worldModelTreeSha', 'worldModelOutputDir',
    'worldModelSourceTreeSha256', 'specificationDigest'
  ];
  return fields.filter((field) => expected[field] !== actual[field]);
}

async function startRecord(root, planId) {
  try { return readRecord('change-flight-plan-start', await readJson(startFile(root, planId))).record; }
  catch { return null; }
}

async function relatedStarts(root, plan) {
  const directory = path.join(localRoot(root), 'starts');
  const entries = await readdir(directory).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  const related = [];
  for (const entry of entries.filter((name) => /^cfp-[a-f0-9]{20}\.json$/.test(name))) {
    const record = await readJson(path.join(directory, entry)).catch(() => null);
    if (!record || record.planId === plan.planId) continue;
    const candidate = await readJson(planFile(root, record.planId)).catch(() => null);
    if (candidate?.intent?.digest === plan.intent.digest) related.push(record);
  }
  return related;
}

async function safeNewWorktreePath(root, candidate) {
  const absolute = path.resolve(candidate);
  if (absolute === path.parse(absolute).root || absolute === path.resolve(root)) {
    throw new SingularityFlowError(`Unsafe worktree target: ${absolute}`, { code: 'CFP_WORKSPACE_CREATION_FAILED' });
  }
  if (await lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
    throw new SingularityFlowError(`Worktree target already exists: ${absolute}`, {
      code: 'CFP_WORKSPACE_CREATION_FAILED', details: { nextAction: 'Choose a new --worktree path.' }
    });
  }
  let ancestor = path.dirname(absolute);
  while (!(await lstat(ancestor).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error)))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const info = await lstat(ancestor);
  if (info.isSymbolicLink()) throw new SingularityFlowError(`Worktree parent cannot be a symbolic link: ${ancestor}`, { code: 'CFP_WORKSPACE_CREATION_FAILED' });
  await realpath(ancestor);
  await mkdir(path.dirname(absolute), { recursive: true });
  return absolute;
}

function contextPackage(plan, workId) {
  const relevant = plan.findings.filter((finding) => finding.disposition === 'included').map((finding) => ({
    findingId: finding.findingId, classification: finding.classification, kind: finding.kind,
    subject: finding.subject, relationship: finding.relationship,
    reference: finding.source?.reference ?? null
  }));
  const record = {
    schemaVersion: currentSchemaVersion('change-flight-plan-context'),
    workId, planId: plan.planId, intent: plan.intent,
    baseline: plan.baseline, recommendedStart: plan.recommendedStart,
    findings: relevant, unknowns: plan.unknowns.map((finding) => ({ findingId: finding.findingId, subject: finding.subject, explanation: finding.explanation })),
    verificationCandidates: plan.verificationCandidates,
    retrieval: { acceptedPlan: 'accepted-plan.json', sourceBodiesIncluded: false }
  };
  const bytes = Buffer.byteLength(JSON.stringify(record));
  if (bytes > CONTEXT_BUDGET_BYTES) {
    record.findings = record.findings.slice(0, Math.max(1, Math.floor(record.findings.length * CONTEXT_BUDGET_BYTES / bytes)));
    record.retrieval.truncated = true;
  }
  record.byteLength = Buffer.byteLength(JSON.stringify(record));
  return record;
}

export async function pinAcceptedChangeFlightPlan(root, definition, workflow, plan) {
  const directory = path.join(root, definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', 'change-flight-plan');
  const acceptedPath = path.join(directory, 'accepted-plan.json');
  const context = contextPackage(plan, workflow.workItem.id);
  const verification = {
    schemaVersion: currentSchemaVersion('change-flight-plan-verification'),
    workId: workflow.workItem.id, planId: plan.planId,
    generatedFrom: plan.findings.map((finding) => finding.findingId),
    candidates: plan.verificationCandidates,
    disclaimer: 'Candidates are not verification evidence until a governed result is recorded.'
  };
  await writeJson(acceptedPath, plan);
  await writeJson(path.join(directory, 'context-package.json'), context);
  await writeJson(path.join(directory, 'verification-candidates.json'), verification);
  await writeText(path.join(directory, 'README.md'), `# Change Flight Plan\n\n- Plan: ${plan.planId}\n- Baseline: ${plan.baseline.revision}\n- Recommended start: ${plan.recommendedStart.subject}\n- Context bytes: ${context.byteLength}/${CONTEXT_BUDGET_BYTES}\n`);
  workflow.changeFlightPlan = {
    planId: plan.planId, acceptedPlanSha256: sha256(plan), baseline: structuredClone(plan.baseline),
    acceptedPath: posix(path.relative(root, acceptedPath)),
    contextPath: posix(path.relative(root, path.join(directory, 'context-package.json'))),
    verificationPath: posix(path.relative(root, path.join(directory, 'verification-candidates.json'))),
    status: 'accepted'
  };
  return workflow.changeFlightPlan;
}

async function startChangeFlightPlanInScope(root, planId, options = {}) {
  const id = validatePlanId(planId);
  if (options.confirm !== id) throw new SingularityFlowError(`Starting governed work requires --confirm ${id}.`, { code: 'CFP_START_TRANSACTION_INCOMPLETE' });
  const existing = await startRecord(root, id);
  if (existing && !options.auto) {
    const worktreeExists = await lstat(existing.worktree).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!worktreeExists) throw new SingularityFlowError(`Change Flight Plan '${id}' started as '${existing.workId}', but its worktree is missing.`, {
      code: 'CFP_RECOVERY_REQUIRED', details: { existing, nextAction: `Run git worktree repair, then resume ${existing.workId}.` }
    });
    return { ...existing, idempotent: true };
  }
  const plan = await readChangeFlightPlan(root, id);
  if (options.auto && (existing || options.recoverClaim === true)) {
    const recovered = await recoverExactAutoStart(root, id, plan, options, existing);
    if (recovered) return recovered;
  }
  if (plan.status === 'partial' && options.acceptPartial !== true) throw new SingularityFlowError(`Change Flight Plan '${id}' is partial and cannot be accepted silently.`, {
    code: 'CFP_ANALYSIS_PARTIAL', details: { nextAction: `Refresh ${id} with a larger budget or pass --accept-partial after reviewing pending categories.` }
  });
  const current = (await baselineAt(root)).baseline;
  const changed = baselineDifference(plan.baseline, current);
  if (changed.length) throw new SingularityFlowError(`Change Flight Plan '${id}' is stale: ${changed.join(', ')} changed after preview.`, {
    code: 'CFP_PLAN_STALE', details: { changed, nextAction: `Run sflow impact refresh ${id}.` }
  });
  const definition = await loadDefinition(root);
  const workId = String(options.workId ?? '').trim();
  if (!workId) throw new SingularityFlowError('Starting a Change Flight Plan requires --work-id ID.', { code: 'CFP_START_TRANSACTION_INCOMPLETE' });
  const related = await relatedStarts(root, plan);
  if (related.length && options.independent !== true) {
    const match = related[0];
    throw new SingularityFlowError(`Related governed work '${match.workId}' already started from the same intent.`, {
      code: 'CFP_WORK_ALREADY_EXISTS',
      details: {
        existing: related.map((record) => ({ planId: record.planId, workId: record.workId, worktree: record.worktree })),
        nextActions: [
          `Continue existing work with sflow resume ${match.workId}.`,
          'Attach the reviewed plan from the existing work item.',
          `Start independent work by repeating this command with --independent.`,
          'Cancel without changing anything.'
        ]
      }
    });
  }
  const existingBranch = run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${workId}`], { cwd: root, allowFailure: true }).status === 0;
  if (existingBranch) throw new SingularityFlowError(`Branch '${workId}' already exists and is not bound to Change Flight Plan '${id}'.`, {
    code: 'CFP_WORK_ALREADY_EXISTS', details: { nextAction: `Choose another --work-id or resume ${workId}.` }
  });
  const workTypes = Object.keys(definition.workTypes ?? {});
  const workType = options.workType ?? plan.recommendedStart.workType ?? (workTypes.length === 1 ? workTypes[0] : null);
  if (!workType) throw new SingularityFlowError('Starting a Change Flight Plan requires an explicit workflow choice.', {
    code: 'CFP_START_TRANSACTION_INCOMPLETE',
    details: { workTypes, nextAction: `Repeat with --work-type ${workTypes[0] ?? 'TYPE'}.` }
  });
  if (!definition.workTypes?.[workType]) throw new SingularityFlowError(`Unknown work type '${workType}'.`, {
    code: 'CFP_START_TRANSACTION_INCOMPLETE', details: { workTypes }
  });
  const repositoryKey = sha256(plan.baseline.repository).slice(0, 12);
  const defaultWorktree = path.join(path.dirname(path.resolve(root)), '.singularity-flow', 'worktrees', repositoryKey, workId);
  const worktree = await safeNewWorktreePath(root, options.worktree ?? defaultWorktree);
  const stagingBranch = cfpStagingBranch(id, workId);
  if (run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${stagingBranch}`], { cwd: root, allowFailure: true }).status === 0) {
    throw new SingularityFlowError(`Recovery branch '${stagingBranch}' already exists from an incomplete start.`, {
      code: 'CFP_RECOVERY_REQUIRED', details: { nextAction: `Inspect and remove ${stagingBranch}, then retry the same plan.` }
    });
  }
  let created = false;
  try {
    const added = run('git', ['worktree', 'add', '-b', stagingBranch, '--', worktree, plan.baseline.revision], { cwd: root, allowFailure: true });
    if (added.status !== 0) throw new SingularityFlowError(`Git could not create the isolated worktree: ${(added.stderr || added.stdout).trim()}`, { code: 'CFP_WORKSPACE_CREATION_FAILED' });
    created = true;
    if (typeof options.afterWorktreeCreated === 'function') {
      await options.afterWorktreeCreated({ id, workId, worktree, stagingBranch });
    }
    const { manualStorySource, startStory } = await import('./story-start.mjs');
    const autoProposal = options.auto?.plan?.proposal ?? null;
    const source = {
      ...manualStorySource(workId, {
        title: (autoProposal?.title ?? plan.intent.text) || `Change ${plan.target.reference}`,
        description: `Accepted Change Flight Plan ${plan.planId}.`,
        desiredOutcome: plan.intent.text,
        constraints: [
          ...(autoProposal?.assumptions ?? []).map((entry) => `Assumption: ${entry}`),
          ...(autoProposal?.unresolvedDecisions ?? []).map((entry) => `Unresolved decision: ${entry}`),
          ...plan.unknowns.map((finding) => finding.explanation)
        ],
        acceptanceCriteria: autoProposal?.acceptanceCriteria?.length
          ? autoProposal.acceptanceCriteria
          : plan.verificationCandidates.map((candidate) => `Verify ${candidate.subject}`)
      }),
      planId: plan.planId
    };
    const started = await startStory(worktree, {
      id: workId, source, workType, agent: options.agent,
      baseBranch: options.baseBranch ?? plan.baseline.branch ?? definition.defaultBaseBranch,
      expectedBaseCommit: plan.baseline.revision,
      flightPlan: plan,
      auto: options.auto ?? null
    });
    if (typeof options.afterStoryStarted === 'function') {
      await options.afterStoryStarted({ id, workId, worktree, started });
    }
    run('git', ['branch', '-D', '--', stagingBranch], { cwd: root, allowFailure: true });
    const record = {
      schemaVersion: currentSchemaVersion('change-flight-plan-start'),
      planId: id, workId, worktree, branch: started.branch,
      baselineRevision: plan.baseline.revision,
      acceptedPlanSha256: sha256(plan),
      publication: started.publication ?? null,
      startedAt: nowIso()
    };
    if (typeof options.beforeStartReceipt === 'function') {
      await options.beforeStartReceipt({ id, workId, worktree, started, record });
    }
    await writeAtomic(startFile(root, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return { ...record, idempotent: false, workflow: started.workflow };
  } catch (error) {
    if (created) {
      run('git', ['worktree', 'remove', '--force', '--', worktree], { cwd: root, allowFailure: true });
      const published = run('git', ['show-ref', '--verify', '--quiet', `refs/remotes/${definition.git?.remote ?? 'origin'}/${workId}`], { cwd: root, allowFailure: true }).status === 0;
      if (!published) run('git', ['branch', '-D', '--', workId], { cwd: root, allowFailure: true });
      run('git', ['branch', '-D', '--', stagingBranch], { cwd: root, allowFailure: true });
    }
    if (error instanceof SingularityFlowError && error.code) throw error;
    throw new SingularityFlowError(`Change Flight Plan start did not complete: ${error.message}`, {
      code: 'CFP_START_TRANSACTION_INCOMPLETE', details: { nextAction: `Review the error, then retry sflow impact start ${id}.` }, cause: error
    });
  }
}

export async function startChangeFlightPlan(root, planId, options = {}) {
  if (configurationReadAuthority(root)) return startChangeFlightPlanInScope(root, planId, options);
  return withApprovedConfigurationRead(root, () => startChangeFlightPlanInScope(root, planId, options), {
    preferAuthority: true
  });
}

export function evaluateChangeFlightPlanBoundary(root, workflow, { phaseId = null } = {}) {
  const binding = workflow?.changeFlightPlan;
  if (!binding?.acceptedPath) return null;
  const plan = readRecord('change-flight-plan', gitJsonAt(root, 'HEAD', binding.acceptedPath)).record;
  if (sha256(plan) !== binding.acceptedPlanSha256) throw new SingularityFlowError('The accepted Change Flight Plan no longer matches its workflow binding.', { code: 'CFP_RECOVERY_REQUIRED' });
  const output = run('git', ['diff', '--name-only', '-z', plan.baseline.revision, 'HEAD', '--'], { cwd: root }).stdout;
  const pathContext = applicationPathContext(workflow);
  const changedPaths = splitNull(output).map(posix)
    .filter((candidate) => isApplicationPath(candidate, pathContext)).sort();
  const expectedPaths = [...new Set(plan.findings.filter((finding) => finding.disposition === 'included' && [
    'code-file', 'test-file', 'configuration', 'database-migration', 'build-configuration'
  ].includes(finding.kind)).map((finding) => finding.subject))].sort();
  const expansions = changedPaths.filter((relative) => !expectedPaths.some((expected) => (
    relative === expected || relative.startsWith(`${expected.replace(/\/$/, '')}/`)
  )));
  const priorDispositions = new Map((workflow.changeFlightPlan.expansionDispositions ?? []).map((entry) => [entry.path, entry]));
  const unresolved = expansions.filter((relative) => !priorDispositions.has(relative));
  const delta = {
    schemaVersion: currentSchemaVersion('change-flight-plan-delta'),
    planId: plan.planId, workId: workflow.workItem.id, phaseId,
    baselineRevision: plan.baseline.revision,
    observedRevision: run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim(),
    expectedPaths, actualPaths: changedPaths,
    expectedTouched: changedPaths.filter((relative) => expectedPaths.some((expected) => (
      relative === expected || relative.startsWith(`${expected.replace(/\/$/, '')}/`)
    ))),
    expansions: expansions.map((relative) => ({ path: relative, disposition: priorDispositions.get(relative) ?? null })),
    unresolved
  };
  if (unresolved.length) throw new SingularityFlowError(`Change Flight Plan scope expanded into unexamined paths:\n- ${unresolved.join('\n- ')}`, {
    code: 'CFP_ANALYSIS_PARTIAL', details: { unresolved, nextAction: 'Review the actual impact and record an expansion disposition before submission.' }
  });
  const receipt = {
    schemaVersion: currentSchemaVersion('change-flight-plan-receipt'),
    planId: plan.planId, workId: workflow.workItem.id, phaseId,
    lineage: {
      intentDigest: plan.intent.digest,
      predictedPlanSha256: binding.acceptedPlanSha256,
      acceptedScope: plan.findings.filter((finding) => finding.disposition === 'included').map((finding) => finding.findingId),
      actualDeltaSha256: sha256(delta),
      verificationCandidates: plan.verificationCandidates.map((candidate) => candidate.id),
      submissionRevision: delta.observedRevision
    },
    intent: plan.intent,
    acceptedImpact: plan.findings,
    actualImpact: delta,
    exclusions: plan.findings.filter((finding) => finding.disposition === 'excluded'),
    specificationGenerations: plan.baseline.specificationGenerations,
    codeRevisions: { baseline: plan.baseline.revision, submission: delta.observedRevision },
    verification: { candidates: plan.verificationCandidates, evidence: [] },
    unresolvedFollowUps: plan.unknowns,
    provenance: plan.provenance
  };
  return { plan, delta, receipt };
}

export function recordChangeFlightPlanExpansionDisposition(root, workflow, relativePath, { disposition, reason } = {}) {
  const allowed = new Set(['explained', 'accepted-expansion', 'deviation', 'follow-up', 'requirement-challenge']);
  if (!allowed.has(disposition)) throw new SingularityFlowError(`Scope expansion disposition must be ${[...allowed].join(', ')}.`);
  if (!String(reason ?? '').trim()) throw new SingularityFlowError('Scope expansion disposition requires a reason.');
  let unresolved = [];
  try {
    const current = evaluateChangeFlightPlanBoundary(root, workflow);
    unresolved = current?.delta?.unresolved ?? [];
  } catch (error) {
    if (error?.code !== 'CFP_ANALYSIS_PARTIAL' || !Array.isArray(error.details?.unresolved)) throw error;
    unresolved = error.details.unresolved;
  }
  const normalized = posix(String(relativePath ?? '').trim());
  if (!unresolved.includes(normalized)) {
    throw new SingularityFlowError(`'${normalized}' is not an unexamined Change Flight Plan expansion.`, { code: 'CFP_TARGET_NOT_FOUND' });
  }
  workflow.changeFlightPlan.expansionDispositions = [
    ...(workflow.changeFlightPlan.expansionDispositions ?? []).filter((entry) => entry.path !== normalized),
    { path: normalized, disposition, reason: String(reason).trim(), recordedAt: nowIso() }
  ].sort((left, right) => left.path.localeCompare(right.path));
  return workflow.changeFlightPlan.expansionDispositions.find((entry) => entry.path === normalized);
}

export async function persistChangeFlightPlanBoundary(root, definition, workflow, boundary) {
  if (!boundary) return null;
  const directory = path.join(root, definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', 'change-flight-plan');
  const verificationEvidence = Object.values(workflow.phases ?? {}).flatMap((phase) => (phase.checks ?? []).map((check) => ({
    phaseId: phase.id, generation: phase.generation, id: check.id, command: check.command,
    status: check.status, sourceCommit: check.sourceCommit ?? null, completedAt: check.completedAt ?? null
  })));
  const approvals = Object.values(workflow.phases ?? {}).flatMap((phase) => (phase.approvals ?? []).map((approval) => ({
    phaseId: phase.id, generation: approval.generation ?? phase.generation,
    decision: approval.decision, authorityGroup: approval.authorityGroup ?? null,
    at: approval.at ?? approval.approvedAt ?? null
  })));
  const contextUsage = await contextPacketTelemetryForWork(root, workflow.workItem.id);
  const receipt = {
    ...boundary.receipt,
    verification: { candidates: boundary.plan.verificationCandidates, evidence: verificationEvidence },
    deviations: workflow.changeFlightPlan.expansionDispositions ?? [],
    requirementChallenges: workflow.changeRequests ?? [],
    approvals,
    gates: Object.values(workflow.phases ?? {}).flatMap((phase) => (phase.astGates ?? []).map((gate) => ({ phaseId: phase.id, ...gate }))),
    contextUsage
  };
  await writeJson(path.join(directory, 'actual-delta.json'), boundary.delta);
  await writeJson(path.join(directory, 'receipt.json'), receipt);
  workflow.changeFlightPlan.actualDeltaSha256 = sha256(boundary.delta);
  workflow.changeFlightPlan.receiptSha256 = sha256(receipt);
  workflow.changeFlightPlan.status = 'tracked';
  return { delta: boundary.delta, receipt };
}
