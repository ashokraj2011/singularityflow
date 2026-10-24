/** World Model command adapters; phase composition has its own provider-free owner. */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SingularityFlowError, optionBoolean, optionString } from './util.mjs';
import { operationContext } from './operation-context.mjs';
import { generationSkillForPhase } from './code-delivery-policy.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { loadSession } from './session.mjs';
import { readPromptGeneration } from './inject.mjs';
import { recordPromptAudit } from './prompt-audit.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { clearCompositionCache, compositionCacheStatus } from './composition-cache.mjs';
import { REMOVED_WORLD_MODEL_SUBCOMMANDS, removedWorldModelError } from './removed-features.mjs';
import { compose, loadPromptConfig as load, phaseRepositoryBrief } from './phase-prompt-composer.mjs';
export { composePhasePrompt, resolveOptionalTokenReductionShadowRuntime, approvedReferenceAlreadyCaptured,
  intentConflictRecovery, phasePromptExecutionContract, withPhasePromptRuntimeGuidance,
  renderFinalClarificationGuard } from './phase-prompt-composer.mjs';
const KNOWLEDGE_COMMAND_MODULE = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'knowledge', 'command.mjs')).href;
const RULES_COMMAND_MODULE = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'knowledge', 'rules-command.mjs')).href;

/**
 * `wm brief`: the repository brief a phase receives, read from the composed prompt without recording
 * anything, so it is exactly what the phase sees (a saved prompt is shown as it was saved).
 *
 * `--polish` has the model phrase the brief's selected lines when model use is on (checked, and
 * saved for these records, so the phase prompt reuses it); `--refresh` asks again. With model use
 * off it is the same brief in its fixed wording. A phase whose prompt cannot be composed yet (its
 * inputs are not approved) shows the brief it would carry now, from the same inputs, and says why.
 */
async function phaseBriefCommand(root, options) {
  const story = await load(root, { agent: optionString(options, 'agent'), workId: optionString(options, 'work-id'), phase: optionString(options, 'phase') });
  if (!story.workflow) {
    throw new SingularityFlowError(
      'wm brief shows what a Story phase receives: pass --work-id, or start a Story first. For the repository as a whole, run: singularity-flow wm knowledge brief',
      { code: 'WORLD_MODEL_BRIEF_STORY_REQUIRED' }
    );
  }
  const polishAsked = optionBoolean(options, 'polish');
  const polish = polishAsked && operationContext()?.operation?.id === 'wm.brief.polish';
  let brief = null;
  let blocked = null;
  const prompt = await compose(root, {
    ...(optionString(options, 'work-id') ? { 'work-id': optionString(options, 'work-id') } : {}),
    ...(optionString(options, 'phase') ? { phase: optionString(options, 'phase') } : {}),
    ...(optionString(options, 'agent') ? { agent: optionString(options, 'agent') } : {}),
    'render-only': true, 'return-only': true, 'skip-prompt-audit': true,
    ...(polish ? { 'brief-polish': 'write', 'brief-polish-refresh': optionBoolean(options, 'refresh') } : {}),
    'brief-observer': (value) => { brief = value; }
  }).catch(async (error) => {
    const phase = optionString(options, 'phase') ?? story.workflow.currentPhase;
    if (!(error instanceof SingularityFlowError) || !story.workflow.phases?.[phase]) throw error;
    // The brief needs none of what the refusal is about; the prompt around it does.
    blocked = String(error.message).split('\n').slice(0, 2).join(' ').replace(/:\s*-\s+/u, ': ').replace(/\s+/gu, ' ').trim();
    brief = await phaseRepositoryBrief(root, { definition: story.definition, workflow: story.workflow, phase,
      polish: polish ? 'write' : 'cached', refresh: optionBoolean(options, 'refresh') });
    return brief.text;
  });
  const lines = String(prompt ?? '').split('\n');
  const start = lines.findIndex((line) => line.startsWith('# Repository brief: '));
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && /^# /u.test(line));
  const text = start < 0 ? '' : lines.slice(start, end < 0 ? undefined : end).join('\n').trimEnd();
  // A phase whose prompt is already composed shows the brief it was composed with; phrasing applies to its next one.
  const notes = [
    blocked ? `This phase's prompt cannot be composed yet (${blocked.replace(/[.:\s]+$/u, '')}); this is the Repository brief it would carry now.` : null,
    !polishAsked ? null
      : !brief ? 'This phase\'s prompt is already composed, so its brief is shown as it was composed; a phrasing applies to its next generation.'
        : !polish ? 'Model use is off, so the brief keeps its fixed wording.'
          : brief.polish?.applied ? null : 'The model\'s phrasing did not pass its checks, so the brief keeps its fixed wording.'
  ].filter(Boolean);
  const note = notes.join(' ') || null;
  const result = {
    status: text ? 'ok' : 'none', phase: optionString(options, 'phase') ?? null, bytes: Buffer.byteLength(text), text,
    budget: brief?.budget ?? null, profile: brief?.profile ?? null, saved: Boolean(text) && !brief,
    phrasing: brief?.receipt?.phrasing ?? null, records: brief?.receipt?.records ?? [], omitted: brief?.omitted ?? null,
    composed: !blocked, note, ...(polishAsked ? { polish: brief?.polish ?? null } : {})
  };
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(text || 'This phase receives no repository brief: knowledge is off and no registered view is selected.');
    for (const entry of brief?.polish?.rejected?.slice(0, 8) ?? []) console.log(`  kept its fixed wording: "${entry.text}" (${entry.reason})`);
    if (note) console.log(note);
  }
  return result;
}

