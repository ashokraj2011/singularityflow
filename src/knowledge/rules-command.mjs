/**
 * `singularity-flow wm rules …`: business rules and what they mean.
 *
 *   list    [--area PATH] [--focus TEXT] [--json]                      every rule, its status, and its proposed or confirmed meaning
 *   propose [--area PATH] [--focus TEXT] [--limit N] [--refresh] [--dry-run] [--json]
 *                                                                      draft condition → outcome and intent (a model when one is on;
 *                                                                      otherwise the rule's own condition and outcome); model-advisory
 *   confirm RULE-ID [--condition TEXT] [--outcome TEXT] [--intent TEXT] [--json]
 *                                                                      a person confirms the meaning (docs/knowledge/rule-meanings.yml)
 *
 * Proposals stay on this machine. Confirming is a person's act: Copilot turns are refused it.
 */
import { operationContext } from '../operation-context.mjs';
import { optionBoolean, optionNumber, optionString, SingularityFlowError } from '../util.mjs';
import { readDocumentation } from './brief.mjs';
import { applyReviews, readConfirmations } from './confirm.mjs';
import { buildRuleRecords, meaningText, ruleStatusWords } from './records/rules.mjs';
import {
  applyRuleMeanings, confirmRuleMeaning, draftMeaning, meaningCurrent, meaningPrompt, readProposals, readRuleMeanings,
  validateMeanings, writeProposals, MEANING_LIMITS
} from './rule-meaning.mjs';
import { readKnowledgeSource } from './source.mjs';
import { buildKnowledge } from './store.mjs';

const USAGE = 'Usage: singularity-flow wm rules list|propose|confirm [RULE-ID] [--focus TEXT] [--json]';

async function ruleRecords(root, options) {
  const area = optionString(options, 'area') ?? null;
  const result = await buildKnowledge(root, { area });
  if (result.status !== 'ok') {
    throw new SingularityFlowError(`This repository has ${result.codeFiles} code files, more than one knowledge build reads. Name an area with --area PATH (singularity-flow wm knowledge areas lists them).`,
      { code: 'KNOWLEDGE_SCOPE_TOO_LARGE', details: { codeFiles: result.codeFiles } });
  }
  const focus = optionString(options, 'focus') ?? null;
  const knowledge = applyReviews(result.knowledge, await readConfirmations(root));
  const records = buildRuleRecords(knowledge, readDocumentation(root, { focus }), { focus });
  return { result, records: applyRuleMeanings(records, await readRuleMeanings(root), await readProposals(root)) };
}

function meaningLine(record) {
  if (record.meaning?.current) return `meaning (confirmed${record.meaning.by ? ` by ${record.meaning.by}` : ''}): ${meaningText(record.meaning)}`;
  if (record.meaning) return `a confirmed meaning is out of date: its lines changed; confirm it again with singularity-flow wm rules confirm ${record.id}`;
  if (record.proposal) return `proposed (${record.proposal.by === 'model' ? `by ${record.proposal.model ?? 'a model'}` : 'from the rule itself'}, advisory): ${meaningText(record.proposal)}`;
  return null;
}

export async function rulesCommand(root, positionals, options) {
  const action = positionals[0] ?? 'list';
  if (!['list', 'propose', 'confirm'].includes(action)) throw new SingularityFlowError(USAGE);
  const json = optionBoolean(options, 'json');
  const { result, records } = await ruleRecords(root, options);
  if (action === 'confirm') return confirmCommand(root, records, positionals[1], options);
  if (action === 'propose') return proposeCommand(root, result, records, options);
  if (json) { console.log(JSON.stringify({ status: 'ok', commit: result.knowledge.repository.commit, rules: records }, null, 2)); return { rules: records }; }
  if (!records.length) console.log('No business rules were found in the code or the docs.');
  for (const record of records.slice(0, 60)) {
    console.log(`${record.id}  ${record.text.replace(/[.\s]+$/u, '')}. ${ruleStatusWords(record)}`);
    const meaning = meaningLine(record);
    if (meaning) console.log(`    ${meaning}`);
  }
  if (records.length > 60) console.log(`… ${records.length - 60} more (--json lists them all)`);
  return { rules: records };
}

/**
 * Draft meanings for the rules that have no current confirmed one. With a model the drafts come from
 * the rule, its docs and its cited lines, checked like a brief; without one, from the rule's own
 * condition and outcome. A model's draft is not replaced by a template one.
 */
