import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { canonicalCommand, operationCatalog } from '../src/command-registry.mjs';
import { REMOVED_WORLD_MODEL_SUBCOMMANDS } from '../src/removed-features.mjs';
import { AUTHORING_SKILL_DECLARATION, parseAuthoringSkills } from '../src/authoring-skills.mjs';
import { copilotPauseGuardForSkill, COPILOT_PAUSE_MARKER, PHASE_ENTRY_SKILLS } from '../src/copilot-mode.mjs';
import { mutationTurnMode } from '../src/phase-mutation-contract.mjs';
import { CLI_PATH_CONTRACT } from '../src/safe-command-guidance.mjs';
import { COMMAND_PRESENTATION_CONTRACT } from '../src/model-free-commands.mjs';

export { COMMAND_PRESENTATION_CONTRACT };
/**
 * How a Story skill that runs governed commands handles a refusal. `[phase-self-repair A2/A4]`
 *
 * No skill taught the refusal shape, so agents stopped on routes the CLI had already planned, retried
 * unchanged conditions, or tried to edit an earlier phase. Engine-owned like the presentation
 * contracts: fixed overhead added to the budget, not per-skill prose, and only on Story authoring
 * and mutation skills (approval and review turns never run automatic actions).
 */
export const REFUSAL_HANDLING_CONTRACT = 'On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it.';

/**
 * A returned automatic action (`sync`) is a kernel mutation, so only a skill whose turn may run kernel
 * mutations (authoring or kernel-only) is told it may run one. /sf-publish, /sf-review-decide and
 * read turns were told so, and their turn refused the `sync` they then ran.
 */
export const AUTOMATIC_ACTION_CONTRACT = 'One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once.';
export function automaticActionApplies(name, rule) {
  return refusalHandlingApplies(rule) && ['authoring', 'kernel-only'].includes(mutationTurnMode(name));
}

/**
 * A skill that writes its own document does that work in the turn. A live /sf-phase run ended three turns
 * relaying its own /sf-phase route, and stopped again when a file edit did not match. Only on generative
 * skills: a skill whose returned route waits on a person (a capture, registration, decision or
 * confirmation) must never run it for them, so the clause names what a person must still supply.
 */
export const AUTHORING_TURN_CONTRACT = 'When a result\'s `act.state` is `author`, or it routes back to this skill with nothing for a person to answer, edit, review or confirm, that is this turn\'s own work: do it, never relay it. Copy every line a patch matches, changed or unchanged, from the file as it is now, read after your last edit of it, never from memory, a finding or a search result; one file per patch, so one stale hunk cannot reject the others. A file edit that does not match is not a refusal: read those lines again and redo the edit.';

/**
 * Every Story skill acts on what the engine returned, never on its own reading of a step's name,
 * kind or route, and a "does not apply to this step" refusal never stops it. Functional testing
 * found /sf-submit halting a ready intake on a source-review check intake never needs.
 */
export const APPLICABILITY_CONTRACT = 'Run a check only when a returned field or command asks for it; never decide from a step\'s name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue.';

/**
 * A step works from the approved outputs of the steps before it. `[upstream-inputs]`
 *
 * A code step asked the person what its approved plan already settled: it read the Story's one-line
 * request, not its inputs. Engine-owned like the contracts above: fixed overhead on the skills that
 * author from governed inputs, not per-skill prose.
 */
export const APPROVED_INPUTS_CONTRACT = 'Approved phase inputs are the earlier steps\' outputs and settle what they state: never ask what they answer or search elsewhere for them.';
export const approvedInputsContractApplies = (contract) => contract === 'clarification-and-artifact';

/**
 * Read `act` first; a long result is bounded, never lost. `[large-output]` `[agent-output]`
 *
 * Copilot keeps a long tool result in a file and shows the model only its start, or saves it
 * outside the workspace where its file tools cannot open it. Agents missed what to do next, stopped,
 * or treated the result as truncated. A `--for-agent` result now starts with `act` and stays
 * within a fixed size, listing every field it left out with its line range in a file in the
 * checkout's `.sflow/out/` (src/agent-output.mjs). The contract names that folder: agents that
 * guessed the older Git-directory location misread about 3% of those paths. A result its host cut off,
 * or returned while the command still ran, is read again whole with `result last --wait`, never by
 * running the command again (src/agent-result-keeper.mjs; office, 2026-10-27). Engine-owned like the
 * contracts above, on the same Story skills as the applicability contract.
 */
export const COMPLETE_OUTPUT_CONTRACT = 'Act on a result\'s `act` first: its state, `do` routes and any `ask`. View each `agentOutput.read` range and `need` text file in one response at its exact issued path in `.sflow/out/`, unless this chat already read that path (same path, same bytes); other `omittedFields` are optional. A cut-off, empty, running or inaccessible host result uses `singularity-flow result last --wait --for-agent --json`, never a command replay or shell read of the host\'s copy. Recover read-size/range failures with returned `readRequests`/`readRanges` in your file-view tool\'s parameters; finish all required ranges and continue this task. Use exact `pathCorrections`; never guess paths. Real missing-file/permission errors retain their path, native error and owner recovery route; never recreate inputs or retry unchanged access. Read `taskResume` on entry: keep its operation ID, spent budgets and exact next step across chats; obtain fresh context and local paths. Before ending, honor `taskCompletion`: input reads, preparation and diagnostic tests alone do not complete authoring or review. Preserve human decisions and explicit single-step boundaries.';

/**
 * A read skill answers through SFlow's gateway tools when the host offers them. `[gateway-tools]`
 *
 * VS Code registers `sflow_resolve`, `sflow_read`, `sflow_next`, `sflow_run` and `sflow_explain` as
 * language-model tools, and `singularity-flow gateway serve` offers them over MCP; Copilot CLI's
 * plugin registers neither. A read skill whose CLI read is the same kernel read names the tool call
 * in its step beside the command, and this one clause says how to choose. Engine-owned like the
 * contracts above (fixed overhead, not per-skill prose), on the read-turn skills `registry.yml`
 * marks `gatewayTools`. It adds no stop: an absent tool, a refusal or a missing field runs the
 * step's CLI command, and the paused answer is the pause line's own rule. The tools check pause
 * themselves (src/gateway/host.mjs `pausedToolAnswer`); `sflow_run` is refused in read turns
 * (copilot-mutation-guard.mjs) and never named here as something to call.
 */
export const GATEWAY_TOOLS_MARKER = '<!-- sflow-gateway-tools -->';
export const GATEWAY_TOOLS_CLAUSE = '**SFlow tools:** When a step names an `sflow_*` call and that tool is in your tool list, make that call once, exactly as written, instead of the step\'s CLI command, and use its answer as the step says; each next action\'s routes there are its `fallback` (`copilotCommand`, `command`), with `modelFreeCommand` from the matching `data.guidance.actions` entry when one exists. A tool call checks pause itself (its `gateway.copilot-paused` refusal carries `data.paused`), so a turn that starts with one makes no separate pause check. If the tool is absent, errors or refuses for another reason, or its answer lacks a field the step reports, run the step\'s CLI command once and finish the step with it. Never call `sflow_run` here.';
export const gatewayToolsApplies = (rule) => rule?.gatewayTools === true;