async function showPrompt(root, options) {
  const requestedSkill = optionString(options, 'skill');
  if (requestedSkill != null && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(requestedSkill)) {
    throw new SingularityFlowError('Option --skill must be a valid Copilot skill ID containing lowercase letters, numbers, or hyphens.');
  }

  const requestedPhase = optionString(options, 'phase');
  const config = await load(root, {
    agent: optionString(options, 'agent'),
    workId: optionString(options, 'work-id'),
    phase: requestedPhase
  });
  const phase = requestedPhase ?? config.workflow?.currentPhase;
  if (!phase) {
    throw new SingularityFlowError('No active Story phase was found. Resume a work item or provide --phase and --work-id.');
  }
  // Without --skill, hand Copilot the skill that drafts this step (a chosen drafting skill,
  // /sf-code, /sf-converge), never the generic one: VS Code's native handoff passes no --skill.
  const storyPhase = config.workflow?.phases?.[phase];
  const drafting = storyPhase ? generationSkillForPhase(storyPhase, config.workflow) : '/sflow-phase';
  // A step that drafts nothing has no drafting prompt; say so instead of failing.
  if (!requestedSkill && !drafting) {
    const result = { status: 'not-applicable', phase, reason: `'${phase}' drafts nothing, so it has no drafting prompt.` };
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`No drafting prompt: ${result.reason}`);
    return result;
  }
  const skillId = requestedSkill ?? drafting.replace(/^\//, '');
  const skillFile = path.join(PACKAGE_ROOT, 'plugin', 'skills', skillId, 'SKILL.md');
  if (!existsSync(skillFile)) {
    throw new SingularityFlowError(`Unknown packaged Copilot skill '${skillId}'.`);
  }

  const skill = await readFile(skillFile, 'utf8');
  const selectedWorkId = config.workflow?.workItem?.id ?? optionString(options, 'work-id') ?? null;
  const recordHandoff = optionBoolean(options, 'record-audit');
  const session = await loadSession(root, { required: false });
  const sessionAgentApplies = Boolean(
    session?.agent
    && session.workId === config.workflow?.workItem?.id
    && session.phaseId === phase
    && config.definition?.agents?.[session.agent]
  );
  // Pre-phase-binding session records are still readable during migration, but only as a last
  // resort when the phase itself has no default. They can never override a phase-bound agent.
  const legacySessionAgent = Boolean(
    session?.agent
    && session.workId === config.workflow?.workItem?.id
    && !session.phaseId
    && config.definition?.agents?.[session.agent]
  ) ? session.agent : null;
  const agent = optionString(options, 'agent')
    ?? (sessionAgentApplies ? session.agent : null)
    ?? config.workflow?.phases?.[phase]?.defaultAgent
    ?? legacySessionAgent;
  const prefix = [
    '# Singularity Flow governed Story handoff',
    '',
    'Working directory: . (the verified current repository checkout)',
    ...(selectedWorkId ? [`Story: ${selectedWorkId}`] : []),
    '',
    'Use this repository as the working directory for every file and shell operation.',
    'Do not inspect or modify another repository merely because it was open in the previous chat.',
    '',
    '# Effective Copilot context',
    '',
    `- Skill: \`/${skillId}\``,
    `- Phase: \`${phase}\``,
    recordHandoff
      ? '- Mode: recorded Copilot handoff; the immutable generation prompt may be created in local Story context, but workflow state and Git are unchanged'
      : '- Mode: read-only render; no grounding record or workflow state is written',
    '',
    `--- BEGIN plugin/skills/${skillId}/SKILL.md ---`,
    skill.trimEnd(),
    `--- END plugin/skills/${skillId}/SKILL.md ---`,
    '',
    '--- BEGIN GOVERNED PHASE PROMPT ---',
    ''
  ].join('\n');
  process.stdout.write(prefix);

  const composeOptions = {
    ...options,
    phase,
    'render-only': !recordHandoff,
    'return-only': true,
    'skip-prompt-audit': recordHandoff
  };
  delete composeOptions.skill;
  delete composeOptions.out;
  delete composeOptions['dry-run'];
  const governedPrompt = await compose(root, composeOptions);
  process.stdout.write(governedPrompt);
  const suffix = '--- END GOVERNED PHASE PROMPT ---\n';
  process.stdout.write(suffix);
  if (recordHandoff) {
    if (!agent) throw new SingularityFlowError('Prompt audit requires an active agent or --agent ID.');
    const phaseRecord = config.workflow?.phases?.[phase] ?? null;
    const generationPrompt = config.workflow && phaseRecord
      ? await readPromptGeneration(root, config.workflow, phaseRecord, {
          workDir: path.join(
            root, config.workItemRoot ?? 'singularity/work-items', config.workflow.workItem.id
          ),
          agent,
          ...(options.task !== undefined ? { task: optionString(options, 'task') ?? null } : {})
        })
      : null;
    const audit = await recordPromptAudit(root, {
      prompt: `${prefix}${governedPrompt}${suffix}`,
      agent,
      phase,
      generation: config.workflow?.phases?.[phase]
        ? nextPhaseGeneration(config.workflow.phases[phase]) : null,
      workId: selectedWorkId,
      workType: config.workflow?.workItem?.workType ?? null,
      task: optionString(options, 'task') ?? null,
      source: 'vscode-governed-handoff',
      // The composed generation is the byte-owning authority. Reading it back also proves that a
      // handoff cannot be stamped from a changed/missing closure between composition and audit.
      executionContext: generationPrompt?.record.executionContext
        ?? config.executionContext?.identity
        ?? (selectedWorkId ? { mode: 'historical-unproven' } : { mode: 'legacy-live' })
    });
    if (audit) console.error(`Prompt audit recorded: ${audit.id} (${audit.promptSha256.slice(0, 12)}).`);
  }
}

