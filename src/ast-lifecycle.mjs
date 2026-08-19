/** Lifecycle binding for configured structural predicates. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { evaluateAstGate } from './ast-intelligence.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { run, SingularityFlowError, writeJson } from './util.mjs';

function configuredPredicates(config) {
  return Array.isArray(config.ast?.predicates) ? config.ast.predicates : [];
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
  const predicates = configuredPredicates(config);
  if (!predicates.length) return { applies: false, errors: [], warnings: [], result: null, receipt: null };
  const result = await evaluateAstGate(root, options);
  const errors = gateErrors(result);
  const warnings = result.facts
    .filter((item) => item.mode === 'advisory' && item.outcome !== 'pass')
    .map((item) => `advisory structural predicate '${item.id}' is ${item.outcome}`);
  const receipt = {
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
    engine: {
      id: result.provenance.engine,
      version: result.provenance.engineVersion
    },
    extractors: structuredClone(result.provenance.extractors ?? []),
    predicates: structuredClone(result.facts),
    diagnostics: structuredClone(result.diagnostics),
    allowed: result.provenance?.gate?.allowed === true,
    evaluatedAt: new Date().toISOString()
  };
  receipt.integritySha256 = recordSha256(receipt);
  return { applies: true, errors, warnings, result, receipt };
}

export function assertAstLifecycleGate(evaluation, action) {
  evaluation.warnings.forEach((warning) => console.warn(`AST warning: ${warning}`));
  if (evaluation.errors.length) {
    throw new SingularityFlowError(
      `AST lifecycle gate blocks ${action}:\n- ${evaluation.errors.join('\n- ')}\n`
      + 'Run singularity-flow wm ast gate --json for bounded diagnostics.',
      { code: 'AST_LIFECYCLE_GATE_BLOCKED', details: { errors: evaluation.errors } }
    );
  }
}

/** Persist the already-passed evaluation with the generation it protects. */
export async function persistAstLifecycleReceipt(root, config, workflow, phase, evaluation) {
  if (!evaluation.applies || !evaluation.receipt) return null;
  if (evaluation.receipt.generation !== phase.generation) {
    throw new SingularityFlowError('AST lifecycle receipt generation does not match the published phase.', { code: 'AST_RECEIPT_GENERATION_MISMATCH' });
  }
  const relative = receiptRelative(config, workflow, phase.id, phase.generation);
  await writeJson(path.join(root, relative), evaluation.receipt);
  return {
    generation: phase.generation,
    path: relative,
    sha256: evaluation.receipt.integritySha256,
    policySha256: evaluation.receipt.policySha256,
    coneSha256: evaluation.receipt.coneSha256,
    status: evaluation.receipt.status,
    assurance: evaluation.receipt.assurance,
    engine: structuredClone(evaluation.receipt.engine),
    extractors: structuredClone(evaluation.receipt.extractors)
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
    return { summary, record, error: null };
  } catch (error) {
    return { summary, record: null, error: `AST lifecycle receipt cannot be read: ${error.message}` };
  }
}

/** Verify receipt bytes and re-evaluate the exact previously accepted scope. */
export async function verifyAstLifecycleReceipt(root, config, workflow, phase, {
  generation = phase.generation, revalidate = true, sourceCommit = null
} = {}) {
  if (!configuredPredicates(config).length) return { applies: false, errors: [], warnings: [], passes: [] };
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
  const options = record.scope.kind === 'all' ? { all: true }
    : record.scope.evaluatedPaths?.length ? { paths: record.scope.evaluatedPaths } : {};
  const current = await evaluateAstLifecycleGate(root, config, workflow, phase, { generation, options });
  const errors = [...current.errors];
  if (current.receipt?.policySha256 !== record.policySha256) errors.push('AST policy changed after publication');
  if (current.receipt?.coneSha256 !== record.coneSha256) errors.push('AST scope or relevant file bytes changed after publication');
  if (recordSha256(current.receipt?.engine ?? null) !== recordSha256(record.engine ?? null)) {
    errors.push('AST broker engine changed after publication');
  }
  if (recordSha256(current.receipt?.extractors ?? []) !== recordSha256(record.extractors ?? [])) {
    errors.push('AST extractor identity, version, or assurance changed after publication');
  }
  if (recordSha256(current.receipt?.predicates ?? []) !== recordSha256(record.predicates ?? [])) {
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
  if (verification.errors.length) {
    throw new SingularityFlowError(
      `Phase ${phase.id} AST lifecycle receipt is not valid:\n- ${verification.errors.join('\n- ')}\n`
      + `Republish generation ${options.generation ?? phase.generation} after running singularity-flow wm ast gate --json.`,
      { code: 'AST_LIFECYCLE_RECEIPT_INVALID', details: { errors: verification.errors } }
    );
  }
  return verification;
}
