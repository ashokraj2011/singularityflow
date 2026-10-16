/** Recognize current-generation preparation bytes, never publication or adoption authority. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { readPromptGeneration } from './inject.mjs';
import { clarificationRecordRelative, verifyClarificationRecord } from './clarifications.mjs';
import { resolveRepositoryManifest } from './repository-manifest.mjs';
import { readBoundSpecificationClaimMap } from './specifications.mjs';
import { readRecord } from './schema-migrations.mjs';
import { snapshot } from './util.mjs';
import { memberRoot, resolvedArtifactSet } from './artifact-sets.mjs';

const MAX_CONTEXT_BYTES = 32 * 1024 * 1024;

async function regularContextFile(root, relative) {
  const resolved = await resolveRepositoryManifest(root, relative);
  // No symlinks, including in parent directories, and no unbounded reads. Recovery must not
  // mistake another location's bytes for preparation performed in this Story checkout.
  return !resolved.links.length && resolved.info.size <= MAX_CONTEXT_BYTES;
}

/**
 * Exact evidence files allocated by an approved, committed planning claim map belong to the
 * open phase's draft. This is routing ownership only, not passing evidence or publication
 * authority. Never admit an evidence directory wholesale or trust prose in a dirty draft.
 */
export async function expectedPhaseEvidencePaths(root, config, workflow, phase, {
  itemRoot, generation, changedPaths
}) {
  if (generation !== nextPhaseGeneration(phase)) return [];
  const prefix = `${itemRoot}/evidence/`;
  const candidates = changedPaths.filter(relative => relative.startsWith(prefix));
  if (!candidates.length) return [];
  const ownerId = workflow.resolution?.plannedClaims?.owners?.[phase.id];
  const owner = workflow.phases?.[ownerId];
  const order = workflow.phaseOrder ?? [];
  if (!owner || owner.status !== 'approved' || !(owner.generation > 0)
      || order.indexOf(ownerId) < 0 || order.indexOf(phase.id) <= order.indexOf(ownerId)) return [];
  let plan;
  try {
    plan = await readBoundSpecificationClaimMap(root, path.join(root, itemRoot), workflow, owner, 'planned', {
      policy: workflow.resolution?.spec ?? config.spec ?? {}, requireCommitted: true
    });
  } catch { return []; }
  const declared = new Set(Object.values(plan.claims ?? {})
    .filter(claim => !(claim.steps ?? []).length || claim.steps.includes(phase.id))
    .flatMap(claim => claim.expectedPaths ?? []));
  const expected = [];
  for (const relative of candidates) {
    if (!declared.has(relative)) continue;
    try {
      if (await regularContextFile(root, relative)) expected.push(relative);
    } catch { /* Missing, linked, oversized or unsafe evidence stays manual. */ }
  }
  return expected;
}

/**
 * Composing for an agent that attaches skills also writes the skills audit,
 * `context/agents-<step>-gen<N>.json`, and any skill copies it lists under
 * `context/agent-snapshots/`. Publication commits them with the generation. They belong to this
 * composition only when the audit names this Story, step, generation and the prompt record's agent,
 * and every changed copy it lists still has its recorded hash; otherwise a person reviews them.
 */
async function agentContextPaths(root, workflow, phase, { itemRoot, generation, changedPaths, agent }) {
  const auditPath = `${itemRoot}/context/agents-${phase.id}-gen${generation}.json`;
  if (!changedPaths.includes(auditPath)) return [];
  try {
    if (!await regularContextFile(root, auditPath)) return [];
    const audit = readRecord('agent-context-audit', await readFile(path.join(root, auditPath))).record;
    if (audit?.workId !== workflow.workItem?.id || audit.phase !== phase.id
        || audit.generation !== generation || !agent || audit.agent !== agent) return [];
    const copies = [];
    for (const entry of audit.files ?? []) {
      const relative = String(entry?.path ?? '');
      if (!relative.startsWith(`${itemRoot}/context/agent-snapshots/`) || !changedPaths.includes(relative)) continue;
      if (relative.split('/').includes('..') || !await regularContextFile(root, relative)) return [];
      if ((await snapshot(path.join(root, relative))).sha256 !== String(entry.sha256)) return [];
      copies.push(relative);
    }
    return [auditPath, ...copies];
  } catch {
    // A malformed, linked or oversized audit stays manual.
    return [];
  }
}

