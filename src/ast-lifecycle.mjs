/** Lifecycle binding for configured structural predicates. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { evaluateAstGate } from './ast-intelligence.mjs';
import {
  astDerivationProvenanceLine, createAstDerivation, persistAstDerivation, validateAstDerivationManifest
} from './ast-evidence.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { run, SingularityFlowError, writeJson } from './util.mjs';
import { astDisabledForWorkflow } from './intelligence-policy.mjs';

function configuredPredicates(config, workflow = null) {
  if (astDisabledForWorkflow(workflow)) return [];
  return Array.isArray(config.ast?.predicates) ? config.ast.predicates : [];
}

async function lifecyclePolicy(config, workflow) {
  const configured = configuredPredicates(config, workflow);
  const required = configured.filter((predicate) => predicate.mode === 'required');
  // AST is an optional accelerator. Predicates are available to the explicit `wm ast gate`
  // diagnostic, but they must never become publication, submission, readiness, or governance
  // prerequisites. Keep this policy boundary permanently inactive so an unavailable runtime,
  // language pack, adapter, or evidence store cannot strand governed work.
  return {
    active: false,
    reason: configured.length ? 'optional-diagnostic' : 'not-configured',
    required
  };
}

function receiptRelative(config, workflow, phaseId, generation) {
  return path.posix.join(
    config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id,
    'context', 'ast', `${phaseId}-gen${generation}.json`
  );
}

function withoutIntegrity(record) {
  const { integritySha256: _ignored, ...value } = record;
  return value;
}

function gateErrors(result) {
  const errors = [];
  if (result.status !== 'complete') errors.push(`structural analysis is ${result.status}, not complete`);
  for (const id of result.provenance?.gate?.blocking ?? []) errors.push(`required structural predicate '${id}' did not pass`);
  if (!result.provenance?.gate?.allowed && !errors.length) errors.push('the structural gate did not authorize this lifecycle transition');
  return errors;
}

/** Evaluate configured AST policy without writing lifecycle or repository state. */
export async function evaluateAstLifecycleGate(root, config, workflow, phase, { generation = phase.generation + 1, options = {} } = {}) {
  const policy = await lifecyclePolicy(config, workflow);
  if (!policy.active) {
    return { applies: false, reason: policy.reason, errors: [], warnings: [], result: null, receipt: null };
  }
  const result = await evaluateAstGate(root, { ...options, 'evidence-class': 'gate' });
  const errors = gateErrors(result);
  const warnings = result.facts
    .filter((item) => item.mode === 'advisory' && item.outcome !== 'pass')
    .map((item) => `advisory structural predicate '${item.id}' is ${item.outcome}`);
  const derivation = errors.length ? null : await createAstDerivation(root, config, workflow, phase, result, {
    generation, evidenceClass: 'gate', operation: 'gate'
  });
  const factSetSha256 = result.provenance?.evidence?.outputs?.factsSha256 ?? null;
  const receipt = derivation ? {
    schemaVersion: currentSchemaVersion('ast-gate-receipt'),
    workId: workflow.workItem.id,
    phase: phase.id,
    generation,
    policySha256: result.scope.definitionSha256,
    repositoryRevision: result.scope.repositoryRevision,
    coneSha256: result.scope.coneSha256 ?? result.scope.worktreeFingerprint,
    scope: {
      kind: result.scope.kind,
      paths: result.scope.paths ?? [],
      evaluatedPaths: result.provenance?.gate?.evaluatedPaths ?? []
    },
    assurance: result.assurance,
    status: result.status,
    derivation: structuredClone(derivation.reference),
    predicates: result.facts.map((predicate) => ({
      ...structuredClone(predicate), factSetSha256,
      derivationSha256: derivation.reference.sha256
    })),
    diagnostics: structuredClone(result.diagnostics),
    allowed: result.provenance?.gate?.allowed === true,
    evaluatedAt: new Date().toISOString()
  } : null;
  if (receipt) receipt.integritySha256 = recordSha256(receipt);
  return { applies: true, errors, warnings, result, receipt, derivation };
}

export function assertAstLifecycleGate(evaluation, action) {
  evaluation.warnings.forEach((warning) => console.warn(`AST warning: ${warning}`));
  evaluation.errors.forEach((error) => console.warn(
    `AST warning: optional structural diagnostics could not validate ${action}: ${error}`
  ));
}

