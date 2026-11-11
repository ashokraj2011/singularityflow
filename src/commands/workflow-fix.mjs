/**
 * `workflow fix [WORKFLOW] [--answers FILE|-] [--write] [--json]` — every finding of `workflow
 * check` (and `workflow validate`) as a drafted change or a question only a person can answer
 * (src/workflow-fix/index.mjs). A read: it drafts, never applies. `--write` puts the change set in
 * this repository's private fix draft file, outside the repository (the file /sf-fix-workflow
 * proposes), so `workflow check --change-set` can confirm it and `workflow studio apply
 * --change-set --propose` can make it one reviewed proposal. `--answers` turns answered questions
 * into changes too.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SingularityFlowError, commandLineFile, optionBoolean, optionString } from '../util.mjs';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const indented = (text, indent) => String(text).split('\n').join(`\n${indent}`);
const countWords = (counts) => ['problem', 'warning', 'note'].map((severity) => plural(counts?.[severity] ?? 0, severity)).join(', ');

function printFix(result) {
  const scope = result.workflow ? `${result.workflow}` : 'Every workflow';
  console.log(`${scope}: ${countWords(result.counts)}; ${plural(result.counts.changes, 'change')} drafted, ${plural(result.counts.questions, 'question')} for a person.`);
  if (result.changes.length) {
    console.log('');
    console.log(result.changeSet ? 'Changes (one reviewed Workflow Studio proposal; nothing is applied yet):' : 'Changes (one reviewed configuration proposal; nothing is applied yet):');
    result.changes.forEach((change, index) => {
      console.log(`  ${index + 1}. ${indented(change.summary, '     ')}  [${change.code}${change.answers ? `, answers ${change.answers}` : ''}]`);
      for (const diff of change.diffs ?? []) console.log(`     ${indented(diff.diff.trimEnd(), '     ')}`);
    });
  }
  if (result.questions.length) {
    console.log('');
    console.log('Questions only a person can answer:');
    for (const question of result.questions) {
      console.log(`  ${question.id}  ${indented(question.ask, '       ')}`);
      console.log(`       Why a person: ${question.why}`);
      for (const choice of question.choices) console.log(`       - ${choice.id}: ${choice.label}${choice.needs ? ` (needs ${choice.needs})` : ''}`);
    }
    console.log('  Answer in a file: {"answers": {"<question>": {"choice": "<choice>", "people": ["<login>"], "text": "..."}}}, then: singularity-flow workflow fix --answers <file>');
  }
  if (result.configurationFiles.length) {
    console.log('');
    console.log('The configuration does not load, so Workflow Studio cannot apply changes to it. Repaired as text:');
    for (const file of result.configurationFiles) console.log(`  ${file.path}${file.written ? `  (written to ${file.written})` : ''}`);
  }
  if (result.after) {
    console.log('');
    console.log(result.after.problems
      ? `These changes do not apply: ${result.after.problems.map((problem) => problem.message).join(' ')}`
      : `After these changes: ${countWords(result.after.counts ?? {})} (checked on a copy; nothing was written).`);
    for (const finding of (result.after.findings ?? []).filter((entry) => entry.severity !== 'note')) console.log(`  ${finding.severity.padEnd(8)} ${finding.title}`);
  }
  if (result.changeSet) {
    console.log('');
    console.log(result.draft.written ? `Change set written to ${result.draft.path}.` : `Write the change set with --write (to ${result.draft.path}).`);
    for (const line of result.next) console.log(`  ${line}`);
  } else if (!result.questions.length && !result.configurationFiles.length) console.log('Nothing to fix.');
}

export async function run(argv, { positionals, options }) {
  const unknown = Object.keys(options).filter((key) => !['answers', 'write', 'json'].includes(key));
  if (unknown.length) throw new SingularityFlowError(`workflow fix does not take --${unknown[0]}.`, { code: 'WORKFLOW_FIX_USAGE' });
  if (positionals.length > 3) throw new SingularityFlowError('Name at most one workflow: singularity-flow workflow fix [WORKFLOW].', { code: 'WORKFLOW_FIX_USAGE' });
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot();
  const workflow = positionals[2] ?? null;
  const [{ withApprovedConfigurationRead }, { draftWorkflowFixes, readFixAnswers }, { workflowFixDraftPath }] = await Promise.all([
    import('../approved-configuration-reader.mjs'), import('../workflow-fix/index.mjs'), import('../workflow-validation.mjs')]);
  const source = optionString(options, 'answers');
  let answers = null;
  if (source) {
    const { readStdinText } = await import('../read-stdin.mjs');
    answers = readFixAnswers(source === '-' ? await readStdinText() : await readFile(commandLineFile(root, source, { reads: true }), 'utf8'));
  }
  const result = await withApprovedConfigurationRead(root, () => draftWorkflowFixes(root, { workflow, answers }), { preferAuthority: true });
  const draftPath = workflowFixDraftPath(root, workflow);
  let written = false;
  if (result.changeSet || result.configurationFiles.length) {
    // The same private file `workflow validate` issues: a live /sf-fix-workflow turn may check and propose it.
    await import('../workflow-build/store.mjs').then(({ preparePrivateStateFile }) => preparePrivateStateFile(draftPath)).catch(() => null);
    await import('../copilot-mutation-guard.mjs').then(({ issueFixWorkflowStaging }) => issueFixWorkflowStaging(draftPath, { root })).catch(() => 0);
  }
  if (optionBoolean(options, 'write') && (result.changeSet || result.configurationFiles.length)) {
    if (result.changeSet) { await writeFile(draftPath, `${JSON.stringify(result.changeSet, null, 2)}\n`, { mode: 0o600 }); written = true; }
    for (const file of result.configurationFiles) {
      file.written = path.join(path.dirname(draftPath), `${workflow ?? 'all-workflows'}.${path.basename(file.path)}`);
      await writeFile(file.written, file.content, { mode: 0o600 });
    }
  }
  const shown = written ? draftPath : '<change-set-file>';
  result.draft = { path: draftPath, written };
  result.next = result.changeSet ? [
    `Confirm: singularity-flow workflow check${workflow ? ` ${workflow}` : ''} --change-set ${shown}`,
    `Propose for review: singularity-flow workflow studio apply --change-set ${shown} --propose`
  ] : result.configurationFiles.map((file) => `Propose for review: singularity-flow configuration save ${file.path} --propose < ${file.written ?? '<repaired-file>'}`);
  if (result.after?.problems) process.exitCode = 1;
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  printFix(result);
}
