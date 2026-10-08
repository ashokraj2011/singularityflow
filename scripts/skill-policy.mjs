import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { operationCatalog } from '../src/command-registry.mjs';
import { AUTHORING_SKILL_DECLARATION, parseAuthoringSkills } from '../src/authoring-skills.mjs';
import { copilotPauseGuardForSkill, COPILOT_PAUSE_MARKER, PHASE_ENTRY_SKILLS } from '../src/copilot-mode.mjs';

export const COMMAND_PRESENTATION_CONTRACT = 'For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.';

const CONTRACT_TEXT = Object.freeze({
  'guided-actions': 'Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.',
  'concise-relay': 'Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below.',
  'explicit-selection': 'Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.',
  'conversational-guidance': 'Resolve ordinary language through durable Home and Next projections; reads may run immediately, while every mutation requires an explicit governed choice.',
  'governed-review': 'Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.',
  'clarification-and-artifact': 'Use governed inputs and pinned clarification; publish/show configured artifacts.',
  'deterministic-mutation': 'Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.',
  'scoped-repair': 'Repair only the named local scope; report changes and remaining findings. Never publish, submit, or approve.',
  'advisory-analysis': 'Run only the confirmed advisory analysis; report its evidence and limitations. Do not promote or publish governed artifacts.',
  'canonical-delegation': 'Run the canonical skill once and preserve its result and handoff; do not repeat its preflight, authoring, or publication.'
});

// Preserve narrower task contracts and compact equivalents when the class default is too broad.
const CONTRACT_TEXT_BY_SKILL = Object.freeze({
  'sflow-approve': 'Reuse exact same-chat document displays; refresh packet review and explicit consent.',
  'sflow-start': 'Explicit choices; no preselection; preserve errors/artifacts/actions.',
  'sflow-recover': 'CLI validates/mutates; preserve exact results, warnings, publication status, artifacts/actions.',
  'sflow-submit': 'Show artifacts, hashes, warnings, and confirmation before a decision.',
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
  'next.orchestrate': /\bsingularity-flow\s+next\b/,
  'pr.describe.polish': /\bsingularity-flow\s+pr\s+describe\b[^\n`]*--polish\b/,
  'process.run.model': /\bsingularity-flow\s+process\s+run\b[^\n`]*--allow-model\b/,
  'process.step.model': /\bsingularity-flow\s+process\s+step\b[^\n`]*--allow-model\b/,
  'spec.analyze.assisted': /\banalyze\s+--assisted\b/,
  'story.enhance-description': /\bsingularity-flow\s+story\s+enhance-description\b/,
  'story.converge.assisted': /\bstory\s+converge\b[^\n`]*--assisted\b/,
  'wm.build': /\bwm\s+build\b/,
  'wm.migrate': /\bwm\s+migrate\b/,
  'wm.regenerate': /\bwm\s+regenerate\b/,
  'wm.knowledge.explain': /\bwm\s+knowledge\s+explain\b(?![^\n]*--dry-run)/,
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
      /review-source check <phase> --report-file/,
      /at most two changed-packet repair attempts/,
      /Never mark a real gap supported merely to pass validation/,
      /`retentionReady` is false.*stop without commit\/push/s
    ]
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
      /Nonzero exit fails despite passing JUnit/
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
  'sflow-approve': {
    required: [
      /sflow-turn-boundary: approval-only/i,
      /explicit human phase ID confirms only the unchanged packet already reviewed in this conversation/i,
      /approval CLI is the sole permitted lifecycle mutation/i,
      /positional argument selects \*\*PHASE-ID\*\*, never Work ID/i,
      /Render once per exact display binding/i,
      /exactly matching non-null `displayBinding`/,
      /New chat, changed\/null binding, omissions or truncation require full display/i,
      /A phase supplied before a new or changed packet review is not its confirmation/i,
      /body reuse never reuses approval consent/i,
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
      /for adjudication, rework, intent amendment, or inspection[^.]*stop for the human decision/i,
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
      /Before approval run `singularity-flow phase show <phase> --json`/i,
      /singularity-flow recover <WORK-ID> --phase <phase> --json/i,
      /copy the first `NOW` action's `copilotCommand` and `command` from that same action object/i,
      /never pair `\/sf-phase` with `singularity-flow next`/i
    ],
    forbidden: [
      /Then run `singularity-flow next` once/i,
      /run `phase show <phase> --json`/i,
      /run `recover`/i
    ]
  },
  'sflow-workflow-rules': {
    required: [
      /Never run `singularity-flow next`/,
      /singularity-flow nextsteps <WORK-ID> --json/,
      /returned SFlow skill route/,
      /explicit contributor consent/i,
      /zero-byte World-Model context/i
    ],
    forbidden: [
      /if stale, build and recompose identically/i,
      /Run `singularity-flow next` only when/i,
      /repository contains `singularity\/work-items`/i
    ]
  }
});