/** Persist the already-passed evaluation with the generation it protects. */
export async function persistAstLifecycleReceipt(root, config, workflow, phase, evaluation) {
  if (!evaluation.applies || !evaluation.receipt) return null;
  if (evaluation.receipt.generation !== phase.generation) {
    throw new SingularityFlowError('AST lifecycle receipt generation does not match the published phase.', { code: 'AST_RECEIPT_GENERATION_MISMATCH' });
  }
  const relative = receiptRelative(config, workflow, phase.id, phase.generation);
  await persistAstDerivation(root, evaluation.derivation);
  await writeJson(path.join(root, relative), evaluation.receipt);
  return {
    generation: phase.generation,
    path: relative,
    sha256: evaluation.receipt.integritySha256,
    policySha256: evaluation.receipt.policySha256,
    coneSha256: evaluation.receipt.coneSha256,
    status: evaluation.receipt.status,
    assurance: evaluation.receipt.assurance,
    derivation: structuredClone(evaluation.receipt.derivation),
    provenanceLine: astDerivationProvenanceLine(evaluation.derivation.manifest)
  };
}

async function receiptFor(root, config, workflow, phase, generation, sourceCommit = null) {
  const summary = (phase.astGates ?? []).find((item) => item.generation === generation);
  if (!summary) return { summary: null, record: null, error: 'no AST lifecycle receipt is recorded' };
  const expectedPath = receiptRelative(config, workflow, phase.id, generation);
  if (summary.path !== expectedPath) {
    return { summary, record: null, error: `AST lifecycle receipt path must be ${expectedPath}` };
  }
  try {
    let bytes;
    if (sourceCommit) {
      const shown = run('git', ['show', `${sourceCommit}:${expectedPath}`], {
        cwd: root, allowFailure: true, maxBuffer: 2 * 1024 * 1024
      });
      if (shown.status !== 0) {
        return { summary, record: null, error: `AST lifecycle receipt was not committed at ${sourceCommit}` };
      }
      bytes = shown.stdout;
    } else bytes = await readFile(path.join(root, expectedPath));
    const stored = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
    const record = readRecord('ast-gate-receipt', stored).record;
    // Integrity binds the bytes that were actually published. Migration adds a current read shape
    // in memory; hashing that enriched projection would falsely call every authentic v1 receipt
    // corrupt merely because v2 added extractor provenance.
    const actual = recordSha256(withoutIntegrity(stored));
    if (actual !== stored.integritySha256 || actual !== summary.sha256) {
      return { summary, record, error: 'AST lifecycle receipt integrity does not match the workflow summary' };
    }
    let derivationManifest = null;
    if (record.derivation?.replayability !== 'legacy-unreplayable') {
      const derivationPath = record.derivation?.path;
      if (!derivationPath || record.derivation.sha256 == null) {
        return { summary, record, error: 'AST lifecycle receipt has an incomplete derivation reference' };
      }
      let manifestBytes;
      if (sourceCommit) {
        const shown = run('git', ['show', `${sourceCommit}:${derivationPath}`], {
          cwd: root, allowFailure: true, maxBuffer: 4 * 1024 * 1024
        });
        if (shown.status !== 0) return { summary, record, error: `AST derivation was not committed at ${sourceCommit}` };
        manifestBytes = shown.stdout;
      } else manifestBytes = await readFile(path.join(root, derivationPath));
      derivationManifest = validateAstDerivationManifest(JSON.parse(Buffer.isBuffer(manifestBytes) ? manifestBytes.toString('utf8') : String(manifestBytes)));
      if (derivationManifest.derivationSha256 !== record.derivation.sha256
          || derivationManifest.integritySha256 !== record.derivation.manifestIntegritySha256) {
        return { summary, record, error: 'AST derivation integrity does not match the gate receipt' };
      }
    }
    return { summary, record, derivationManifest, error: null };
  } catch (error) {
    return { summary, record: null, error: `AST lifecycle receipt cannot be read: ${error.message}` };
  }
}