async function proposeCommand(root, result, records, options) {
  const json = optionBoolean(options, 'json');
  const limit = Math.max(1, Math.min(optionNumber(options, 'limit') ?? MEANING_LIMITS.rules, 40));
  const open = records.filter((record) => !record.meaning?.current && (record.anchors ?? []).length).slice(0, limit);
  const source = await readKnowledgeSource(root, { area: optionString(options, 'area') ?? null });
  const filesByPath = new Map([...source.files, ...source.manifests].map((file) => [file.path, file]));
  const prompt = meaningPrompt(open, filesByPath, { limits: { ...MEANING_LIMITS, rules: limit } });
  if (optionBoolean(options, 'dry-run')) {
    if (json) console.log(JSON.stringify({ status: 'dry-run', rules: prompt.records, promptSha256: prompt.sha256, prompt: prompt.text }, null, 2));
    else console.log(prompt.text);
    return { status: 'dry-run' };
  }
  const proposals = await readProposals(root);
  const byId = new Map(open.map((record) => [record.id, record]));
  const modelOn = operationContext()?.operation?.id === 'wm.rules.propose';
  let mode = 'template';
  let model = null;
  let rejected = [];
  let reason = null;
  const missing = open.filter((record) => optionBoolean(options, 'refresh') || record.proposal?.by !== 'model');
  if (modelOn && missing.length) {
    try {
      const sent = missing.length === open.length ? prompt : meaningPrompt(missing, filesByPath, { limits: { ...MEANING_LIMITS, rules: limit } });
      const answer = await (await import('./model.mjs')).askKnowledgeModel(root, {
        text: sent.text, channel: 'repository-rule-meaning', subject: { kind: 'repository-knowledge', id: result.knowledge.repository.name ?? 'repository' }
      });
      const checked = validateMeanings(answer.output, sent.evidence);
      for (const entry of checked.accepted) {
        proposals[entry.rule] = { condition: entry.condition, outcome: entry.outcome, intent: entry.intent, by: 'model', model: answer.model ?? null,
          anchors: byId.get(entry.rule).anchors, promptSha256: sent.sha256, createdAt: new Date().toISOString() };
      }
      mode = 'model';
      model = answer.model ?? null;
      rejected = checked.rejected;
    } catch (error) {
      reason = `The model could not draft meanings (${error instanceof Error ? error.message : String(error)}); the rules' own conditions and outcomes were drafted instead.`;
    }
  } else if (!modelOn) reason = 'Model use is off, so each draft is the rule\'s own condition and outcome.';
  for (const record of open) {
    // A model's draft for these lines stays; a rule without one gets its own condition and outcome.
    if (proposals[record.id]?.by === 'model' && meaningCurrent(record, proposals[record.id].anchors)) continue;
    const draft = draftMeaning(record);
    if (draft.condition && draft.outcome) proposals[record.id] = { ...draft, by: 'template', model: null, anchors: record.anchors, createdAt: new Date().toISOString() };
  }
  await writeProposals(root, proposals);
  const shown = applyRuleMeanings(open, [], proposals).filter((record) => record.proposal)
    .map((record) => ({ rule: record.id, text: record.text, status: record.status, ...record.proposal, anchors: undefined }));
  const summary = { status: 'ok', mode, model, advisory: true, proposals: shown, rejected, reason };
  if (json) { console.log(JSON.stringify(summary, null, 2)); return summary; }
  console.log(`${shown.length} draft meaning${shown.length === 1 ? '' : 's'} (advisory until a person confirms one):`);
  for (const entry of shown) {
    console.log(`${entry.rule}  ${entry.text.replace(/[.\s]+$/u, '')}`);
    console.log(`    proposed${entry.by === 'model' ? ` by ${entry.model ?? 'a model'}` : ' from the rule itself'}: ${meaningText(entry)}`);
  }
  for (const entry of rejected.slice(0, 10)) console.log(`  not proposed: ${entry.rule} (${entry.reason})`);
  if (reason) console.log(reason);
  if (shown.length) console.log(`A person confirms one with: singularity-flow wm rules confirm ${shown[0].rule} [--condition TEXT] [--outcome TEXT] [--intent TEXT]`);
  return summary;
}

/** A person's confirmation: the draft, or their own words, bound to the rule's current lines. */
async function confirmCommand(root, records, id, options) {
  if (!id) throw new SingularityFlowError('Usage: singularity-flow wm rules confirm RULE-ID [--condition TEXT] [--outcome TEXT] [--intent TEXT] [--json]');
  const record = records.find((entry) => entry.id === id);
  if (!record) throw new SingularityFlowError(`No rule '${id}' in this build. List them with: singularity-flow wm rules list`, { code: 'KNOWLEDGE_RULE_UNKNOWN' });
  const draft = record.proposal ?? draftMeaning(record);
  const typed = ['condition', 'outcome', 'intent'].some((name) => optionString(options, name) != null);
  const meaning = {
    condition: optionString(options, 'condition') ?? draft.condition,
    outcome: optionString(options, 'outcome') ?? draft.outcome,
    intent: optionString(options, 'intent') ?? draft.intent ?? null
  };
  if (!meaning.condition?.trim() || !meaning.outcome?.trim()) {
    throw new SingularityFlowError(`Rule ${id} has no drafted condition and outcome. Run singularity-flow wm rules propose, or give --condition and --outcome.`, { code: 'KNOWLEDGE_RULE_MEANING_REQUIRED' });
  }
  const { entry, file } = await confirmRuleMeaning(root, record, meaning, {
    proposedBy: typed ? 'person' : record.proposal?.by ?? 'template', model: typed ? null : record.proposal?.model ?? null
  });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify({ status: 'confirmed', meaning: entry, file }, null, 2));
  else {
    console.log(`Confirmed ${id}: ${meaningText(entry)}.`);
    console.log(`Commit ${file} with your change so the meaning travels with the code; it goes out of date when its lines change.`);
  }
  return { entry, file };
}
