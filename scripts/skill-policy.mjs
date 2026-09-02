import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { operationCatalog } from '../src/command-registry.mjs';

const CONTRACT_TEXT = Object.freeze({
  'guided-actions': 'Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.',
  'concise-relay': 'Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.',
  'explicit-selection': 'Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.',
  'conversational-guidance': 'Resolve ordinary language through durable Home and Next projections; reads may run immediately, while every mutation requires an explicit governed choice.',
  'governed-review': 'Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.',
  'clarification-and-artifact': 'Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.',
  'deterministic-mutation': 'Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.'
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
  'next.orchestrate': /\bsingularity-flow\s+next\b/,
  'pr.describe.polish': /\bsingularity-flow\s+pr\s+describe\b[^\n`]*--polish\b/,
  'process.run.model': /\bsingularity-flow\s+process\s+run\b[^\n`]*--allow-model\b/,
  'process.step.model': /\bsingularity-flow\s+process\s+step\b[^\n`]*--allow-model\b/,
  'spec.analyze.assisted': /\banalyze\s+--assisted\b/,
  'story.converge.assisted': /\bstory\s+converge\b[^\n`]*--assisted\b/,
  'wm.build': /\bwm\s+build\b/,
  'wm.ensure': /\bwm\s+ensure\b/,
  'wm.migrate': /\bwm\s+migrate\b/,
  'wm.regenerate': /\bwm\s+regenerate\b/,
  'workspace.copilot': /\bsingularity-flow\s+workspace\s+copilot\b/,
  'workspace.impact.analyze': /\bsingularity-flow\s+workspace\s+impact\s+analyze\b/
});

function executionBoundary(kind = 'story') {
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
  // Story checkout on every skill invocation and make its absolute path the cwd of every shell/file
  // tool. `ready` and `workId` are checked before mutation so a stale workspace lead cannot silently
  // replace the Story selected before `/clear`. Keeping this generated makes the rule catalog-wide.
  if (kind === 'story') {
    return '**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.';
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
  'sflow-home': 'Guide developer requests through explicit governed choices.',
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
  const marker = `<!-- sflow-output-contract: ${contract} -->`;
  const contractText = `**Output contract:** ${CONTRACT_TEXT[contract]}`;
  const boundaryMarker = '<!-- sflow-execution-boundary -->';
  const boundaryText = executionBoundary(executionBoundaryKind);
  if (!CONTRACT_TEXT[contract]) throw new Error(`${file}: unknown output contract '${contract}'`);
  const existing = /<!-- sflow-output-contract: [^>]+ -->\r?\n(?:\*\*Output contract:\*\*[^\n]*\r?\n?)?(?:<!-- sflow-execution-boundary -->\r?\n)?(?:\*\*(?:Execution boundary|Boundary):\*\*[^\n]*\r?\n?)*/;
  const rendered = `${marker}\n${contractText}\n${boundaryMarker}\n${boundaryText}\n`;
  let body;
  if (existing.test(skill.body)) {
    body = skill.body.replace(existing, rendered);
  } else {
    const heading = skill.body.match(/^# .+$/m);
    if (!heading) throw new Error(`${file}: missing H1 heading for output contract`);
    const end = heading.index + heading[0].length;
    body = `${skill.body.slice(0, end)}\n\n${rendered}${skill.body.slice(end)}`;
  }
  return `---\n${skill.frontmatterSource}\n---\n${body}`;
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
  const auditedModelOperations = Object.keys(MODEL_OPERATION_PATTERNS).sort();
  if (JSON.stringify(catalogModelOperations) !== JSON.stringify(auditedModelOperations)) {
    errors.push(`skill model-operation patterns are stale: catalog=${catalogModelOperations.join(', ')}; audit=${auditedModelOperations.join(', ')}`);
  }

  for (const missing of directories.filter((name) => !registered.includes(name))) errors.push(`${missing}: missing from skill registry`);
  for (const stale of registered.filter((name) => !directories.includes(name))) errors.push(`${stale}: registry entry has no skill directory`);
  for (const name of automatic) if (!registered.includes(name)) errors.push(`${name}: automatic allowlist entry is not registered`);

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
    let text = await readFile(file, 'utf8');
    if (write) {
      text = withAutomaticPolicy(text, automatic.has(name), AUTOMATIC_DESCRIPTIONS[name], file);
      text = withOutputContract(text, classPolicy.outputContract, kernelModelPolicy, file, executionBoundaryKind);
      await writeFile(file, text);
    }
    const skill = splitSkill(text, file);
    const bodyTokens = estimatedTokens(skill.body);
    const descriptionTokens = estimatedTokens(skill.frontmatter.description);
    const maximum = rule.maximumTokenOverride ?? classPolicy.maximumTokens;
    const marker = `<!-- sflow-output-contract: ${classPolicy.outputContract} -->`;
    const boundaryMarker = '<!-- sflow-execution-boundary -->';
    const boundaryText = executionBoundary(executionBoundaryKind);
    const modelOperations = referencedModelOperations(skill.body);
    if (skill.frontmatter.name !== name) errors.push(`${name}: frontmatter name must match directory`);
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
    if (!skill.body.includes(boundaryMarker) || !skill.body.includes(boundaryText)) errors.push(`${name}: missing generated execution boundary`);
    if (kernelModelPolicy === 'never' && modelOperations.length) {
      errors.push(`${name}: never-model skill names model-capable operation(s): ${modelOperations.join(', ')}`);
    }
    if (kernelModelPolicy === 'conditional' && !modelOperations.length) errors.push(`${name}: conditional model policy has no model-capable operation reference`);
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