/** Verify receipt bytes and re-evaluate the exact previously accepted scope. */
export async function verifyAstLifecycleReceipt(root, config, workflow, phase, {
  generation = phase.generation, revalidate = true, sourceCommit = null
} = {}) {
  const policy = await lifecyclePolicy(config, workflow);
  if (!policy.active) return { applies: false, reason: policy.reason, errors: [], warnings: [], passes: [] };
  const loaded = await receiptFor(root, config, workflow, phase, generation, sourceCommit);
  if (loaded.error) return { applies: true, errors: [loaded.error], warnings: [], passes: [] };
  const { record } = loaded;
  if (record.workId !== workflow.workItem.id || record.phase !== phase.id || record.generation !== generation) {
    return { applies: true, errors: ['AST lifecycle receipt subject does not match this phase generation'], warnings: [], passes: [] };
  }
  if (record.allowed !== true || record.status !== 'complete') {
    return { applies: true, errors: ['AST lifecycle receipt did not record a complete passing gate'], warnings: [], passes: [] };
  }
  // Historical governance validates the immutable receipt at its generation commit. Re-running an
  // older cone against today's worktree would make a legitimate later phase invalidate earlier
  // evidence. The current publish→submit boundary keeps the stronger live-byte revalidation below.
  if (!revalidate) {
    return {
      applies: true, errors: [], warnings: [],
      passes: [`AST lifecycle receipt integrity verified${sourceCommit ? ' at its generation commit' : ''}: ${phase.id} generation ${generation}`], record
    };
  }
  if (record.derivation?.replayability === 'legacy-unreplayable') {
    return {
      applies: true,
      errors: ['AST lifecycle receipt is authentic legacy evidence but cannot be replayed because exact inputs and toolchain artifacts were not recorded'],
      warnings: [], passes: [], record
    };
  }
  const options = record.scope.kind === 'all' ? { all: true }
    : record.scope.kind === 'paths' && record.scope.paths?.length ? { paths: record.scope.paths } : {};
  let current;
  try {
    current = await evaluateAstLifecycleGate(root, config, workflow, phase, { generation, options });
  } catch (error) {
    return {
      applies: true,
      errors: [`AST lifecycle evidence could not be re-evaluated: ${error.message}`],
      warnings: [], passes: [], record
    };
  }
  const errors = [...current.errors];
  if (current.receipt?.policySha256 !== record.policySha256) errors.push('AST policy changed after publication');
  if (current.receipt?.coneSha256 !== record.coneSha256) errors.push('AST scope or relevant file bytes changed after publication');
  const originalManifest = loaded.derivationManifest;
  const currentManifest = current.derivation?.manifest;
  if (recordSha256(currentManifest?.engine ?? null) !== recordSha256(originalManifest?.engine ?? null)
      || recordSha256(currentManifest?.adapters ?? []) !== recordSha256(originalManifest?.adapters ?? [])
      || recordSha256(currentManifest?.grammars ?? []) !== recordSha256(originalManifest?.grammars ?? [])
      || recordSha256(currentManifest?.runtime ?? null) !== recordSha256(originalManifest?.runtime ?? null)
      || recordSha256(currentManifest?.dependencies ?? null) !== recordSha256(originalManifest?.dependencies ?? null)) {
    errors.push('AST retained toolchain identity changed after publication');
  }
  if (recordSha256(currentManifest?.configuration ?? null) !== recordSha256(originalManifest?.configuration ?? null)
      || recordSha256(currentManifest?.replayRecipe ?? null) !== recordSha256(originalManifest?.replayRecipe ?? null)) {
    errors.push('AST policy, profile, predicates, or operation options changed after publication');
  }
  if (recordSha256(currentManifest?.inputs?.files ?? []) !== recordSha256(originalManifest?.inputs?.files ?? [])
      || currentManifest?.inputs?.coneSha256 !== originalManifest?.inputs?.coneSha256) {
    errors.push('AST exact input objects changed after publication');
  }
  const comparablePredicates = (items = []) => items.map(({ derivationSha256: _derivation, ...item }) => item);
  if (recordSha256(comparablePredicates(current.receipt?.predicates)) !== recordSha256(comparablePredicates(record.predicates))) {
    errors.push('AST predicate outcomes changed after publication');
  }
  return {
    applies: true,
    errors: [...new Set(errors)],
    warnings: current.warnings,
    passes: errors.length ? [] : [`AST lifecycle receipt verified: ${phase.id} generation ${generation}`],
    record
  };
}

export async function requireAstLifecycleReceipt(root, config, workflow, phase, options = {}) {
  const verification = await verifyAstLifecycleReceipt(root, config, workflow, phase, options);
  verification.warnings.forEach((warning) => console.warn(`AST warning: ${warning}`));
  verification.errors.forEach((error) => console.warn(
    `AST warning: optional structural receipt for phase ${phase.id} could not be verified: ${error}`
  ));
  return verification;
}
