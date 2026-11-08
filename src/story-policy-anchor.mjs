/** Canonical story policy anchor; legacy state exports delegate here. */
import { DEFAULT_APPROVAL_AUTHORITY } from "./kernel/approval-policy.mjs";
import { SingularityFlowError, gitHeadIsUnborn, gitReadOutput, run } from "./util.mjs";
import { canonicalJson } from "./records.mjs";
import { createHash } from "node:crypto";
import { normalizeSourceBoundary } from "./kernel/configuration-declarations.mjs";
import { readRecord } from "./schema-migrations.mjs";
import { workDirRelative } from "./story-paths.mjs";


export function resolvedPhasePolicy(definition, index) {
  return {
    id: definition.id,
    label: definition.label,
    order: index,
    ...(definition.kind === 'skill' ? {
      kind: 'skill', skillBinding: structuredClone(definition.skillBinding)
    } : {}),
    defaultAgent: definition.defaultAgent ?? null,
    requiredArtifact: structuredClone(definition.artifact),
    template: definition.template,
    worldModel: structuredClone(definition.worldModel ?? {}),
    writeScope: definition.writeScope ?? 'artifact-only',
    sourceBoundary: normalizeSourceBoundary(definition.sourceBoundary, definition.id),
    comparison: structuredClone(definition.comparison ?? {}),
    mcp: structuredClone(definition.mcp ?? { requiredServers: [], requireSmoke: false, evidence: [] }),
    repairBudget: structuredClone(definition.repairBudget ?? null),
    inputs: structuredClone(definition.inputs ?? []),
    generationPolicy: structuredClone(definition.generation ?? { requirement: 'required', producer: 'agent' }),
    approvalPolicy: structuredClone(definition.approval ?? {
      authorities: [DEFAULT_APPROVAL_AUTHORITY], minimum: 1, rejectTo: [definition.id]
    }),
    qualityCommands: [...(definition.qualityCommands ?? [])]
  };
}

export function currentPhasePolicy(phase) {
  return resolvedPhasePolicy({
    id: phase.id,
    label: phase.label,
    kind: phase.kind,
    skillBinding: phase.skillBinding,
    artifact: phase.requiredArtifact,
    template: phase.template,
    defaultAgent: phase.defaultAgent,
    worldModel: phase.worldModel,
    writeScope: phase.writeScope,
    sourceBoundary: phase.sourceBoundary,
    comparison: phase.comparison,
    mcp: phase.mcp,
    repairBudget: phase.repairBudget,
    inputs: phase.inputs,
    generation: phase.generationPolicy,
    approval: phase.approvalPolicy,
    qualityCommands: phase.qualityCommands
  }, phase.order);
}

export function resolutionPolicySha256(resolution) {
  const policy = structuredClone(resolution ?? {});
  delete policy.policySha256;
  return `sha256:${createHash('sha256').update(canonicalJson(policy)).digest('hex')}`;
}

export function storyHistoryCommits(root, args, label) {
  const output = gitReadOutput(run('git', args, { cwd: root, allowFailure: true }), label, {
    absentWhen: () => gitHeadIsUnborn(root)
  });
  return (output ?? '').trim().split(/\r?\n/u).filter(Boolean);
}

export function initialWorkflowRecord(root, config, workId) {
  const relative = workDirRelative(config, workId);
  const workflowRelative = `${relative}/workflow.json`;
  const history = storyHistoryCommits(root, [
    'log', '--format=%H', '--diff-filter=A', '--reverse', '--', workflowRelative
  ], `Story '${workId}' creation record`);
  if (!history.length) return null;
  const stored = run('git', ['show', `${history[0]}:${workflowRelative}`], {
    cwd: root, allowFailure: true
  });
  if (stored.status !== 0) {
    throw new SingularityFlowError(
      `The immutable creation policy for Story '${workId}' cannot be read from ${history[0]}.`,
      { code: 'STORY_POLICY_ANCHOR_UNREADABLE' }
    );
  }
  let initial;
  try { initial = JSON.parse(stored.stdout); }
  catch {
    throw new SingularityFlowError(
      `The immutable creation policy for Story '${workId}' is not valid JSON.`,
      { code: 'STORY_POLICY_ANCHOR_INVALID' }
    );
  }
  const anchor = initial?.resolution?.policySha256;
  return { record: initial, commit: history[0], workflowRelative, anchor };
}

export function verifiedInitialPolicyAnchor(initial, workId) {
  if (!initial) return null;
  const { anchor, commit, record } = initial;
  // Stories created before policy anchoring are deliberately compatible. Their schema migration
  // adds normalized resolution fields that did not exist in the creation bytes, so comparing the
  // migrated projection with a digest those bytes never declared would make every legacy Story
  // look manually weakened. Only an explicit, well-formed creation anchor opts into this gate.
  if (anchor == null) return null;
  if (typeof anchor !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(anchor)) {
    throw new SingularityFlowError(
      `The immutable creation policy anchor for Story '${workId}' is malformed.`,
      {
        code: 'STORY_POLICY_ANCHOR_INVALID',
        details: { workId, commit, actual: anchor }
      }
    );
  }
  // Recompute from the committed bytes. Trusting a digest field stored beside the policy would
  // accept a stale or hand-edited receipt without proving that it describes those exact bytes.
  const derived = resolutionPolicySha256(record.resolution);
  if (anchor !== derived) {
    throw new SingularityFlowError(
      `The immutable creation policy anchor for Story '${workId}' does not match its committed resolution bytes.`,
      {
        code: 'STORY_POLICY_ANCHOR_INVALID',
        details: { workId, commit, expected: derived, actual: anchor }
      }
    );
  }
  return anchor;
}

export function committedResolutionPolicySha256(root, config, workId) {
  return committedResolutionPolicy(root, config, workId)?.sha256 ?? null;
}

export function committedResolutionPolicy(root, config, workId) {
  const initial = initialWorkflowRecord(root, config, workId);
  const storedAnchor = verifiedInitialPolicyAnchor(initial, workId);
  if (!storedAnchor) return null;
  // The creation receipt authenticates the exact schema that was written at creation time.  A
  // deterministic reader migration may subsequently strengthen that policy (for example the v4
  // convergence producer restriction).  Comparing the migrated live aggregate with the *stored*
  // v3 digest would reject every honestly anchored in-flight Story after an upgrade.  First prove
  // the stored anchor above, then derive the policy identity from the registry-migrated creation
  // record so both sides of the immutable-policy comparison use the same current schema.
  const migratedCreation = readRecord('story-workflow', initial.record).record;
  return { sha256: resolutionPolicySha256(migratedCreation.resolution), commit: initial.commit };
}

export const PROSPECTIVE_SKILL_AMENDMENT = new WeakMap();