export async function worldModelCommand(root, positionals, options) {
  const command = positionals[1];
  if (command === 'ast') return (await import('./ast-intelligence.mjs')).astCommand(root, positionals.slice(2), options);
  if (command === 'knowledge') {
    // Loaded on use, through a non-literal specifier, so editor bundles that import this module do not carry the analysis engine.
    const { knowledgeCommand } = await import(KNOWLEDGE_COMMAND_MODULE);
    return knowledgeCommand(root, positionals.slice(2), options);
  }
  // Business rules and their meaning: a model may draft one, a person confirms it.
  if (command === 'rules') return (await import(RULES_COMMAND_MODULE)).rulesCommand(root, positionals.slice(2), options);
  if (command === 'read') {
    const reference = positionals[2];
    if (!reference) {
      throw new SingularityFlowError(
        'Usage: singularity-flow wm read <ncg.skeleton|ncg.callers|ncg.map> [--paths ROOT] [--symbol ID] [--json]'
      );
    }
    return (await import('./fwm/read.mjs')).fwmReadCommand(root, reference, options);
  }
  if (command === 'read-views') return (await import('./fwm/read.mjs')).fwmReadViewsCommand(options);
  if (command === 'read-contract') {
    const reference = positionals[2];
    if (!reference) throw new SingularityFlowError('Usage: singularity-flow wm read-contract <view> [--json]');
    return (await import('./fwm/read.mjs')).fwmReadContractCommand(reference, options);
  }
  if (command === 'cache') {
    const action = positionals[2] ?? 'status';
    if (action === 'status') {
      const result = await compositionCacheStatus(root);
      if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`Composition cache: ${result.entries} entr${result.entries === 1 ? 'y' : 'ies'} · ${result.bytes} bytes.`);
      return result;
    }
    if (action === 'clear') {
      const result = await clearCompositionCache(root);
      if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`Cleared ${result.removed} composition cache entr${result.removed === 1 ? 'y' : 'ies'} (${result.bytes} bytes).`);
      return result;
    }
    throw new SingularityFlowError('Usage: singularity-flow wm cache status|clear [--json]');
  }
  if (command === 'inject' || command === 'compose') return compose(root, options);
  if (command === 'show-prompt') return showPrompt(root, options);
  if (command === 'brief') return phaseBriefCommand(root, options);
  // The registered (v4) and legacy-v3 World Models were removed; their commands and options are refused by name.
  if (REMOVED_WORLD_MODEL_SUBCOMMANDS.has(command)) throw removedWorldModelError(`wm ${command}`);
  if (optionBoolean(options, 'state-only') || optionString(options, 'format')) throw removedWorldModelError('wm --format');
  throw new SingularityFlowError(
    'Usage: singularity-flow wm compose|inject|show-prompt|brief|knowledge|rules|ast|read <ncg-view>|read-views|read-contract <ncg-view>|cache status|clear'
  );
}