export function cliPathContractErrors(body) {
  const text = String(body ?? '');
  return [
    ...(text.split(CLI_PATH_CONTRACT).length !== 2 ? ['exactly one engine CLI path contract is required'] : []),
    ...(/cwd for every shell and file tool/u.test(text) ? ['command cwd must not be presented as a file-path prefix'] : [])
  ];
}

export function applicabilityContractApplies(rule) {
  return (rule?.executionBoundary ?? 'story') === 'story' && rule?.class !== 'delegation';
}

/**
 * Read `act` first and recover a cut-off result: every Story skill, and a repository skill whose
 * registry entry sets `completeOutput` because it relays refusals whose fix is in `act`
 * (/sf-test-setup and /sf-confirm: an office turn could not see why a test command was refused,
 * 2026-10-29).
 */
export function completeOutputApplies(rule) {
  return applicabilityContractApplies(rule) || rule?.completeOutput === true;
}

export function refusalHandlingApplies(rule) {
  return ['generative', 'mutation'].includes(rule?.class) && (rule?.executionBoundary ?? 'story') === 'story';
}

export function authoringTurnApplies(rule) {
  return rule?.class === 'generative';
}

/** The refusal, automatic-action and authoring-turn contracts a skill carries, as one engine-owned text, or null. */
export function refusalContractFor(rule, name = null) {
  const parts = [refusalHandlingApplies(rule) ? REFUSAL_HANDLING_CONTRACT : null,
    name && automaticActionApplies(name, rule) ? AUTOMATIC_ACTION_CONTRACT : null,
    authoringTurnApplies(rule) ? AUTHORING_TURN_CONTRACT : null].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

export const ARTIFACT_PRESENTATION_CONTRACT = 'Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval.';

const CONTRACT_TEXT = Object.freeze({
  'guided-actions': 'Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.',
  'concise-relay': 'Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below.',
  'explicit-selection': 'Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.',
  'conversational-guidance': 'Resolve ordinary language through durable Home and Next projections; reads may run immediately, while every mutation requires an explicit governed choice.',
  'governed-review': 'Present artifact references, hashes, identity warnings, and the exact confirmation before recording any decision.',
  'clarification-and-artifact': 'Author configured artifacts from governed inputs and pinned clarification; publish only after readiness.',
  'deterministic-mutation': 'Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.',
  'scoped-repair': 'Repair only the named local scope; report changes and remaining findings. Never publish, submit, or approve.',
  'advisory-analysis': 'Run only the confirmed advisory analysis; report its evidence and limitations. Do not promote or publish governed artifacts.',
  'canonical-delegation': 'Run the canonical skill once and preserve its result and handoff; do not repeat its preflight, authoring, or publication.'
});

// Preserve narrower task contracts and compact equivalents when the class default is too broad.
const CONTRACT_TEXT_BY_SKILL = Object.freeze({
  'sflow-approve': 'Require human review of exact bound documents outside chat; refresh packet and explicit consent.',
  'sflow-start': 'Explicit choices; no preselection; preserve errors/artifacts/actions.',
  'sflow-recover': 'CLI validates/mutates; preserve exact results, warnings, publication status, artifacts/actions.',
  'sflow-submit': 'Show artifact references, hashes, warnings, and confirmation before a decision.',
  'sflow-refresh-configuration': "Preserve the CLI's exact plan, conflicts, branch effects, failures, and retry instructions.",
  'sflow-review-source': 'Show the exact reviewed hashes, cited gaps, exclusions, questions, and test exceptions before any human approval.',
  'sflow-revision-attachments': "Preserve the CLI's exact result, warnings, effects, and next actions.",
  'sflow-skill': "Report the CLI's exact package identity, candidates, findings, and limits. Inspection is not confirmation, configuration approval, host admission, or execution."
});

const KERNEL_MODEL_POLICIES = new Set(['never', 'conditional']);
// The boundary is the minimum durable context a skill needs before it can do anything. `machine`
// may narrow to an explicitly selected repository, and `repository` may narrow to an active Story;
// neither direction permits filesystem discovery. Organisation operations are rooted in an exact
// lead authority rather than in whichever checkout happens to be open.
const EXECUTION_BOUNDARY_KINDS = new Set(['machine', 'repository', 'story', 'organisation']);
const MODEL_OPERATION_PATTERNS = Object.freeze({
  'auto.flight-step': /\bsingularity-flow\s+auto\s+flight-step\b/,
  'auto.plan': /\bsingularity-flow\s+auto\s+plan\b/,
  'auto.repair': /\bsingularity-flow\s+auto\s+repair\b/,
  'copilot.launch': /\bsingularity-flow\s+copilot\b/,
  'explain.code.narrate': /\bsingularity-flow\s+explain\s+code\b[^\n`]*--narrate\b/,
  'explain.subject.narrate': /\bsingularity-flow\s+explain\s+--subject\b[^\n`]*--narrate\b/,
  'next.orchestrate': /\bsingularity-flow\s+next\b/,
  'pr.describe.polish': /\bsingularity-flow\s+pr\s+describe\b[^\n`]*--polish\b/,
  'process.run.model': /\bsingularity-flow\s+process\s+run\b[^\n`]*--allow-model\b/,
  'process.step.model': /\bsingularity-flow\s+process\s+step\b[^\n`]*--allow-model\b/,
  'spec.analyze.assisted': /\banalyze\s+--assisted\b/,
  'story.enhance-description': /\bsingularity-flow\s+story\s+enhance-description\b/,
  'story.converge.assisted': /\bstory\s+converge\b[^\n`]*--assisted\b/,
  'wm.brief.polish': /\bwm\s+brief\b[^\n`]*--polish\b/,
  'wm.knowledge.brief': /\bwm\s+knowledge\s+brief\b(?![^\n]*(?:--dry-run|--cached))/,
  'wm.knowledge.explain': /\bwm\s+knowledge\s+explain\b(?![^\n]*--dry-run)/,
  'wm.rules.propose': /\bwm\s+rules\s+propose\b(?![^\n]*--dry-run)/,
  'workspace.copilot': /\bsingularity-flow\s+workspace\s+copilot\b/,
  'workspace.impact.analyze': /\bsingularity-flow\s+workspace\s+impact\s+analyze\b/
});

// Inline code that starts with a registered command root and includes an operand/subcommand is
// executable guidance, not a conceptual label. Requiring the binary prefix keeps copied commands
// valid after Copilot context resets and prevents regressions such as `phase show` or `recover
// <WORK-ID>` being interpreted as shell programs. Single-word vocabulary labels remain allowed.
export function bareOperationalCommands(body, commandRoots = new Set(operationCatalog().map((entry) => entry.command))) {
  const matches = [];
  for (const match of body.matchAll(/`([^`\r\n]+)`/g)) {
    const value = match[1].trim();
    if (!/\s/.test(value) || value.startsWith('singularity-flow ')) continue;
    const root = value.split(/\s+/, 1)[0];
    if (commandRoots.has(root)) matches.push(value);
  }
  return [...new Set(matches)].sort();
}

/** Aliases have one executable owner, including after their direct /sf-* transformation. */
export function skillDelegationErrors(name, body, skills) {
  const rule = skills[name];
  if (rule?.class !== 'delegation') return rule?.delegatesTo ? ['only delegation skills may declare delegatesTo'] : [];
  const errors = [];
  const target = rule.delegatesTo;
  if (!target || !skills[target]) errors.push('delegation must name an existing canonical skill');
  else {
    const routes = [`/${target}`, `/${target.replace(/^sflow-/, 'sf-')}`];
    if (!routes.some((route) => body.includes(`\`${route}\``))) errors.push('body must route to its declared canonical skill');
    const visited = new Set([name]);
    for (let next = target; next; next = skills[next]?.delegatesTo) {
      if (visited.has(next)) { errors.push('delegation cycle'); break; }
      visited.add(next);
    }
  }
  if (/`singularity-flow\s/.test(body)) errors.push('delegation must not duplicate CLI preflight or operations');
  return errors;
}

// These are cross-surface contracts, not style preferences. A skill can have valid frontmatter,
// remain inside its token budget, and still send Copilot down a command form the CLI rejects or
// perform a mutation before its promised review. Keep the small set of high-risk invariants in the
// fast checker so `install.sh --skip-tests` cannot package that drift.
const SKILL_SEMANTIC_CONTRACTS = Object.freeze({
  'sflow-impact': {
    required: [/singularity-flow impact evidence collect <PROVIDER> <FILE>/],
    forbidden: [/use `evidence collect <PROVIDER> <FILE>/]
  },
  'sflow-documents': {
    required: [
      /documents detach <DOCUMENT-ID>[^`]*--yes/,
      /epic sources detach <SOURCE-ID>[^`]*--yes/,
      /Only after it/
    ]
  },
  'sflow-upload': {
    required: [
      /Delegate once to `\/sf-documents`/,
      /mapping `attach` to `upload`/,
      /preserving paths, names, owner selectors/,
      /Do not repeat a preview/
    ],
    forbidden: [/`singularity-flow (?:documents|epic sources) (?:upload|add|detach)/]
  },
  'sflow-revision-attachments': {
    required: [
      /REV_CHAT_ATTACHMENT_UNAVAILABLE/,
      /singularity-flow revision attachments capabilities --json/,
      /singularity-flow revision attachments preview --file <LOCAL-FILE> --feedback/,
      /singularity-flow revision attachments register --file <LOCAL-FILE> --feedback[^`]*--confirm sha256:<PLAN> --json/,
      /not an open REV loop/,
      /does not start a revision/
    ]
  },
  'sflow-epic-publish': {
    required: [/epic jira apply --epic <EPIC-KEY> --plan <SHA-256> --confirm <EPIC-KEY>/]
  },
  'sflow-epic-complete': {
    required: [/epic complete <EPIC-KEY> --confirm <EPIC-KEY>/]
  },
  'sflow-initiative-materialize': {
    required: [
      /initiative breakdown --initiative <INIT-ID> --json/,
      /initiative materialize --initiative <INIT-ID> --dry-run --json/,
      /initiative materialize --initiative <INIT-ID> --confirm <INIT-ID> --json/
    ],
    forbidden: [/no bypass flag/i]
  },
  'sflow-submit': {
    required: [
      /Fingerprint refusal plus artifact\/check hashes and diagnosed runtime evidence/i,
      /Stop on an unchanged condition or after three distinct repairs/i,
      /environment repair permits retry without republishing unchanged source/i,
      /changed source\/artifacts need reviewed rollover/i,
      /Never loop quality commands/i
    ]
  },
  'sflow-review-source': {
    required: [
      /reviewGuide\.readOrder/,
      /reportTemplate\.binding/,
      /reportTemplate.*reportSchema/,
      /stagingProtocol/,
      /file-edit tool/,
      /kernelStage/,
      /review-source check <phase> --report-file/,
      /at most two changed-packet repair attempts/,
      /Never mark a real gap supported merely to pass validation/,
      /`retentionReady` is false.*stop without commit\/push/s
    ]
  },
  'sflow-publish': {
    required: [/phase prepublish <phase> --for-agent --json/, /returned `commands\.publish` once/,
      /never edit source\/artifacts/i, /Never advance to the next phase/]
  },
  'sflow-phase': {
    required: [/successor-preparation-required/, /successor\.preparation\.command/,
      /preserve private drafts\/publications/, /refresh entry once/, /unless prepared in step 2/]
  },
  'sflow-code': {
    required: [
      /singularity-flow phase begin <phase> --json/,
      /Consumed intent requires `\/sf-recover`/,
      /Untracked `\.sflow\/results\/\*\*` need no cleaning/,
      /proven runtime repair permits retry without source changes/i,
      /Nonzero exit fails despite passing JUnit/,
      /run `checkpoint\.newQuestionAction` alone/,
      /singularity-flow upstream-issue raise --from-artifact/
    ]
  },
  'sflow-code-docs': {
    required: [/sflow-output-contract: scoped-repair/, /Never publish, submit or approve/],
    forbidden: [/sflow-output-contract: clarification-and-artifact/, /`singularity-flow phase publish/]
  },
  'sflow-regression-investigate': {
    required: [/sflow-output-contract: guided-actions/],
    forbidden: [/sflow-output-contract: clarification-and-artifact/]
  },
  'sflow-workspace-impact': {
    required: [/sflow-output-contract: advisory-analysis/, /Do not promote automatically/],
    forbidden: [/sflow-output-contract: clarification-and-artifact/]
  },
  'sflow-specify': { required: [/sflow-output-contract: clarification-and-artifact/] },
  'sflow-plan': { required: [/sflow-output-contract: clarification-and-artifact/] },
  'sflow-recover': {
    required: [
      /Follow action classifications, not blanket dirty-tree stops/,
      /tracked\/staged reports and source require review/,
      /dependency repair permits retry without republishing unchanged source/,
      /Stop on unchanged conditions or three distinct repairs/
    ]
  },
  'sflow-decide': {
    required: [
      /sflow-turn-boundary: decision-only/i,
      /are the only permitted mutations/i,
      /The person types every choice and reason; never supply, infer or default one/i,
      /Any refusal ends this turn/i,
      // SPEC-OAP M4: it continues into the approval instead of ending, and carries choices into its one commit.
      /you may approve \(`decidedBy\.allowed`\): do \/sf-approve 1-6 now/,
      /do \/sf-approve 1-6 now with `withApproval\.flags` on its approve command \(one commit\)/,
      /if `data\.remaining` is only `approval`, do \/sf-approve 1-6 now/
    ]
  },
  'sflow-approve': {
    required: [
      /sflow-turn-boundary: approval-only/i,
      /explicit human phase ID confirms only the unchanged packet already reviewed in this conversation/i,
      /approval CLI is the sole permitted lifecycle mutation/i,
      /positional argument selects \*\*PHASE-ID\*\*, never Work ID/i,
      /Review outside chat against the exact binding/i,
      // Show advisory history; actual gate holds route to their owners before confirmation.
      /`approvalCheck`\/`blockingCommits`\. Only holds block; follow routes/,
      /`reason: approval-holds`: relay `sheet\.holds`, all three `act\.do` routes; no document reads or confirmation/,
      // A checklist phase is approved from Copilot too: the person's answers travel with the approval.
      /`approvalChecklist` lists articles, ask for one answer per article[^.]*--article <ID>=<DECISION>/,
      /exactly matching non-null `displayBinding`/,
      /New chat, changed\/null binding, omissions or truncation require fresh human review/i,
      /A phase supplied before a new or changed packet review is not its confirmation/i,
      /document reuse never reuses approval consent/i,
      // SPEC-OAP M4: decisions chosen in /sf-decide land in the approval's one commit.
      /From \/sf-decide 14, add its `withApproval\.flags` \(decisions in this commit\)/,
      /do not ask again/i,
      /Never edit repository files, run tests\/builds\/raw Git, delegate, submit, or begin\/author another phase/i,
      /failed approval ends this turn/i,
      /approval CLI advances and activates the next phase when the threshold is met/i,
      /end this turn before next-phase authoring/i
    ]
  },
  'sflow-converge': {
    required: [
      /sflow-output-contract: clarification-and-artifact/,
      /route-only result is not the final response when the checkpoint is `deterministic-generation`/i,
      /execute that exact returned preparation command once in this same turn/i,
      /Do not stop after merely displaying the route/i,
      /do not run `singularity-flow converge --json` again/i,
      // Adjudication is the person's choice, asked and recorded in this turn (2026-10-27): relaying it
      // offered /sf-converge, this same skill, as its only Copilot route, and the turn stopped again.
      /For adjudication, show each item[^.]*ask the person one `ask_user` question per item[^.]*never preselect one/i,
      /Record each answer with `singularity-flow story adjudicate/i,
      /For rework, intent amendment, or inspection, relay the action and stop for the human decision/i,
      /If and only if it returns deterministic convergence publication as the first `NOW` action/i,
      /using the exact returned publication command/i,
      /Stop immediately after publication; never advance, submit, approve/i
    ]
  },
  'sflow-next': {
    required: [
      /First run `singularity-flow nextsteps --for-agent --json`/i,
      /Never run `singularity-flow next`/,
      /returned SFlow skill route \(any `\/sf-\*` or `\/sflow-\*` route\)/i,
      /complete its preflight[^.]*execute at most its one authorized action/i,
      /state=publication_pending[^.]*first `NOW` command equals `singularity-flow sync`/i,
      /singularity-flow sync <WORK-ID>[^.]*once in the verified cwd/i,
      /never follow `THEN`, invoke `\/sf-nextsteps` or `\/sf-next`, or retry/i,
      /Relay, never run, human-decision routes \(`\/sf-approve`, `\/sf-confirm`, `\/sf-decide`, `\/sf-review-decide`[^)]*\): the person types them/i,
      /On failure follow `remediationPlan`'s first read-only step/i,
      /copy the first `NOW` action's `copilotCommand` and `command` from that same action object/i,
      /never pair `\/sf-phase` with `singularity-flow next`/i
    ],
    forbidden: [
      /Then run `singularity-flow next` once/i,
      /run `phase show <phase> --for-agent --json`/i,
      /run `recover`/i,
      /Before approval run `singularity-flow phase show/i
    ]
  },
  'sflow-workflow-rules': {
    required: [
      /Never run `singularity-flow next`/,
      /singularity-flow nextsteps <WORK-ID> (?:--for-agent )?--json/,
      /returned SFlow skill route/,
      /Repository brief is guidance/i
    ],
    forbidden: [
      /if stale, build and recompose identically/i,
      /Run `singularity-flow next` only when/i,
      /repository contains `singularity\/work-items`/i
    ]
  }
});

// SFlow finds the bound Story's checkout (session binding, Story index) from a folder outside any
// Git repository. Read alone, "cwd=repositoryPath" made a VS Code agent-host chat, which runs in its
// own folder and cannot change it, refuse /sf-inputs and wrap /sf-submit until refused (2026-10-26).
const STORY_CWD = 'cwd=`repositoryPath`, or as is from a non-Git (chat) folder: SFlow finds the bound checkout; never refuse or wrap for it';

function executionBoundary(kind = 'story', name = '') {
  if (name === 'sflow-start') return '**Boundary:** no Story required; reuse entry `repositoryPath` after its workspace/clean-tree checks. Refuse absent/unready selections; never search `$HOME`/parents.';
  // Session attachment resolves its own scope, and its returned selectors need no checkout: a chat with
  // no folder open (a non-Git cwd) attaches as given. Read as "cd first", the generic cwd rule stopped it.
  if (name === 'sflow-session') return '**Boundary:** no Story required; any cwd, even a non-Git chat folder: `open` resolves the opened Git root or selected workspace, and a command carrying `selectors` (`--workspace`, `--repository`) needs no checkout; never `cd` for it; refuse if none resolves; never search `$HOME`/parents.';
  if (name === 'sflow-review-source') return '**Boundary:** reuse this invocation\'s review entry: require `ready`/`workId`, valid `phaseAgent`; ' + STORY_CWD + '. Use returned `workItemRoot`/artifact and Git-private staging paths; never `$HOME`.';
  if (['sflow-next', 'sflow-inputs'].includes(name)) return '**Boundary:** reuse this invocation\'s entry: require `ready`/`workId`, valid `phaseAgent` for active phases; ' + STORY_CWD + '. Use returned `workItemRoot`/artifact paths; never `$HOME`.';
  if (PHASE_ENTRY_SKILLS.includes(name)) return '**Boundary:** reuse entry `ready`/`workId`, valid `phaseAgent`; ' + STORY_CWD + '. Honor `mutationContract`. Returned `workItemRoot`/artifact paths only; never `$HOME`.';
  if (kind === 'machine') {
    return '**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.';
  }
  if (kind === 'repository') {
    return '**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.';
  }
  if (kind === 'organisation') {
    return '**Boundary:** no Story or repository required; use only the selected lead URL. Resolve local checks with `singularity-flow workspace current --json`; never search `$HOME`.';
  }
  // A relative artifact path is not a usable boundary after Copilot `/clear`: the host can retain
  // its process cwd while the model loses the conversational repository hint. Resolve the selected
  // Story checkout on every skill invocation and make its absolute path the command cwd, not a
  // prefix for CLI-issued file paths. `ready` and `workId` are checked before mutation so a stale workspace lead cannot silently
  // replace the Story selected before `/clear`. Keeping this generated makes the rule catalog-wide.
  if (kind === 'story') {
    return '**Boundary:** reuse entry `ready`/`workId`, ' + STORY_CWD + '; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.';
  }
  throw new Error(`unknown skill execution boundary '${kind}'`);
}

function referencedModelOperations(body) {
  return Object.entries(MODEL_OPERATION_PATTERNS)
    .filter(([, pattern]) => pattern.test(body))
    .map(([id]) => id);
}

const AUTOMATIC_DESCRIPTIONS = Object.freeze({
  'sflow-advise': 'Guide unclear SFlow situations with grounded safe choices.',
  'sflow-help': 'Answer questions about Singularity Flow and its workflow.',
  'sflow-home': 'Guide explicitly requested Singularity Flow work through governed choices.',
  'sflow-nextsteps': 'Show ordered next actions from the current workflow state.',
  'sflow-status': 'Show the current phase, artifacts, checks, and approvals.'
});

function splitSkill(text, file) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  return { frontmatterSource: match[1], frontmatter: YAML.parse(match[1]) ?? {}, body: match[2] };
}

function estimatedTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

/**
 * A skill a person types runs in VS Code's built-in Agent, whichever agent the chat is on. `/clear`
 * opens a new chat, and VS Code takes that chat's agent from its saved draft or
 * chat.newSession.defaultMode, not from the chat it replaces; on one with no terminal, the skill's
 * first command cannot run and the turn ends "this session has no terminal tool". VS Code reads this
 * line from a slash skill's header (1.145 _applyPromptMetadata). It does not change the skill's words.
 */
export const SKILL_CHAT_AGENT = 'agent';

function withAutomaticPolicy(text, automatic, description, file) {
  const skill = splitSkill(text, file);
  let source = skill.frontmatterSource;
  source = source.replace(/^description:\s*.*$/m, `description: ${description ?? skill.frontmatter.description}`);
  source = source.replace(/^disable-model-invocation:\s*true\s*\r?\n?/m, '');
  source = source.replace(/^agent:\s*.*\r?\n?/m, '');
  const lines = source.split(/\r?\n/);
  const descriptionIndex = lines.findIndex((line) => line.startsWith('description:'));
  lines.splice(descriptionIndex + 1, 0, ...(automatic ? [] : ['disable-model-invocation: true']), `agent: ${SKILL_CHAT_AGENT}`);
  source = lines.join('\n');
  return `---\n${source}\n---\n${skill.body}`;
}

function withOutputContract(text, contract, kernelModelPolicy, file, executionBoundaryKind, refusalContract = null, applicability = false, completeOutput = applicability) {
  const skill = splitSkill(text, file);
  // Additional blocked/risk prose can separate the generated contract from its boundary. Strip
  // all maintained boundaries first so repeated generation never appends a second lookup.
  const sourceBody = skill.body.replace(/<!-- sflow-execution-boundary -->\r?\n\*\*(?:Execution boundary|Boundary):\*\*[^\n]*\r?\n?/gu, '');
  const marker = `<!-- sflow-output-contract: ${contract} -->`;
  const contractText = `**Output contract:** ${CONTRACT_TEXT_BY_SKILL[path.basename(path.dirname(file))] ?? CONTRACT_TEXT[contract]}${approvedInputsContractApplies(contract) ? ` ${APPROVED_INPUTS_CONTRACT}` : ''} ${ARTIFACT_PRESENTATION_CONTRACT} ${COMMAND_PRESENTATION_CONTRACT}${refusalContract ? ` ${refusalContract}` : ''}${applicability ? ` ${APPLICABILITY_CONTRACT}` : ''}${completeOutput ? ` ${COMPLETE_OUTPUT_CONTRACT}` : ''}`;
  const boundaryMarker = '<!-- sflow-execution-boundary -->';
  const boundaryText = `${executionBoundary(executionBoundaryKind, path.basename(path.dirname(file)))} ${CLI_PATH_CONTRACT}`;
  if (!CONTRACT_TEXT[contract]) throw new Error(`${file}: unknown output contract '${contract}'`);
  const existing = /<!-- sflow-output-contract: [^>]+ -->\r?\n(?:\*\*Output contract:\*\*[^\n]*\r?\n?)?(?:<!-- sflow-execution-boundary -->\r?\n)?(?:\*\*(?:Execution boundary|Boundary):\*\*[^\n]*\r?\n?)*/;
  const rendered = `${marker}\n${contractText}\n${boundaryMarker}\n${boundaryText}\n`;
  let body;
  if (existing.test(sourceBody)) {
    body = sourceBody.replace(existing, rendered);
  } else {
    const heading = sourceBody.match(/^# .+$/m);
    if (!heading) throw new Error(`${file}: missing H1 heading for output contract`);
    const end = heading.index + heading[0].length;
    body = `${sourceBody.slice(0, end)}\n\n${rendered}${sourceBody.slice(end)}`;
  }
  return `---\n${skill.frontmatterSource}\n---\n${body}`;
}

function withCopilotPauseGuard(text, enabled, file, name, boundary) {
  const skill = splitSkill(text, file);
  let body = skill.body.replace(/<!-- sflow-copilot-pause -->\r?\n[^\r\n]*\r?\n\r?\n?/gu, '');
  if (enabled) body = body.replace(/^(# .+)$/mu, `$1\n\n${COPILOT_PAUSE_MARKER}\n${copilotPauseGuardForSkill(name, boundary)}`);
  return `---\n${skill.frontmatterSource}\n---\n${body}`;
}

/** The clause sits directly under the pause line it amends; regeneration is idempotent. */
function withGatewayToolsClause(text, enabled, file) {
  const skill = splitSkill(text, file);
  let body = skill.body.replace(/<!-- sflow-gateway-tools -->\r?\n[^\r\n]*\r?\n\r?\n?/gu, '');
  if (enabled) {
    const pause = /(<!-- sflow-copilot-pause -->\r?\n[^\r\n]*\r?\n)/u;
    if (!pause.test(body)) throw new Error(`${file}: the gateway-tools clause needs the pause line it amends`);
    body = body.replace(pause, `$1\n${GATEWAY_TOOLS_MARKER}\n${GATEWAY_TOOLS_CLAUSE}\n`);
  }
  return `---\n${skill.frontmatterSource}\n---\n${body}`;
}

/**
 * What a selectable authoring skill must say, checked on every catalog entry except `/sf-code` (the
 * only code skill, which checks code delivery itself and is never routed past).
 *
 * Step 1 re-reads the step's verified route: it stops, showing `policyReason`, when `policyVerified`
 * is false, and continues only on its own route — `/sf-phase` relays any step routed elsewhere, and
 * a specialised skill continues only when `effectiveAuthoringSkill` is itself or, for exactly its
 * catalog `legacyPhases`, the automatic `/sf-phase` route of an unchosen built-in step. Commands
 * name `<phase>`, never one of those step ids, and the last step ends with the engine's `handoff`.
 * Guidance safety admits any catalog skill for a step's commands on the strength of this check.
 */
/**
 * A turn-boundary marker documents the mode the mutation guard enforces, which it takes from the
 * skill's name. A marker that names another mode promises a boundary nothing enforces.
 */
export function turnBoundaryErrors(name, body) {
  return [...String(body ?? '').matchAll(/<!-- sflow-turn-boundary: ([a-z-]+) -->/gu)]
    .filter(([, mode]) => mode !== mutationTurnMode(name))
    .map(([, mode]) => `${name}: turn-boundary marker '${mode}' differs from the enforced turn mode '${mutationTurnMode(name)}'`);
}

export function authoringSkillContractErrors(entry, body) {
  if (!entry) return [];
  const errors = [];
  for (const required of ['`clarification.checkpoint`', 'missing answers permit questions, not drafting',
    'Never ask users to supply questions or slice control instructions']) {
    if (!body.includes(required)) errors.push(`selectable authoring skills must preserve the shared checkpoint instruction '${required}'`);
  }
  for (const required of ['Preparation is not authoring', 'native file-edit tool']) {
    if (!body.toLowerCase().includes(required.toLowerCase())) errors.push(`authoring must explicitly distinguish preparation and writing: '${required}'`);
  }
  if (/Stop on placeholders\/templates\/padding/i.test(body)) {
    errors.push('prepared template placeholders are authoring work, not a stopping condition');
  }
  if (entry.id === 'sf-code') return errors;
  const steps = [...body.matchAll(/^(\d+)\. (.*)$/gmu)];
  const first = steps.find((match) => match[1] === '1')?.[2] ?? '';
  const last = steps.at(-1)?.[2] ?? '';
  if (/singularity-flow (?:pause status|session current|clarification status|story references verify)/u.test(body)) {
    errors.push('selectable authoring skills must reuse phase entry instead of duplicate context lookups');
  }
  for (const required of ['entry `authoring`', '`policyVerified`', '`policyReason`']) {
    if (!first.includes(required)) errors.push(`step 1 of a selectable authoring skill must include '${required}'`);
  }
  if (entry.id === 'sf-phase') {
    if (!first.includes('`effectiveAuthoringSkill` is not `/sf-phase`')) {
      errors.push("step 1 of the automatic authoring skill must relay any step whose `effectiveAuthoringSkill` is not `/sf-phase`");
    }
  } else {
    const own = `\`effectiveAuthoringSkill\` is \`/${entry.id}\``;
    if (!first.includes(own)) errors.push(`step 1 of a selectable authoring skill must continue only when ${own}`);
    const declared = [...first.matchAll(/`<phase>` = `([a-z0-9-]+)`/gu)].map((match) => match[1]).sort();
    if (JSON.stringify(declared) !== JSON.stringify([...entry.legacyPhases].sort())) {
      errors.push(`step 1 must accept exactly the catalog's built-in steps (${entry.legacyPhases.join(', ') || 'none'}), not ${declared.join(', ') || 'none'}`);
    }
    if (entry.legacyPhases.length && !first.includes('`/sf-phase` with `authoringSkill` null')) {
      errors.push('step 1 must accept a built-in step only on its automatic `/sf-phase` route with `authoringSkill` null');
    }
  }
  if (!['`handoff`', '`copilotCommand`', '`command`'].every((required) => last.includes(required))) {
    errors.push('the last step of a selectable authoring skill must end with each engine `handoff` from its `copilotCommand` and `command`');
  }
  for (const span of body.matchAll(/`([^`\n]+)`/gu)) {
    const words = span[1].trim().split(/\s+/u);
    if (!/^(?:singularity-flow|sflow|\/sf-[a-z0-9-]+)$/u.test(words[0])) continue;
    const literal = words.slice(1).map((word) => word.replace(/^--phase=/u, '')).find((word) => entry.legacyPhases.includes(word));
    if (literal) errors.push(`selectable authoring skill must use <phase>, not the built-in step id '${literal}', in \`${span[1]}\``);
  }
  return errors;
}

