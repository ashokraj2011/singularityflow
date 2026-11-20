/**
 * `workflow assess [WORKFLOW] [--read STEP [--part N]] [--verify FILE|-] [--json]` — a detailed,
 * model-free assessment of what each step's agent is told (src/workflow-assess/): the layers it
 * receives and their sizes, what is repeated, what contradicts the step's settings, the platform or
 * another rule, what is longer or vaguer than it needs to be, and the change that fixes each.
 * `--read` gives Copilot one step's text in parts; `--verify` checks Copilot's own findings against
 * the files. Read-only: changes are made through `workflow build start --assess ID`.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SingularityFlowError, commandLineFile, optionBoolean, optionString } from '../util.mjs';

const OPTIONS = ['json', 'read', 'part', 'verify'];

export async function run(argv, { positionals, options }) {
  const unknown = Object.keys(options).filter((key) => !OPTIONS.includes(key));
  if (unknown.length) throw new SingularityFlowError(`workflow assess does not take --${unknown[0]}.`, { code: 'WORKFLOW_ASSESS_USAGE' });
  if (positionals.length > 3) throw new SingularityFlowError('Name at most one workflow: singularity-flow workflow assess [WORKFLOW].', { code: 'WORKFLOW_ASSESS_USAGE' });
  const workflow = positionals[2] ?? null;
  const step = optionString(options, 'read');
  const verify = optionString(options, 'verify');
  if ((step || verify) && !workflow) throw new SingularityFlowError(`Name the workflow: singularity-flow workflow assess <WORKFLOW> ${step ? '--read <STEP>' : '--verify <FILE>'}.`, { code: 'WORKFLOW_ASSESS_USAGE' });
  if (step && verify) throw new SingularityFlowError('Read a step (--read) or verify findings (--verify), one at a time.', { code: 'WORKFLOW_ASSESS_USAGE' });
  const part = optionString(options, 'part');
  if (part != null && (!step || !/^[1-9]\d{0,3}$/u.test(part))) throw new SingularityFlowError('--part is a part number, 1 or more, of a step read with --read.', { code: 'WORKFLOW_ASSESS_USAGE' });
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot();
  const { withApprovedConfigurationRead } = await import('../approved-configuration-reader.mjs');
  const api = await import('../workflow-assess/index.mjs');
  const json = optionBoolean(options, 'json');
  const read = (fn) => withApprovedConfigurationRead(root, fn, { preferAuthority: true });
  if (step) {
    const result = await read(() => api.readStepBundle(root, { workflow, step, part: part ? Number(part) : 1 }));
    if (json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.label} (${result.step}), part ${result.part} of ${result.parts}. ${result.untrusted}`);
    for (const chunk of result.text) {
      console.log(`${chunk.file} (${chunk.label})`);
      for (const line of chunk.lines) console.log(`  ${line}`);
    }
    return console.log(`Next: ${result.next.replace(/ --json$/u, '')}`);
  }
  if (verify) {
    const { readStdinText } = await import('../read-stdin.mjs');
    const text = verify === '-' ? await readStdinText() : await readFile(commandLineFile(root, verify, { reads: true }), 'utf8');
    let input;
    try { input = JSON.parse(text); } catch (error) { throw new SingularityFlowError(`The findings are not valid JSON: ${error.message}`, { code: 'WORKFLOW_ASSESS_VERIFY_INVALID' }); }
    const result = await read(() => api.verifyCopilotFindings(root, { workflow, input }));
    if (json) return console.log(JSON.stringify(result, null, 2));
    for (const finding of result.accepted) console.log(`accepted ${finding.id} (Copilot's): ${finding.title}  ${finding.location.file}:${finding.location.line}`);
    for (const entry of result.refused) console.log(`refused  #${entry.index}: ${entry.reason} ${entry.repair}`);
    if (result.correctedWords) console.log(result.correctedWords);
    return console.log(result.said);
  }
  const result = await read(() => api.assessWorkflows(root, { workflows: workflow ? [workflow] : null }));
  // The one file Copilot writes its own findings to, issued to live /sf-fix-workflow and /sf-build-workflow turns.
  for (const entry of result.workflows) {
    if (!entry.next) continue;
    entry.next.findingsPath = api.copilotFindingsPath(root, entry.id);
    await mkdir(path.dirname(entry.next.findingsPath), { recursive: true, mode: 0o700 }).catch(() => null);
    await import('../copilot-mutation-guard.mjs').then(({ issueBuildStaging, issueFixWorkflowStaging }) => Promise.all([
      issueBuildStaging(entry.next.findingsPath, { root }), issueFixWorkflowStaging(entry.next.findingsPath, { root })])).catch(() => 0);
  }
  if (json) return console.log(JSON.stringify(result, null, 2));
  for (const line of api.assessmentLines(result, { steps: Boolean(workflow) })) console.log(line);
}