/**
 * Inspect only the exact paths written by prompt composition and clarification recording.
 * The existing validators own identity and hash checks. Do not run another World Model scan,
 * fetch, compose, record, or commit just to classify a dirty worktree for recovery routing.
 */
export async function expectedPreparationContextPaths(root, config, workflow, phase, {
  itemRoot, generation, changedPaths
}) {
  const expected = [];
  if (generation !== nextPhaseGeneration(phase)) return expected;
  const recordPath = `${itemRoot}/context/${phase.id}-gen${generation}.json`;
  const promptPath = `${itemRoot}/context/prompts/${phase.id}-gen${generation}.md`;
  const clarificationPath = clarificationRecordRelative(config, workflow, phase, generation);
  if (![recordPath, promptPath, clarificationPath].some(relative => changedPaths.includes(relative))) {
    return expected;
  }

  let composed;
  try {
    if (!await regularContextFile(root, recordPath) || !await regularContextFile(root, promptPath)) return expected;
    composed = await readPromptGeneration(root, workflow, phase, {
      workDir: path.join(root, itemRoot)
    });
    const agents = workflow.resolution?.agents ?? config.agents ?? {};
    if (!composed?.record.agent || !Object.hasOwn(agents, composed.record.agent)) return expected;
    expected.push(recordPath, promptPath);
  } catch {
    // Missing, unsupported, malformed, interrupted, or hash-mismatched pairs remain manual.
    return expected;
  }
  expected.push(...await agentContextPaths(root, workflow, phase, {
    itemRoot, generation, changedPaths, agent: composed.record.agent
  }));

  if (changedPaths.includes(clarificationPath)) {
    try {
      if (!await regularContextFile(root, clarificationPath)) return expected;
      const checked = await verifyClarificationRecord(root, config, workflow, phase, {
        generation, groundingRecord: composed.record
      });
      if (!checked.errors.length && checked.record?.agent === composed.record.agent
          && checked.record.promptPath === promptPath) expected.push(clarificationPath);
    } catch {
      // A valid prompt pair does not waive review of an invalid clarification record.
    }
  }
  return expected;
}

async function safeContextFile(root, relative) {
  try { return await regularContextFile(root, relative); } catch { return false; }
}

async function contextJson(root, relative) {
  if (!await safeContextFile(root, relative)) return null;
  try { return JSON.parse(await readFile(path.join(root, relative), 'utf8')); } catch { return null; }
}

/**
 * Which changed paths are the open step's own artifacts: its declared artifact-set members, and
 * anything below its artifact directory when no other step of the Story keeps artifacts there.
 * Publication registers and commits these as the step's draft, for its approvers to review.
 */