function executionBoundary(kind = 'story', name = '') {
  if (name === 'sflow-review-source') return '**Boundary:** reuse this invocation\'s review entry: require `ready`/`workId`, valid `phaseAgent`; cwd=`repositoryPath`. Use returned `workItemRoot`/artifact and Git-private staging paths; never `$HOME`.';
  if (['sflow-next', 'sflow-inputs'].includes(name)) return '**Boundary:** reuse this invocation\'s entry: require `ready`/`workId`, valid `phaseAgent` for active phases; cwd=`repositoryPath`. Use returned `workItemRoot`/artifact paths; never `$HOME`.';
  if (PHASE_ENTRY_SKILLS.includes(name)) return '**Boundary:** reuse the entry packet: require `ready`/`workId` and valid `phaseAgent`; cwd=`repositoryPath`. Use returned `workItemRoot`/artifact paths within this Story; never `$HOME`.';
  if (kind === 'machine') {
    return '**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.';
  }
  if (kind === 'repository') {
    const base = '**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.';
    // Session attachment alone can start from an exact selected workspace whose application
    // checkout is deferred. Other repository-bound skills still require a ready checkout.
    return name === 'sflow-session'
      ? base.replace('refuse if neither resolves;', 'an exact selected workspace/repository is also valid before checkout exists; refuse if neither resolves;')
      : base;
  }
  if (kind === 'organisation') {
    return '**Boundary:** no Story or repository required; use only the selected lead URL. Resolve local checks with `singularity-flow workspace current --json`; never search `$HOME`.';
  }
  // A relative artifact path is not a usable boundary after Copilot `/clear`: the host can retain
  // its process cwd while the model loses the conversational repository hint. Resolve the selected
  // Story checkout on every skill invocation and make its absolute path the cwd of every shell/file
  // tool. `ready` and `workId` are checked before mutation so a stale workspace lead cannot silently
  // replace the Story selected before `/clear`. Keeping this generated makes the rule catalog-wide.
  if (kind === 'story') {
    return '**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.';
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

function withAutomaticPolicy(text, automatic, description, file) {
  const skill = splitSkill(text, file);
  let source = skill.frontmatterSource;
  source = source.replace(/^description:\s*.*$/m, `description: ${description ?? skill.frontmatter.description}`);
  source = source.replace(/^disable-model-invocation:\s*true\s*\r?\n?/m, '');
  if (!automatic) {
    const lines = source.split(/\r?\n/);
    const descriptionIndex = lines.findIndex((line) => line.startsWith('description:'));
    lines.splice(descriptionIndex + 1, 0, 'disable-model-invocation: true');
    source = lines.join('\n');
  }
  return `---\n${source}\n---\n${skill.body}`;
}

function withOutputContract(text, contract, kernelModelPolicy, file, executionBoundaryKind) {
  const skill = splitSkill(text, file);
  // Additional blocked/risk prose can separate the generated contract from its boundary. Strip
  // all maintained boundaries first so repeated generation never appends a second lookup.
  const sourceBody = skill.body.replace(/<!-- sflow-execution-boundary -->\r?\n\*\*(?:Execution boundary|Boundary):\*\*[^\n]*\r?\n?/gu, '');
  const marker = `<!-- sflow-output-contract: ${contract} -->`;
  const contractText = `**Output contract:** ${CONTRACT_TEXT_BY_SKILL[path.basename(path.dirname(file))] ?? CONTRACT_TEXT[contract]} ${COMMAND_PRESENTATION_CONTRACT}`;
  const boundaryMarker = '<!-- sflow-execution-boundary -->';
  const boundaryText = executionBoundary(executionBoundaryKind, path.basename(path.dirname(file)));
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

function withCopilotPauseGuard(text, enabled, file, name) {
  const skill = splitSkill(text, file);
  let body = skill.body.replace(/<!-- sflow-copilot-pause -->\r?\n[^\r\n]*\r?\n\r?\n?/gu, '');
  if (enabled) body = body.replace(/^(# .+)$/mu, `$1\n\n${COPILOT_PAUSE_MARKER}\n${copilotPauseGuardForSkill(name)}`);
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
export function authoringSkillContractErrors(entry, body) {
  if (!entry || entry.id === 'sf-code') return [];
  const errors = [];
  const steps = [...body.matchAll(/^(\d+)\. (.*)$/gmu)];
  const first = steps.find((match) => match[1] === '1')?.[2] ?? '';
  const last = steps.at(-1)?.[2] ?? '';
  for (const required of [entry.id === 'sf-phase' ? 'entry `authoring`' : 'singularity-flow phase show <phase> --json', '`policyVerified`', '`policyReason`']) {
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
      text = withOutputContract(text, classPolicy.outputContract, kernelModelPolicy, file, executionBoundaryKind);
      text = withCopilotPauseGuard(text, pauseGuardRequired, file, name);
      await writeFile(file, text);
    }
    const skill = splitSkill(text, file);
    for (const message of skillDelegationErrors(name, skill.body, policy.skills)) errors.push(`${name}: ${message}`);
    const bodyTokens = estimatedTokens(skill.body);
    const descriptionTokens = estimatedTokens(skill.frontmatter.description);
    // The shared command-presentation requirement is fixed engine-owned overhead, not an
    // allowance to grow per-skill prose. Report both budgets and keep the existing domain cap.
    const commandPresentationTokens = estimatedTokens(` ${COMMAND_PRESENTATION_CONTRACT}`);
    const pauseGuard = copilotPauseGuardForSkill(name);
    const pauseGuardTokens = pauseGuardRequired ? estimatedTokens(`${COPILOT_PAUSE_MARKER}\n${pauseGuard}\n\n`) : 0;
    const maximum = (rule.maximumTokenOverride ?? classPolicy.maximumTokens) + commandPresentationTokens + pauseGuardTokens;
    const marker = `<!-- sflow-output-contract: ${classPolicy.outputContract} -->`;
    const boundaryMarker = '<!-- sflow-execution-boundary -->';
    const boundaryText = executionBoundary(executionBoundaryKind, name);
    const modelOperations = referencedModelOperations(skill.body);
    if (skill.frontmatter.name !== name) errors.push(`${name}: frontmatter name must match directory`);
    if (pauseGuardRequired && (!skill.body.includes(pauseGuard)
        || skill.body.indexOf(COPILOT_PAUSE_MARKER) > skill.body.indexOf(boundaryMarker))) {
      errors.push(`${name}: pause guard must precede all repository/Story boundary lookups`);
    }
    if (automatic.has(name)) {
      if (skill.frontmatter['disable-model-invocation'] === true) errors.push(`${name}: automatic skill must not disable model invocation`);
      if (descriptionTokens > 15) errors.push(`${name}: automatic description is ${descriptionTokens} estimated tokens; maximum is 15`);
      if (rule.class === 'guided') {
        for (const required of [
          'automatic invocation is not mutation consent',
          'singularity-flow home --json --request "$ARGUMENTS"',
          '`ask_user`',
          'require an explicit `/sf-*` invocation'
        ]) if (!skill.body.includes(required)) errors.push(`${name}: guided automatic skill must include '${required}'`);
      }
    } else if (skill.frontmatter['disable-model-invocation'] !== true) {
      errors.push(`${name}: explicit-only skill must set disable-model-invocation: true`);
    }
    if (!skill.body.includes(marker)) errors.push(`${name}: missing '${classPolicy.outputContract}' output contract`);
    if (!skill.body.includes(COMMAND_PRESENTATION_CONTRACT)) errors.push(`${name}: missing Shell/Copilot presentation contract`);
    if (!skill.body.includes(boundaryMarker) || !skill.body.includes(boundaryText)) errors.push(`${name}: missing generated execution boundary`);
    if (skill.body.split(boundaryMarker).length !== 2) errors.push(`${name}: exactly one generated execution boundary is required`);
    if (skill.body.includes('singularity/work-items/<WORK-ID>')) {
      errors.push(`${name}: hard-codes the default Story root instead of using immutable workflow.resolution.workItemRoot or a CLI-returned path`);
    }
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
      pauseGuardTokens,
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
