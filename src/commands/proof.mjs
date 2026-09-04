import { readFile } from 'node:fs/promises';

import { loadDefinition } from '../config.mjs';
import { observeShadowProof } from '../delivery-modes/proof-kernel.mjs';
import {
  bindReviewedJunit5Witnesses, observeProofInputs
} from '../delivery-modes/proof-observations.mjs';
import { resolveShadowPassportDiagnostic } from '../delivery-modes/shadow-passport-service.mjs';
import { branch, repoRoot } from '../git.mjs';
import { commandResult, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { recordSha256 } from '../records.mjs';
import { extractClauses } from '../specifications.mjs';
import { optionBoolean, optionString, secureRepositoryPath, SingularityFlowError } from '../util.mjs';

const ACTIONS = new Set(['status', 'explain', 'gaps', 'signals']);

function prefixed(value) {
  const text = String(value ?? '');
  return /^sha256:[a-f0-9]{64}$/.test(text) ? text
    : /^[a-f0-9]{64}$/.test(text) ? `sha256:${text}` : null;
}

async function readGovernedJson(root, relative) {
  if (!relative) return null;
  try {
    const secured = await secureRepositoryPath(root, relative, {
      label: 'GDP observation source', mustExist: true, type: 'file'
    });
    return JSON.parse(await readFile(secured.absolute, 'utf8'));
  } catch {
    return null;
  }
}

async function observedClauses(root, workflow) {
  const bound = new Set(Object.values(workflow.phases ?? {}).flatMap((phase) => (
    phase.deliveryEvidence?.acceptanceCriteria?.tagged
      ?? phase.deliveryEvidence?.acceptanceCriteria?.bound
      ?? []
  )));
  const clauses = [];
  for (const phase of Object.values(workflow.phases ?? {})) {
    if (!['approved', 'awaiting_approval', 'in_progress'].includes(phase.status)) continue;
    for (const artifact of phase.artifacts ?? []) {
      if (artifact.kind !== 'requirements' && !/specification|requirements/u.test(phase.id)) continue;
      try {
        const secured = await secureRepositoryPath(root, artifact.path, {
          label: 'GDP specification source', mustExist: true, type: 'file'
        });
        const parsed = extractClauses(await readFile(secured.absolute, 'utf8'), {
          sourcePath: artifact.path
        });
        clauses.push(...parsed.map((clause) => ({
          clauseId: clause.id,
          bodySha256: prefixed(clause.bodySha256),
          structural: true,
          witnessed: bound.has(clause.id)
        })));
      } catch {
        // An unreadable or malformed source cannot become a positive observation. The M4 aggregate
        // remains available and reports the resulting absence instead of blocking ordinary work.
      }
    }
  }
  return clauses;
}

function observedChecklist(workflow) {
  const latest = new Map();
  for (const phase of Object.values(workflow.phases ?? {})) {
    for (const approval of phase.approvals ?? []) {
      if (approval.invalidatedAt || approval.decision !== 'approved') continue;
      for (const entry of approval.checklist ?? []) latest.set(entry.article, {
        article: entry.article, decision: entry.decision
      });
    }
  }
  return [...latest.values()];
}

async function observedJunit(root, workflow) {
  for (const phaseId of [...(workflow.phaseOrder ?? [])].reverse()) {
    const delivery = workflow.phases?.[phaseId]?.deliveryEvidence;
    const receipt = await readGovernedJson(root, delivery?.receiptPath);
    for (const execution of receipt?.testExecutions ?? []) {
      const test = await readGovernedJson(root, execution.receiptPath);
      if (!test || test.adapter !== 'junit-xml') continue;
      const commandSha256 = prefixed(test.argvSha256)
        ?? `sha256:${recordSha256({ adapter: test.adapter, commandId: test.commandId })}`;
      const resultSha256 = prefixed(test.result?.sha256);
      const counts = test.tests ?? {};
      const observation = test.testcaseObservation ?? {};
      const sources = [];
      for (const relative of receipt.changeSet?.executableTestPaths ?? []) {
        try {
          const secured = await secureRepositoryPath(root, relative, {
            label: 'GDP JUnit source', mustExist: true, type: 'file'
          });
          sources.push({ path: relative, contents: await readFile(secured.absolute, 'utf8') });
        } catch {
          // Missing source is represented by the exact binder's incomplete-coverage gap.
        }
      }
      const exactBinding = bindReviewedJunit5Witnesses(sources, observation.occurrences ?? []);
      return {
        adapter: exactBinding.exact
          ? exactBinding.adapter
          : observation.profile ?? test.adapterIdentity?.id ?? 'junit5-surefire-v1',
        commandSha256, resultSha256,
        discovered: Number(counts.discovered ?? 0), failed: Number(counts.failed ?? 0),
        skipped: Number(counts.skipped ?? 0), exact: exactBinding.exact,
        retriesObserved: exactBinding.retriesObserved,
        teardownProven: exactBinding.teardownProven, oracleProven: exactBinding.oracleProven,
        gaps: exactBinding.exact ? [] : [
          ...(observation.bindingGaps ?? []).map((gap) => String(gap).toUpperCase().replaceAll('-', '_')),
          ...exactBinding.gaps
        ],
        outcomes: resultSha256 ? [{
          attempt: 1, resultSha256,
          outcome: test.status === 'passed' ? 'passed'
            : test.status === 'skipped' ? 'skipped'
              : test.status === 'failed' ? 'failed' : 'unavailable'
        }] : []
      };
    }
  }
  return null;
}

async function m4Observation(root, workflow, diagnostic) {
  if (!diagnostic.records?.proofSubject) return null;
  const junit = await observedJunit(root, workflow);
  return observeProofInputs({
    proofSubject: diagnostic.records.proofSubject,
    policySha256: diagnostic.policies.sourcePolicySha256,
    clauses: await observedClauses(root, workflow),
    checklistDecisions: observedChecklist(workflow),
    shouldSetItems: [],
    environment: junit ? {
      platform: process.platform, architecture: process.arch,
      runtime: `node-${process.versions.node.split('.')[0]}`,
      toolchainSha256: null, dependencyLockSha256: null,
      localePolicy: 'uncontrolled', clockPolicy: 'uncontrolled'
    } : null,
    junit
  });
}

function selectData(action, observation, predicateId) {
  if (action === 'status') return observation;
  const base = {
    schemaVersion: 1, // schema-transient: read-only command projection, never durable.
    kind: `gdp-proof-${action}-view`,
    mode: 'observe',
    authority: 'none',
    proofSubjectSha256: observation.proofSubject?.proofSubjectSha256 ?? null,
    proofSummarySha256: observation.summary?.summarySha256 ?? null,
    guarantees: observation.guarantees
  };
  if (action === 'gaps') return {
    ...base, gapRegister: observation.gapRegister, gaps: observation.gaps
  };
  if (action === 'signals') return {
    ...base, signals: observation.signals,
    message: observation.signals.length
      ? 'Signals are observations only.'
      : 'No signals were observed. Absence of a signal is not proof.',
    gateEligible: false
  };
  const index = observation.predicateSpecifications.findIndex(
    (specification) => specification.predicate.id === predicateId
  );
  if (index < 0) throw new SingularityFlowError(
    `Unknown observed predicate '${predicateId}'. Available: ${observation.predicateSpecifications
      .map((entry) => entry.predicate.id).join(', ') || 'none'}.`,
    { code: 'PFC_PREDICATE_INPUT_INVALID' }
  );
  const specification = observation.predicateSpecifications[index];
  const result = observation.results.find((entry) => (
    entry.predicate.id === specification.predicate.id
      && entry.predicate.version === specification.predicate.version
  )) ?? null;
  return {
    ...base,
    predicate: specification,
    result,
    explanation: result == null ? 'No deterministic result is available.'
      : result.verdict === 'pass' ? 'Every exact required input satisfied the registered deterministic algorithm.'
        : result.verdict === 'fail' ? 'The registered deterministic algorithm found a bound counterexample.'
          : result.verdict === 'not-applicable' ? 'The exact profile applicability contract excludes this predicate.'
            : 'Required exact evidence or capability is unavailable; this cannot be treated as pass.'
  };
}

export async function run(_argv, { positionals, options, operation: suppliedOperation = null } = {}) {
  const action = positionals?.[1] ?? 'status';
  if (!ACTIONS.has(action)) throw new SingularityFlowError(
    `Unknown proof action '${action}'. Use: proof status, proof explain, proof gaps, or proof signals.`,
    { code: 'UNKNOWN_SUBCOMMAND' }
  );
  if (optionBoolean(options, 'release')) throw new SingularityFlowError(
    'Release-scoped proof aggregation is not available in GDP-M3. Inspect one Work ID; nothing changed.',
    { code: 'PFC_SCHEMA_UNAVAILABLE' }
  );
  const root = repoRoot();
  const definition = await loadDefinition(root);
  const workId = positionals?.[2] ?? optionString(options, 'work-id') ?? branch(root);
  const predicateId = action === 'explain' ? positionals?.[3] : null;
  if (action === 'explain' && !predicateId) throw new SingularityFlowError(
    'Proof explanation requires an exact predicate ID: singularity-flow proof explain <WORK-ID> <PREDICATE-ID> --json',
    { code: 'PFC_PREDICATE_INPUT_INVALID' }
  );
  const { workflow, diagnostic } = await resolveShadowPassportDiagnostic(root, definition, workId, {
    proofProfile: optionString(options, 'proof-profile') ?? 'standard'
  });
  const observation = observeShadowProof(diagnostic);
  const observations = await m4Observation(root, workflow, diagnostic);
  const combined = observations ? { ...observation, observations } : observation;
  const data = selectData(action, combined, predicateId);
  return emitCommandResult(commandResult({
    operation: suppliedOperation ?? { id: `proof.${action}`, classification: 'read' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('proof.observation-reported', {
      workId: workflow.workItem.id,
      action,
      status: observation.status
    }),
    effects: noEffects(),
    restState: 'informational',
    data
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}