export async function loadSkillPolicy(repositoryRoot) {
  const file = path.join(repositoryRoot, 'plugin', 'skills', 'registry.yml');
  const policy = YAML.parse(await readFile(file, 'utf8'));
  if (policy?.version !== 1) throw new Error('plugin/skills/registry.yml version must be 1');
  return { file, policy };
}

/** Presentation must not expand a review summary into another full artifact/code dump. */
export function artifactPresentationContractErrors(body) {
  const errors = [];
  if (!body.includes(ARTIFACT_PRESENTATION_CONTRACT)) errors.push('missing concise artifact presentation contract');
  const stale = [
    /(?:render|reproduce|display) (?:its returned text|every (?:generated |published )?text document|every document\/brief)[^.\n]*\bin full\b/i,
    /(?:Render|render) every (?:text\/brief|text document\/brief|document\/brief)[^.\n]*BEGIN <path>/,
    /(?:require|requires) full display/i,
    /Reproduce the complete Markdown summary/i,
    /show all [^.\n]*documents[^.\n]*in full/i,
    /Reproduce the complete command output in the visible assistant response/i
  ];
  if (stale.some(pattern => pattern.test(body))) errors.push('full artifact display instruction conflicts with concise Copilot presentation');
  return errors;
}

/** Commands a skill names that the CLI refuses before running anything: unknown or removed. */
export function unrunnableCommands(body) {
  const found = [];
  for (const match of String(body).matchAll(/(?:^|[\s`(])singularity-flow\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/gmu)) {
    const [, command, subcommand] = match;
    // `version` is answered by the entry point before the registry.
    if (command !== 'version') { try { canonicalCommand(command); } catch { found.push(`singularity-flow ${command}`); continue; } }
    if (['wm', 'world-model'].includes(command) && subcommand && REMOVED_WORLD_MODEL_SUBCOMMANDS.has(subcommand)) {
      found.push(`singularity-flow ${command} ${subcommand}`);
    }
  }
  return [...new Set(found)];
}

/**
 * Story step commands whose step is a seeded step ID instead of the step the engine returned.
 * Steps are copied, renamed and custom; a literal ID misfires everywhere but the seeded workflow.
 */
export function seededStepArguments(body, seededSteps) {
  const found = [];
  const stepCommand = /singularity-flow\s+(?:prepare|submit|approve|phase\s+(?:show|enter|prepublish|publish|draft-check|begin)|review-source\s+(?:status|context|decision-context|stage|check|submit|decide))\s+([a-z][a-z0-9-]*)\b/gu;
  for (const match of String(body).matchAll(stepCommand)) if (seededSteps.has(match[1])) found.push(match[0]);
  for (const match of String(body).matchAll(/singularity-flow\s+(?!initiative\b|epic\b)[^`\n]*?--phase\s+([a-z][a-z0-9-]*)\b/gu)) {
    if (seededSteps.has(match[1])) found.push(match[0].slice(0, 100));
  }
  return [...new Set(found)];
}

export async function auditSkillPolicy(repositoryRoot, { write = false } = {}) {
  const { policy } = await loadSkillPolicy(repositoryRoot);
  const skillRoot = path.join(repositoryRoot, 'plugin', 'skills');
  const directories = (await readdir(skillRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const registered = Object.keys(policy.skills ?? {}).sort();
  const errors = [];
  const warnings = [];
  const rows = [];
  const automatic = new Set(policy.automaticInvocationAllowlist ?? []);
  const catalogModelOperations = operationCatalog()
    .filter((entry) => entry.modelPolicy !== 'never')
    .map((entry) => entry.id)
    .sort();
  const commandRoots = new Set(operationCatalog().map((entry) => entry.command));
  const seededSteps = new Set(Object.keys(YAML.parse(await readFile(path.join(repositoryRoot, 'templates', 'workflow.yml'), 'utf8'))?.phases ?? {}));
  const auditedModelOperations = Object.keys(MODEL_OPERATION_PATTERNS).sort();
  if (JSON.stringify(catalogModelOperations) !== JSON.stringify(auditedModelOperations)) {
    errors.push(`skill model-operation patterns are stale: catalog=${catalogModelOperations.join(', ')}; audit=${auditedModelOperations.join(', ')}`);
  }

  for (const missing of directories.filter((name) => !registered.includes(name))) errors.push(`${missing}: missing from skill registry`);
  for (const stale of registered.filter((name) => !directories.includes(name))) errors.push(`${stale}: registry entry has no skill directory`);
  for (const name of automatic) if (!registered.includes(name)) errors.push(`${name}: automatic allowlist entry is not registered`);
  // Every skill a step may name as its drafter must be a packaged, registered skill.
  let authoringSkills = [];
  try {
    authoringSkills = parseAuthoringSkills(AUTHORING_SKILL_DECLARATION, { registeredSkills: new Set(registered) });
  } catch (error) {
    errors.push(`src/authoring-skills.mjs: ${error.message}`);
  }

  for (const name of directories) {
    const rule = policy.skills?.[name];
    if (!rule) continue;
    const classPolicy = policy.classes?.[rule.class];
    if (!classPolicy) {
      errors.push(`${name}: unknown class '${rule.class}'`);
      continue;
    }
    if (!Number.isInteger(classPolicy.previewBytes) || classPolicy.previewBytes < 1 || classPolicy.previewBytes > 65536) errors.push(`${name}: class previewBytes must be from 1 through 65536`);
    if (classPolicy.hardMaximumBytes !== 65536) errors.push(`${name}: class hardMaximumBytes must be exactly 65536`);
    if (rule.maximumTokenOverride != null && !rule.exception) errors.push(`${name}: token override requires an exception reason`);
    const kernelModelPolicy = rule.kernelModelPolicy ?? classPolicy.kernelModelPolicy;
    const executionBoundaryKind = rule.executionBoundary ?? 'story';
    if (!KERNEL_MODEL_POLICIES.has(kernelModelPolicy)) errors.push(`${name}: kernelModelPolicy must be never or conditional`);
    if (!EXECUTION_BOUNDARY_KINDS.has(executionBoundaryKind)) {
      errors.push(`${name}: executionBoundary must be machine, repository, story, or organisation`);
      continue;
    }
    const file = path.join(skillRoot, name, 'SKILL.md');
    // Delegations do no preflight; their canonical owner checks pause. The control itself must
    // remain usable while paused. This fixed shared guard is not extra domain prose allowance.
    const pauseGuardRequired = name !== 'sflow-pause' && rule.class !== 'delegation';
    let text = await readFile(file, 'utf8');
    if (write) {
      text = withAutomaticPolicy(text, automatic.has(name), AUTOMATIC_DESCRIPTIONS[name], file);
      text = withOutputContract(text, classPolicy.outputContract, kernelModelPolicy, file, executionBoundaryKind, refusalContractFor(rule, name), applicabilityContractApplies(rule), completeOutputApplies(rule));
      text = withCopilotPauseGuard(text, pauseGuardRequired, file, name, executionBoundaryKind);
      text = withGatewayToolsClause(text, gatewayToolsApplies(rule), file);
      await writeFile(file, text);
    }
    const skill = splitSkill(text, file);
    for (const message of skillDelegationErrors(name, skill.body, policy.skills)) errors.push(`${name}: ${message}`);
    const bodyTokens = estimatedTokens(skill.body);
    const pathContractText = ` ${CLI_PATH_CONTRACT}`;
    const domainBody = skill.body.replace(pathContractText, '');
    const domainBodyTokens = estimatedTokens(domainBody);
    const descriptionTokens = estimatedTokens(skill.frontmatter.description);
    // The shared command-presentation requirement is fixed engine-owned overhead, not an
    // allowance to grow per-skill prose. Report both budgets and keep the existing domain cap.
    const commandPresentationTokens = estimatedTokens(` ${COMMAND_PRESENTATION_CONTRACT}`);
    const artifactPresentationTokens = estimatedTokens(` ${ARTIFACT_PRESENTATION_CONTRACT}`);
    const refusalHandling = refusalHandlingApplies(rule);
    const authoringTurn = authoringTurnApplies(rule);
    const refusalText = refusalContractFor(rule, name);
    const refusalHandlingTokens = refusalText ? estimatedTokens(` ${refusalText}`) : 0;
    const applicability = applicabilityContractApplies(rule);
    // Measured in this body like the approved-inputs contract, so a longer shared contract never
    // moves a skill's own prose count by rounding.
    const applicabilityText = ` ${APPLICABILITY_CONTRACT} ${COMPLETE_OUTPUT_CONTRACT}`;
    const completeOutputOnly = !applicability && completeOutputApplies(rule);
    const completeOutputText = ` ${COMPLETE_OUTPUT_CONTRACT}`;
    const applicabilityTokens = completeOutputOnly
      ? (domainBody.includes(completeOutputText) ? domainBodyTokens - estimatedTokens(domainBody.replace(completeOutputText, '')) : estimatedTokens(completeOutputText))
      : !applicability ? 0 : domainBody.includes(applicabilityText)
        ? domainBodyTokens - estimatedTokens(domainBody.replace(applicabilityText, '')) : estimatedTokens(applicabilityText);
    const approvedInputs = approvedInputsContractApplies(classPolicy.outputContract);
    // Measured in this body, so rounding a separate estimate never moves the skill's own prose count.
    const approvedInputsTokens = approvedInputs && domainBody.includes(` ${APPROVED_INPUTS_CONTRACT}`)
      ? domainBodyTokens - estimatedTokens(domainBody.replace(` ${APPROVED_INPUTS_CONTRACT}`, '')) : 0;
    const pauseGuard = copilotPauseGuardForSkill(name, executionBoundaryKind);
    const pauseGuardTokens = pauseGuardRequired ? estimatedTokens(`${COPILOT_PAUSE_MARKER}\n${pauseGuard}\n\n`) : 0;
    const gatewayTools = gatewayToolsApplies(rule);
    const gatewayToolsTokens = gatewayTools ? estimatedTokens(`${GATEWAY_TOOLS_MARKER}\n${GATEWAY_TOOLS_CLAUSE}\n\n`) : 0;
    // Fixed engine-owned path safety, not permission to expand domain-specific skill prose.
    const pathContractTokens = skill.body.includes(pathContractText) ? bodyTokens - domainBodyTokens : 0;
    // So is the cwd rule's non-Git-folder clause (STORY_CWD), beyond the `cwd=` it replaced.
    const storyCwdTokens = skill.body.includes(STORY_CWD) ? estimatedTokens(STORY_CWD) - estimatedTokens('cwd=`repositoryPath`') : 0;
    const maximum = (rule.maximumTokenOverride ?? classPolicy.maximumTokens) + commandPresentationTokens + artifactPresentationTokens + refusalHandlingTokens + applicabilityTokens + approvedInputsTokens + pauseGuardTokens + gatewayToolsTokens + pathContractTokens + storyCwdTokens;
    const marker = `<!-- sflow-output-contract: ${classPolicy.outputContract} -->`;
    const boundaryMarker = '<!-- sflow-execution-boundary -->';
    const boundaryText = executionBoundary(executionBoundaryKind, name);
    const modelOperations = referencedModelOperations(skill.body);
    if (skill.frontmatter.name !== name) errors.push(`${name}: frontmatter name must match directory`);
    if (pauseGuardRequired && (!skill.body.includes(pauseGuard)
        || skill.body.indexOf(COPILOT_PAUSE_MARKER) > skill.body.indexOf(boundaryMarker))) {
      errors.push(`${name}: pause guard must precede all repository/Story boundary lookups`);
    }
    if (rule.gatewayTools !== undefined && typeof rule.gatewayTools !== 'boolean') errors.push(`${name}: gatewayTools must be true or false`);
    if (rule.completeOutput !== undefined && rule.completeOutput !== true) errors.push(`${name}: completeOutput is true or absent`);
    if (gatewayTools && mutationTurnMode(name) !== 'read') {
      errors.push(`${name}: gatewayTools is for read-turn skills; a ${mutationTurnMode(name)} turn's tool use is not reviewed here`);
    }
    if (gatewayTools !== skill.body.includes(`${GATEWAY_TOOLS_MARKER}\n${GATEWAY_TOOLS_CLAUSE}`)) {
      errors.push(`${name}: ${gatewayTools ? 'missing' : 'unexpected'} gateway-tools clause (registry.yml gatewayTools)`);
    }
    if (gatewayTools && !/`sflow_(?:resolve|read|next|explain)`/u.test(skill.body.replace(GATEWAY_TOOLS_CLAUSE, ''))) {
      errors.push(`${name}: gatewayTools needs a step that names its sflow_* call`);
    }
    if (/`sflow_run`/u.test(skill.body.replace(GATEWAY_TOOLS_CLAUSE, ''))) errors.push(`${name}: a skill step must not name sflow_run`);
    if (skill.frontmatter.agent !== SKILL_CHAT_AGENT) errors.push(`${name}: a skill must set agent: ${SKILL_CHAT_AGENT}, so a new VS Code chat can run its commands`);
    if (automatic.has(name)) {
      if (skill.frontmatter['disable-model-invocation'] === true) errors.push(`${name}: automatic skill must not disable model invocation`);
      if (descriptionTokens > 15) errors.push(`${name}: automatic description is ${descriptionTokens} estimated tokens; maximum is 15`);
      if (rule.class === 'guided') {
        for (const required of [
          'automatic invocation is not mutation consent',
          'singularity-flow home --json --request \'$ARGUMENTS\'',
          '`ask_user`',
          'require an explicit `/sf-*` invocation'
        ]) if (!skill.body.includes(required)) errors.push(`${name}: guided automatic skill must include '${required}'`);
      }
    } else if (skill.frontmatter['disable-model-invocation'] !== true) {
      errors.push(`${name}: explicit-only skill must set disable-model-invocation: true`);
    }
    if (!skill.body.includes(marker)) errors.push(`${name}: missing '${classPolicy.outputContract}' output contract`);
    if (!skill.body.includes(COMMAND_PRESENTATION_CONTRACT)) errors.push(`${name}: missing Shell/Copilot presentation contract`);
    if (refusalHandling !== skill.body.includes(REFUSAL_HANDLING_CONTRACT)) {
      errors.push(`${name}: ${refusalHandling ? 'missing' : 'unexpected'} engine refusal-handling contract`);
    }
    if (automaticActionApplies(name, rule) !== skill.body.includes(AUTOMATIC_ACTION_CONTRACT)) {
      errors.push(`${name}: ${automaticActionApplies(name, rule) ? 'missing' : 'unexpected'} automatic-action clause (only authoring and kernel-only turns run \`sync\`)`);
    }
    if (authoringTurn !== skill.body.includes(AUTHORING_TURN_CONTRACT)) {
      errors.push(`${name}: ${authoringTurn ? 'missing' : 'unexpected'} engine authoring-turn contract`);
    }
    if (applicability !== skill.body.includes(APPLICABILITY_CONTRACT)) {
      errors.push(`${name}: ${applicability ? 'missing' : 'unexpected'} engine applicability contract`);
    }
    if (completeOutputApplies(rule) !== skill.body.includes(COMPLETE_OUTPUT_CONTRACT)) {
      errors.push(`${name}: ${completeOutputApplies(rule) ? 'missing' : 'unexpected'} engine complete-output contract`);
    }
    if (approvedInputs !== skill.body.includes(APPROVED_INPUTS_CONTRACT)) {
      errors.push(`${name}: ${approvedInputs ? 'missing' : 'unexpected'} engine approved-inputs contract`);
    }
    for (const message of artifactPresentationContractErrors(skill.body)) errors.push(`${name}: ${message}`);
    if (!skill.body.includes(boundaryMarker) || !skill.body.includes(boundaryText)) errors.push(`${name}: missing generated execution boundary`);
    for (const message of cliPathContractErrors(skill.body)) errors.push(`${name}: ${message}`);
    if (skill.body.split(boundaryMarker).length !== 2) errors.push(`${name}: exactly one generated execution boundary is required`);
    if (skill.body.includes('singularity/work-items/<WORK-ID>')) {
      errors.push(`${name}: hard-codes the default Story root instead of using immutable workflow.resolution.workItemRoot or a CLI-returned path`);
    }
    const unrunnable = unrunnableCommands(skill.body);
    if (unrunnable.length) errors.push(`${name}: names command(s) the CLI refuses as unknown or removed: ${unrunnable.map((value) => `\`${value}\``).join(', ')}`);
    const seeded = seededStepArguments(skill.body, seededSteps);
    if (seeded.length) errors.push(`${name}: names seeded step ID(s) instead of the returned step (<phase>): ${seeded.map((value) => `\`${value}\``).join(', ')}`);
    const bareCommands = bareOperationalCommands(skill.body, commandRoots);
    if (bareCommands.length) {
      errors.push(`${name}: operational command fragment(s) must include the singularity-flow prefix: ${bareCommands.map((value) => `\`${value}\``).join(', ')}`);
    }
    if (kernelModelPolicy === 'never' && modelOperations.length) {
      errors.push(`${name}: never-model skill names model-capable operation(s): ${modelOperations.join(', ')}`);
    }
    if (kernelModelPolicy === 'conditional' && !modelOperations.length) errors.push(`${name}: conditional model policy has no model-capable operation reference`);
    for (const message of authoringSkillContractErrors(authoringSkills.find((entry) => entry.sourceId === name), skill.body)) errors.push(`${name}: ${message}`);
    const semanticContract = SKILL_SEMANTIC_CONTRACTS[name];
    errors.push(...turnBoundaryErrors(name, skill.body));
    for (const pattern of semanticContract?.required ?? []) {
      pattern.lastIndex = 0;
      if (!pattern.test(skill.body)) errors.push(`${name}: required semantic contract is missing (${pattern})`);
    }
    for (const pattern of semanticContract?.forbidden ?? []) {
      pattern.lastIndex = 0;
      if (pattern.test(skill.body)) errors.push(`${name}: forbidden stale semantic contract remains (${pattern})`);
    }
    if (bodyTokens > maximum) errors.push(`${name}: body is ${bodyTokens} estimated tokens; maximum is ${maximum}`);
    else if (bodyTokens > classPolicy.warningTokens) warnings.push(`${name}: body is ${bodyTokens} estimated tokens; warning threshold is ${classPolicy.warningTokens}`);
    rows.push({
      name,
      class: rule.class,
      automatic: automatic.has(name),
      executionBoundary: executionBoundaryKind,
      kernelModelPolicy,
      modelOperations,
      descriptionTokens,
      bodyTokens,
      commandPresentationTokens,
      artifactPresentationTokens,
      refusalHandlingTokens,
      applicabilityTokens,
      approvedInputsTokens,
      pauseGuardTokens,
      gatewayToolsTokens,
      pathContractTokens,
      storyCwdTokens,
      warningTokens: classPolicy.warningTokens,
      maximumTokens: maximum,
      previewBytes: classPolicy.previewBytes,
      hardMaximumBytes: classPolicy.hardMaximumBytes,
      exception: rule.exception ?? null
    });
  }
  return { errors, warnings, rows, automatic: [...automatic].sort() };
}

export function formatSkillAudit(result) {
  const lines = [
    `Skill policy: ${result.rows.length} registered; ${result.automatic.length} automatic; ${result.rows.length - result.automatic.length} explicit-only.`,
    `Estimated triggered body tokens: ${result.rows.reduce((sum, row) => sum + row.bodyTokens, 0)} total across the catalog.`
  ];
  if (result.warnings.length) lines.push(`Warnings (${result.warnings.length}):`, ...result.warnings.map((item) => `- ${item}`));
  if (result.errors.length) lines.push(`Errors (${result.errors.length}):`, ...result.errors.map((item) => `- ${item}`));
  return lines.join('\n');
}