function stepArtifactScope(definition, workflow, phase, itemRoot) {
  const directory = memberRoot(phase);
  let set = null;
  try { set = resolvedArtifactSet(definition, workflow, phase); } catch { set = null; }
  // A folder member ('verification/') covers every file below it.
  const members = (set?.members ?? []).map(member => {
    const joined = path.posix.join(itemRoot, directory, member.path);
    return member.path.endsWith('/') ? joined.replace(/\/*$/u, '/') : joined;
  });
  // Steps that keep no artifact (a sign-off) share no directory.
  const others = Object.values(workflow.phases ?? {}).filter(entry => entry?.id && entry.id !== phase.id
    && (entry.requiredArtifact?.path ?? entry.artifact?.path)).map(memberRoot);
  const owned = directory && !others.some(other => !other || other === directory
    || other.startsWith(`${directory}/`) || directory.startsWith(`${other}/`)) ? `${itemRoot}/${directory}/` : null;
  return relative => Boolean(owned && relative.startsWith(owned))
    || members.some(member => member.endsWith('/') ? relative.startsWith(member) : relative === member);
}

/**
 * Other files the open step writes before its publication commit, so a later entry does not take
 * them for somebody else's work and hold the step for a person: the step's own artifacts, and the
 * records composition, MCP capture and preparation leave in the Story's context directory. Each
 * record is admitted only when it names this Story, step and generation; a copied output only when
 * its record still binds its hash. Anything else stays for human review.
 */
export async function expectedStepOwnedPaths(root, config, workflow, phase, {
  itemRoot, generation, changedPaths
}) {
  if (generation !== nextPhaseGeneration(phase)) return [];
  const candidates = changedPaths.filter(relative => relative.startsWith(`${itemRoot}/`)
    && !relative.split('/').includes('..'));
  if (!candidates.length) return [];
  const workId = workflow.workItem?.id;
  const admitted = new Set();
  const admit = async relative => { if (await safeContextFile(root, relative)) admitted.add(relative); };
  const ownArtifact = stepArtifactScope(config, workflow, phase, itemRoot);
  const context = `${itemRoot}/context/`;
  const step = `${phase.id}-gen${generation}`;
  const bound = record => record?.workId === workId && record.phase === phase.id && record.generation === generation;
  for (const relative of candidates) {
    if (ownArtifact(relative) || relative === `${itemRoot}/STATUS.md`) { await admit(relative); continue; }
    if (!relative.startsWith(context)) continue;
    const name = relative.slice(context.length);
    let match;
    if ((match = /^superseded\/([^/]+)\/([^/]+)$/u.exec(name)) && match[1].startsWith(`${step}-`)
        && [`${step}.json`, `${step}.md`, 'reason.json'].includes(match[2])) {
      // A recomposed prompt moves the earlier pair aside with the reason it was replaced.
      const reason = await contextJson(root, `${context}superseded/${match[1]}/reason.json`);
      if (reason?.phase === phase.id && reason.generation === generation) await admit(relative);
    } else if (name === `design-sources-${step}.json`) {
      if (bound(await contextJson(root, relative))) await admit(relative);
    } else if ((match = /^work-intervals\/[^/]+-gen\d+-baseline\.json$/u.exec(name))) {
      const record = await contextJson(root, relative);
      if (record?.kind === 'work-interval-baseline' && record.workId === workId && record.phaseId === phase.id
          && record.generation === generation) await admit(relative);
    } else if ([`spec-indexes/${step}.json`, `claims/${step}-planned.json`].includes(name)) {
      const record = await contextJson(root, relative);
      if (record?.phase === phase.id && record.generation === generation && (record.workId ?? workId) === workId) await admit(relative);
    } else if (name.startsWith('remote-output-') && name.endsWith(`-${step}.json`)) {
      if ((phase.remoteOutputs ?? []).some(output => output.generation === generation
        && name === `remote-output-${output.agent}-${output.resource}-${step}.json`)) await admit(relative);
    } else if ((match = /^mcp\/records\/([^/]+)\.json$/u.exec(name))) {
      const record = await contextJson(root, relative);
      if (record?.id !== match[1] || record.workId !== workId || record.phase !== phase.id
          || record.targetGeneration !== generation) continue;
      await admit(relative);
      const output = record.output?.path ? `${itemRoot}/${record.output.path}` : null;
      if (output && candidates.includes(output) && output.startsWith(`${context}mcp/outputs/`)
          && await safeContextFile(root, output)
          && (await snapshot(path.join(root, output))).sha256 === record.output.sha256) admitted.add(output);
    } else if ((match = /^design-inventory\/([0-9a-f]{64})\/digest\.(?:json|md)$/u.exec(name))) {
      const digest = await contextJson(root, `${context}design-inventory/${match[1]}/digest.json`);
      if (digest?.kind === 'design-inventory-digest' && digest.workId === workId
          && digest.sourceSetSha256 === match[1]) await admit(relative);
    } else if (/^ast\/derivations\/[0-9a-f]{64}\.json$/u.test(name)) {
      // Immutable and content-addressed: valid when its integrity hash holds.
      try {
        const { validateAstDerivationManifest } = await import('./ast-evidence.mjs');
        validateAstDerivationManifest(await contextJson(root, relative));
        await admit(relative);
      } catch { /* An invalid derivation stays for review. */ }
    }
  }
  return [...admitted];
}
