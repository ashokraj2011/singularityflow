/** Recognize current-generation preparation bytes, never publication or adoption authority. */
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { readPromptGeneration } from './inject.mjs';
import { clarificationRecordRelative, verifyClarificationRecord } from './clarifications.mjs';
import { resolveRepositoryManifest } from './repository-manifest.mjs';
import { readBoundSpecificationClaimMap } from './specifications.mjs';
import { readRecord } from './schema-migrations.mjs';
import { snapshot } from './util.mjs';
import { memberRoot, resolvedArtifactSet } from './artifact-sets.mjs';
import { isConvergencePhase } from './phase-roles.mjs';
import YAML from 'yaml';

/** knowledge/confirm.mjs CONFIRMATIONS_PATH, kept here so recovery does not load the knowledge model. */
const KNOWLEDGE_CONFIRMATIONS_PATH = 'docs/knowledge/confirmations.yml';

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
 * `context/agent-snapshots/`. Publication commits them with the generation. They are this step's
 * own record when the audit names this Story, step and generation and an agent the Story configures
 * (the prompt record's agent, when this generation has one), and every changed copy it lists still
 * has its recorded hash; otherwise a person reviews them. The audit is judged on its own: it can be
 * left alone when its prompt was already committed, or when composition stopped before writing the
 * prompt, and holding it then refused the very composition that would have rewritten it.
 */
async function agentContextPaths(root, workflow, phase, { itemRoot, generation, changedPaths, agents, promptAgent }) {
  const auditPath = `${itemRoot}/context/agents-${phase.id}-gen${generation}.json`;
  if (!changedPaths.includes(auditPath)) return [];
  try {
    if (!await regularContextFile(root, auditPath)) return [];
    const audit = readRecord('agent-context-audit', await readFile(path.join(root, auditPath))).record;
    if (audit?.workId !== workflow.workItem?.id || audit.phase !== phase.id
        || audit.generation !== generation || !Object.hasOwn(agents, String(audit.agent ?? ''))
        || (promptAgent !== undefined && audit.agent !== promptAgent)) return [];
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
    // No links and no unbounded reads, checked before the pair is read; a missing half is reported below.
    for (const relative of [recordPath, promptPath]) {
      if (await lstat(path.join(root, relative)).then(() => true, () => false) && !await regularContextFile(root, relative)) return expected;
    }
    composed = await readPromptGeneration(root, workflow, phase, {
      workDir: path.join(root, itemRoot)
    });
    const agents = workflow.resolution?.agents ?? config.agents ?? {};
    if (!composed?.record.agent || !Object.hasOwn(agents, composed.record.agent)) return expected;
    expected.push(recordPath, promptPath);
  } catch (error) {
    // One half of an interrupted pair is composition's to repair: it recomposes and keeps the half
    // only when the fresh candidate matches it exactly, and refuses otherwise. Holding the half for a
    // person refused that composition, so the step could never continue. Unsupported, malformed or
    // hash-mismatched pairs remain manual.
    const { hasRecord, hasPrompt } = error?.details ?? {};
    const half = error?.code === 'PROMPT_SNAPSHOT_INTEGRITY_FAILED' && typeof hasRecord === 'boolean'
      && typeof hasPrompt === 'boolean' && hasRecord !== hasPrompt ? (hasRecord ? recordPath : promptPath) : null;
    if (half && changedPaths.includes(half) && await safeContextFile(root, half)) expected.push(half);
    return expected;
  }

  if (changedPaths.includes(clarificationPath)) {
    try {
      if (!await regularContextFile(root, clarificationPath)) return expected;
      const checked = await verifyClarificationRecord(root, config, workflow, phase, {
        generation, groundingRecord: composed.record
      });
      const sameStep = checked.record?.agent === composed.record.agent && checked.record.promptPath === promptPath;
      // Answers recorded against a prompt this generation later recomposed (its superseded pair names
      // the hash they were bound to) are still this step's: entry asks the person to re-bind them.
      if (sameStep && (!checked.errors.length
          || (checked.staleOnly && await supersededPromptOf(root, itemRoot, phase, generation, checked.record.promptSha256)))) {
        expected.push(clarificationPath);
      }
    } catch {
      // A valid prompt pair does not waive review of an invalid clarification record.
    }
  }
  return expected;
}

/** Whether this step and generation superseded a composed prompt with exactly this rendered hash. */
async function supersededPromptOf(root, itemRoot, phase, generation, renderedSha256) {
  if (!/^[0-9a-f]{64}$/u.test(String(renderedSha256 ?? ''))) return false;
  const directory = path.join(root, itemRoot, 'context', 'superseded');
  const names = await readdir(directory).catch(() => []);
  for (const name of names.filter(entry => entry.startsWith(`${phase.id}-gen${generation}-`))) {
    const reason = await contextJson(root, `${itemRoot}/context/superseded/${name}/reason.json`);
    if (reason?.phase === phase.id && reason.generation === generation && reason.renderedSha256 === renderedSha256) return true;
  }
  return false;
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
  const safePath = relative => !relative.split('/').includes('..');
  const candidates = changedPaths.filter(relative => relative.startsWith(`${itemRoot}/`) && safePath(relative));
  const outside = changedPaths.filter(relative => !relative.startsWith(`${itemRoot}/`) && safePath(relative));
  if (!candidates.length && !outside.length) return [];
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
    } else if (name === `agents-${step}.json`) {
      // The prompt record of this generation, committed or not, names the agent the audit must name.
      const prompt = await contextJson(root, `${context}${step}.json`);
      const present = await safeContextFile(root, `${context}${step}.json`);
      if (present && !prompt?.agent) continue;
      for (const owned of await agentContextPaths(root, workflow, phase, { itemRoot, generation, changedPaths: candidates,
        agents: workflow.resolution?.agents ?? config.agents ?? {}, promptAgent: present ? prompt.agent : undefined })) admitted.add(owned);
    } else if (name === `design-sources-${step}.json`) {
      if (bound(await contextJson(root, relative))) await admit(relative);
    } else if ((match = /^work-intervals\/[^/]+-gen\d+-baseline\.json$/u.exec(name))) {
      const record = await contextJson(root, relative);
      if (record?.kind === 'work-interval-baseline' && record.workId === workId && record.phaseId === phase.id
          && record.generation === generation) await admit(relative);
    } else if ((match = /^(spec-indexes|claims|spec-quality|acceptance)\/(.+)-gen(\d+)(-planned|-assisted)?\.json$/u.exec(name))
        && ({ 'spec-indexes': '', claims: '-planned', 'spec-quality': '-assisted', acceptance: '' })[match[1]] === (match[4] ?? '')) {
      // spec index, spec claims planned, spec analyze --assisted and spec acceptance write these for any
      // step of the Story, at its published generation (or this step's next one).
      const [, , stepId, number] = match;
      const target = stepId === phase.id ? phase : workflow.phases?.[stepId];
      const at = Number(number);
      const record = target && (at === Math.max(1, Number(target.generation ?? 0)) || (stepId === phase.id && at === generation))
        ? await contextJson(root, relative) : null;
      if (record && (record.workId ?? workId) === workId && (record.phase ?? stepId) === stepId
          && (record.generation ?? at) === at) await admit(relative);
    } else if (/^convergence\/(?:legacy\/)?[^/]+\.json$/u.test(name)) {
      // Convergence iterations, assisted candidates and legacy archives, written by prepare on this step.
      if (isConvergencePhase(phase) && (await contextJson(root, relative))?.workId === workId) await admit(relative);
    } else if ((match = /^agent-snapshots\/([^/]+)\/[^/]+-(?:sha256:)?([0-9a-f]{64})\.md$/u.exec(name))) {
      // A skill copy is named by the hash of its exact text: valid on its own, with or without its audit.
      if (Object.hasOwn(workflow.resolution?.agents ?? config.agents ?? {}, match[1]) && await safeContextFile(root, relative)
          && (await snapshot(path.join(root, relative))).sha256 === match[2]) admitted.add(relative);
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
  for (const relative of outside) {
    if (/^\.(?:vscode|idea)\//u.test(relative)) {
      // Editor configuration (mcp scaffold writes .vscode/mcp.json): publication never registers it, so
      // holding a step for it would hold every later step too.
      await admit(relative);
    } else if (relative === KNOWLEDGE_CONFIRMATIONS_PATH) {
      // wm knowledge confirm|correct|reject: the person's review of repository knowledge (guidance only).
      try {
        const parsed = YAML.parse(await readFile(path.join(root, relative), 'utf8'));
        if (parsed && Object.keys(parsed).every(key => key === 'reviews') && Array.isArray(parsed.reviews)
            && parsed.reviews.every(entry => ['confirmed', 'corrected', 'rejected'].includes(entry?.status))) await admit(relative);
      } catch { /* Not a confirmations file: it stays for review. */ }
    }
  }
  return [...admitted];
}
