/**
 * Choices for a workflow import that collides with what the repository already has.
 *
 * Every same-name conflict belongs to one subject: a workflow, step, template, artifact set,
 * approval group, MCP server, agent or template file. For each subject the person keeps the
 * repository's own (the imported one is dropped and the import uses the repository's), replaces it
 * with the imported one, or imports the imported one under a new name. A new name is written
 * through every reference in the bundle (steps, workflows, agents, locks, imported copies and their
 * records), so the imported workflow keeps working and nothing that already exists changes.
 */
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { AUTHORING_SKILL_DECLARATION, authoringSkillDirectId } from './authoring-skills.mjs';
import { EPIC_PHASES } from './initiative-phase-roles.mjs';
import { SingularityFlowError } from './util.mjs';
import { renderPreservingFormatting } from './yaml-formatting.mjs';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Subjects stored in a configuration catalog: [governs, catalog, noun]. */
export const CATALOG_SUBJECTS = Object.freeze({
  workflow: Object.freeze(['story', 'workTypes', 'workflow']),
  phase: Object.freeze(['story', 'phases', 'step']),
  template: Object.freeze(['story', 'templates', 'template']),
  'artifact-set': Object.freeze(['story', 'artifactSets', 'artifact set']),
  'approval-group': Object.freeze(['story', 'approvalAuthorities', 'approval group']),
  'mcp-server': Object.freeze(['story', 'mcpServers', 'MCP server']),
  'initiative-workflow': Object.freeze(['initiative', 'initiativeProfiles', 'Epic workflow']),
  'initiative-phase': Object.freeze(['initiative', 'initiativePhases', 'Epic step']),
  'initiative-approval-group': Object.freeze(['initiative', 'approvalAuthorities', 'Epic approval group']),
  'applicability-policy': Object.freeze(['initiative', 'applicabilityPolicies', 'applicability policy'])
});
const NOUNS = Object.freeze({
  ...Object.fromEntries(Object.entries(CATALOG_SUBJECTS).map(([kind, [, , noun]]) => [kind, noun])),
  agent: 'agent', 'template-file': 'template file', skill: 'skill package'
});
export const RESOLUTION_ACTIONS = Object.freeze(['keep', 'replace', 'rename']);
export const RESOLVE_ALL_CHOICES = Object.freeze(['suggested', 'keep', 'replace', 'rename']);

function fail(message, details = undefined) {
  throw new SingularityFlowError(message, { code: 'WORKFLOW_IMPORT_RESOLUTION_INVALID', ...(details ? { details } : {}) });
}

export function subjectNoun(kind) { return NOUNS[kind] ?? kind; }

/** The subject kind of a configuration catalog entry in a plan (`story.phases` → `phase`). */
export function catalogSubjectKind(entryKind) {
  return Object.entries(CATALOG_SUBJECTS).find(([, [governs, catalog]]) => entryKind === `${governs}.${catalog}`)?.[0] ?? null;
}

export function parseSubject(subject) {
  const text = String(subject ?? '');
  const colon = text.indexOf(':');
  const kind = colon > 0 ? text.slice(0, colon) : '';
  const id = colon > 0 ? text.slice(colon + 1) : '';
  if (!Object.hasOwn(NOUNS, kind) || kind === 'skill') {
    fail(`'${text}' is not something an import can resolve. Use one of: ${Object.keys(NOUNS).filter((name) => name !== 'skill').join(', ')}, followed by ':' and its ID.`);
  }
  if (kind === 'template-file' ? !/^[^\s:]+$/.test(id) || id.split('/').includes('..') : !ID.test(id)) {
    fail(`'${text}' does not name a ${subjectNoun(kind)} by its ${kind === 'template-file' ? 'path' : 'lower-case kebab-case ID'}.`);
  }
  return { kind, id };
}

/** What a person can choose for a subject. Skill packages, and conflicts with no subject, must match exactly. */
export function subjectChoices(kind) {
  return kind && kind !== 'skill' ? [...RESOLUTION_ACTIONS] : [];
}

/**
 * Import theirs under a new name, so nothing that exists changes. Approval groups are people:
 * the import keeps the repository's own group rather than adding a second one with their members.
 */
export function suggestedAction(kind) {
  if (!subjectChoices(kind).length) return null;
  return ['approval-group', 'initiative-approval-group'].includes(kind) ? 'keep' : 'rename';
}

const skillStep = (phase) => Boolean(phase) && typeof phase === 'object' && (phase.kind === 'skill' || phase.skillBinding != null);

/** Why a subject cannot arrive under a new name, or null when it can. */
export function renameRefusal(kind, id, bundle) {
  if (kind === 'phase' && skillStep(bundle.objects.story.phases?.[id])) {
    return `Skill step '${id}' is compiled against its own step ID, so it cannot arrive under a new name. Keep or replace it.`;
  }
  if (kind === 'initiative-phase' && Object.values(EPIC_PHASES).includes(id)) {
    return `Epic step '${id}' must keep its canonical ID. Keep or replace it.`;
  }
  return null;
}

/** `<base>-imported`, then `-imported-2` …, for IDs; for a file, the same before its extension. */
export function nameCandidates(kind, id) {
  if (kind !== 'template-file') {
    return (index) => (index === 1 ? `${id}-imported` : `${id}-imported-${index}`);
  }
  const slash = id.lastIndexOf('/');
  const dot = id.lastIndexOf('.');
  const stem = dot > slash + 1 ? id.slice(0, dot) : id;
  const extension = dot > slash + 1 ? id.slice(dot) : '';
  return (index) => `${stem}${index === 1 ? '-imported' : `-imported-${index}`}${extension}`;
}

/** Normalized choices keyed by subject, in a stable order so the plan digest binds them exactly. */
export function normalizeResolutions(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail('Import choices must map each subject to keep, replace or rename.');
  const result = {};
  for (const subject of Object.keys(value).sort()) {
    const { kind, id } = parseSubject(subject);
    const raw = value[subject];
    const choice = typeof raw === 'string' ? { action: raw } : raw;
    if (!choice || typeof choice !== 'object' || !RESOLUTION_ACTIONS.includes(choice.action)) {
      fail(`Choose keep, replace or rename for ${subject}.`);
    }
    if (choice.action !== 'rename') {
      if (choice.to != null) fail(`Only rename takes a new name (${subject}).`);
      result[subject] = { action: choice.action };
      continue;
    }
    if (choice.to == null) { result[subject] = { action: 'rename' }; continue; }
    const to = String(choice.to).trim();
    if (kind === 'template-file' ? !/^[^\s:]+$/.test(to) || to.split('/').includes('..') : !ID.test(to)) {
      fail(`The new name for ${subject} must be ${kind === 'template-file' ? 'a file path without spaces' : 'lower-case kebab-case'}.`);
    }
    if (to === id) fail(`The new name for ${subject} is its current name.`);
    result[subject] = { action: 'rename', to };
  }
  return result;
}

/** `--resolve <subject>=keep|replace|rename[:<new name>]`, repeatable, and `--resolve-all <choice>`. */
export function importResolutionOptions(values = [], resolveAll = undefined) {
  const resolutions = {};
  for (const text of values.flatMap((value) => String(value).split(/\s+/)).filter(Boolean)) {
    const equals = text.lastIndexOf('=');
    if (equals < 1) fail(`--resolve takes <kind>:<id>=keep|replace|rename[:<new name>], not '${text}'.`);
    const subject = text.slice(0, equals);
    const [action, ...rest] = text.slice(equals + 1).split(':');
    if (Object.hasOwn(resolutions, subject)) fail(`${subject} has more than one --resolve choice.`);
    resolutions[subject] = rest.length ? { action, to: rest.join(':') } : { action };
  }
  if (resolveAll === true) fail(`--resolve-all takes one of: ${RESOLVE_ALL_CHOICES.join(', ')}.`);
  if (resolveAll != null && !RESOLVE_ALL_CHOICES.includes(resolveAll)) {
    fail(`--resolve-all takes one of: ${RESOLVE_ALL_CHOICES.join(', ')}, not '${resolveAll}'.`);
  }
  return { resolutions: normalizeResolutions(resolutions), resolveAll: resolveAll ?? null };
}

/** The choice `--resolve-all` makes for one open conflict, or null when it has none to make. */
export function pickResolution(mode, item) {
  if (!item.choices.length) return null;
  const action = mode === 'suggested' ? item.suggested : mode;
  if (!item.choices.includes(action)) return null;
  return action === 'rename' ? { action, to: item.renameTo } : { action };
}

export function resolveArguments(resolutions = {}) {
  return Object.entries(resolutions).flatMap(([subject, choice]) => [
    '--resolve', `${subject}=${choice.action}${choice.action === 'rename' && choice.to ? `:${choice.to}` : ''}`
  ]);
}

function shellWord(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@+,%-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

function explain(item, action) {
  const noun = subjectNoun(item.kind);
  if (action === 'keep') {
    return ['workflow', 'initiative-workflow'].includes(item.kind)
      ? 'keep yours; theirs is not imported'
      : `keep yours; the import uses your ${noun}`;
  }
  if (action === 'replace') {
    const others = item.usedBy.length ? `; this also changes ${item.usedBy.join(', ')}` : '';
    return `replace yours with theirs${others}`;
  }
  return `import theirs as ${item.renameTo}; yours stays as it is`;
}

/** Plain-text preview of an import plan, with the exact flags that resolve each open conflict. */
export function importPlanText(plan, file) {
  const counts = plan.counts ?? {};
  const fileArgument = shellWord(file);
  const chosen = resolveArguments(plan.resolutions);
  const chosenText = chosen.length ? ` ${chosen.map(shellWord).join(' ')}` : '';
  const open = plan.unresolved ?? [];
  const lines = [plan.status === 'ready'
    ? 'Workflow import preview: ready.'
    : `Workflow import preview: ${plan.status}${open.length ? `; ${open.length} conflict${open.length === 1 ? ' needs a choice' : 's need choices'}` : ''}.`];
  lines.push(`  Add: ${counts.add ?? 0} · Reuse exact: ${counts.reuse ?? 0}`
    + `${counts.replace ? ` · Replace yours: ${counts.replace}` : ''}${counts.keep ? ` · Keep yours: ${counts.keep}` : ''}`
    + ` · Conflicts: ${counts.conflicts ?? 0}`);
  for (const item of plan.renamed ?? []) {
    const { kind, id } = parseSubject(item.subject);
    lines.push(`  New name: ${subjectNoun(kind)} ${id} → ${item.to}`);
  }
  if (plan.changedPaths?.length) lines.push(`  Changed paths: ${plan.changedPaths.join(', ')}`);
  if (plan.status === 'ready') {
    lines.push(`  Confirm plan: ${plan.planSha256}`);
    lines.push(`  Apply it: singularity-flow workflow import ${fileArgument} --confirm ${plan.planSha256}${chosenText}`);
    return lines;
  }
  for (const item of open) {
    const noun = subjectNoun(item.kind);
    lines.push('', item.kind ? `  ${noun[0].toUpperCase()}${noun.slice(1)} ${item.id}:` : `  ${item.id}:`);
    for (const reason of item.reasons) lines.push(`    ${reason}`);
    if (item.usedBy.length) lines.push(`    Used here by: ${item.usedBy.join(', ')}`);
    if (!item.choices.length) {
      lines.push(`    ${item.kind === 'skill' ? 'A skill package must match exactly; update it here first.' : 'Change another choice, or the repository, so this passes.'}`);
      continue;
    }
    const ordered = [item.suggested, ...item.choices.filter((action) => action !== item.suggested)];
    for (const action of ordered) {
      const flag = `${item.subject}=${action === 'rename' ? `rename:${item.renameTo}` : action}`;
      lines.push(`    --resolve ${shellWord(flag)}  ${explain(item, action)}${action === item.suggested ? ' (suggested)' : ''}`);
    }
  }
  if (open.some((item) => item.choices.length)) {
    lines.push('', '  Choose one --resolve for each, then preview again:',
      `    singularity-flow workflow import ${fileArgument} --dry-run${chosenText} --resolve …`,
      '  Or take every suggestion, including conflicts the new names cause:',
      `    singularity-flow workflow import ${fileArgument} --dry-run${chosenText} --resolve-all suggested`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Importing under a new name

const IMPORTED_LABEL = ' (imported)';
const AGENT_ROOT = '.github/agents';
const AGENT_VENDOR_ROOT = 'singularity/imports/agents';
const MCP_VENDOR_ROOT = 'singularity/imports/mcp';
/** A fast-path verb without a list owns the step named for it (src/fast-path.mjs). */
const VERB_PHASES = Object.freeze({
  specify: 'specification', plan: 'planning', implement: 'implementation', verify: 'verification', converge: 'convergence'
});

const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
}
const stable = (value) => JSON.stringify(sortedValue(value));
const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

function swapValue(value, map) { return typeof value === 'string' && map.has(value) ? map.get(value) : value; }
function swapField(object, key, map) {
  if (plain(object) && typeof object[key] === 'string' && map.has(object[key])) object[key] = map.get(object[key]);
}
function swapList(object, key, map) {
  if (plain(object) && Array.isArray(object[key])) object[key] = object[key].map((value) => swapValue(value, map));
}
function swapKeys(object, key, map) {
  if (!plain(object) || !plain(object[key])) return;
  object[key] = Object.fromEntries(Object.entries(object[key]).map(([id, value]) => [map.get(id) ?? id, value]));
}
/** Every object in a value, with the key it sits under; an array's items share the array's key. */
function eachObject(value, visit, key = null) {
  if (Array.isArray(value)) {
    for (const item of value) eachObject(item, visit, key);
    return;
  }
  if (!plain(value)) return;
  visit(value, key);
  for (const [childKey, child] of Object.entries(value)) eachObject(child, visit, childKey);
}
/** Each listed step, followed by its new name: the repository's own step keeps what it had. */
function withRenamed(list, map) {
  const result = [];
  for (const id of list) {
    if (!result.includes(id)) result.push(id);
    if (map.has(id) && !result.includes(map.get(id)) && !list.includes(map.get(id))) result.push(map.get(id));
  }
  return result;
}
function phaseListText(value) {
  if (typeof value !== 'string' || ['', '*', '-'].includes(value.trim())) return null;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function renamedCatalog(catalog, map) {
  return Object.fromEntries(Object.entries(catalog).map(([id, value]) => {
    if (!map.has(id)) return [id, value];
    // Two objects with the same label side by side would be indistinguishable in every picker.
    if (plain(value) && typeof value.label === 'string' && !value.label.endsWith(IMPORTED_LABEL)) {
      value.label = `${value.label}${IMPORTED_LABEL}`;
    }
    return [map.get(id), value];
  }));
}

/** `<step>/<output>` with the step's new name. */
function swapCompound(value, map) {
  const slash = typeof value === 'string' ? value.indexOf('/') : -1;
  return slash > 0 && map.has(value.slice(0, slash)) ? `${map.get(value.slice(0, slash))}${value.slice(slash)}` : value;
}
function outputsOf(phase) {
  return Array.isArray(phase.outputs) ? phase.outputs : plain(phase.outputs) ? Object.values(phase.outputs) : [];
}

/** References to steps inside one step, or inside a workflow's override of it. */
function renameStepFields(phase, map) {
  if (!plain(phase)) return;
  if (Array.isArray(phase.inputs)) {
    phase.inputs = phase.inputs.map((input) => (typeof input === 'string' ? swapValue(input, map)
      : plain(input) && map.has(input.phase) ? { ...input, phase: map.get(input.phase) } : input));
  }
  swapField(phase, 'testEvidenceFrom', map);
  swapField(phase.repairBudget, 'resetOnPhase', map);
  swapList(phase.approval, 'rejectTo', map);
  for (const output of outputsOf(phase)) {
    if (plain(output) && Array.isArray(output.consumes)) output.consumes = output.consumes.map((value) => swapCompound(value, map));
  }
  for (const item of Array.isArray(phase.checklist) ? phase.checklist : []) swapList(item?.freshness, 'revalidateAt', map);
}

/**
 * A step's own name in itself: its artifact is written under `artifacts/<step>/`, and a step named
 * requirements, design or release with no drafting skill is drafted by the skill for that name.
 */
function renameOwnStep(phase, from, to) {
  if (!plain(phase)) return;
  const prefix = `artifacts/${from}/`;
  if (plain(phase.artifact) && typeof phase.artifact.path === 'string' && phase.artifact.path.startsWith(prefix)) {
    phase.artifact.path = `artifacts/${to}/${phase.artifact.path.slice(prefix.length)}`;
  }
  if (phase.authoringSkill == null) {
    const legacy = Object.entries(AUTHORING_SKILL_DECLARATION).find(([, entry]) => entry.legacyPhases?.includes(from));
    if (legacy) phase.authoringSkill = authoringSkillDirectId(legacy[0]);
  }
}

/** References to steps in a workflow: its order, overrides, rules, decisions and policies. */
function renameWorkflowStepFields(type, map, { epic = false } = {}) {
  if (!plain(type)) return;
  swapList(type, 'phases', map);
  swapKeys(type, 'phaseOverrides', map);
  for (const [phase, override] of Object.entries(type.phaseOverrides ?? {})) {
    renameStepFields(override, map);
    const from = [...map].find(([, to]) => to === phase)?.[0];
    if (from) renameOwnStep(override, from, phase);
  }
  if (epic && plain(type.templateOverrides)) {
    // An Epic workflow overrides one output's template: `<step>/<output>`.
    type.templateOverrides = Object.fromEntries(Object.entries(type.templateOverrides).map(([key, value]) => [swapCompound(key, map), value]));
  } else swapKeys(type, 'templateOverrides', map);
  for (const pack of Array.isArray(type.packs) ? type.packs : []) {
    if (plain(pack) && Array.isArray(pack.members)) pack.members = pack.members.map((member) => swapCompound(member, map));
  }
  for (const loop of Array.isArray(type.reworkLoops) ? type.reworkLoops : []) {
    for (const key of ['from', 'to', 'resetOnPhase']) swapField(loop, key, map);
  }
  for (const decision of Array.isArray(type.decisions) ? type.decisions : []) {
    swapField(decision, 'after', map);
    swapField(decision, 'back', map);
    for (const route of Array.isArray(decision?.routes) ? decision.routes : []) swapField(route, 'to', map);
  }
  if (plain(type.plannedClaims)) {
    swapList(type.plannedClaims, 'clausePhases', map);
    if (plain(type.plannedClaims.owners)) {
      type.plannedClaims.owners = Object.fromEntries(Object.entries(type.plannedClaims.owners)
        .map(([code, owner]) => [map.get(code) ?? code, swapValue(owner, map)]));
    }
  }
  swapList(type.documents, 'allowedPhases', map);
  swapList(type.sourceReview, 'phases', map);
  if (plain(type.auto) && typeof type.auto.defaultUntil === 'string' && type.auto.defaultUntil) {
    const [, milestone, phase] = /^(?:(published|submitted|phase-complete):)?(.+)$/.exec(type.auto.defaultUntil);
    if (map.has(phase)) type.auto.defaultUntil = milestone ? `${milestone}:${map.get(phase)}` : map.get(phase);
  }
  if (plain(type.designSources)) {
    // Design sources are captured in design-intake unless the workflow names another step.
    const capture = type.designSources.capturePhase ?? 'design-intake';
    if (map.has(capture)) type.designSources.capturePhase = map.get(capture);
    swapList(type.designSources, 'consumeIn', map);
  }
  if (plain(type.fastPath)) {
    for (const [verb, entry] of Object.entries(type.fastPath)) {
      const phases = plain(entry) && Array.isArray(entry.phases) ? entry.phases : [VERB_PHASES[verb]].filter(Boolean);
      if (!phases.some((phase) => map.has(phase))) continue;
      type.fastPath[verb] = { ...(plain(entry) ? entry : { milestone: entry }), phases: phases.map((phase) => swapValue(phase, map)) };
    }
  }
}

/**
 * Approval groups: approval lists, decisions' `by`, and `authority` where it names a group (an
 * omitted responsibility, an Epic approval chain). An artifact-set member's `authority` is
 * vocabulary (`governed`, `advisory`), not a group.
 */
function renameGroupFields(root, map) {
  eachObject(root, (object, key) => {
    swapList(object, 'authorities', map);
    swapList(object, 'requiredAuthorities', map);
    swapField(object, 'exceptionAuthority', map);
    if (key === 'omits' || key === 'chain') swapField(object, 'authority', map);
    if (Array.isArray(object.routes)) {
      swapField(object, 'by', map);
      swapList(object, 'by', map);
    }
  });
}

/** Every template reference the dependency closure reads, rewritten for the side it belongs to. */
function renameTemplateReferences(objects, rewrite) {
  for (const governs of ['story', 'initiative']) {
    eachObject(objects[governs], (object) => {
      if (typeof object.defaultTemplate === 'string') object.defaultTemplate = rewrite(governs, object.defaultTemplate);
      for (const output of outputsOf(object)) {
        if (plain(output) && typeof output.template === 'string') output.template = rewrite(governs, output.template);
      }
      if (plain(object.templateOverrides)) {
        object.templateOverrides = Object.fromEntries(Object.entries(object.templateOverrides)
          .map(([phase, reference]) => [phase, typeof reference === 'string' ? rewrite(governs, reference) : reference]));
      }
    });
  }
}

/**
 * Edit an agent file's frontmatter (through `edit(document, body)`, which returns the new body)
 * and keep every byte it does not change, including CRLF line endings and a byte-order mark.
 */
function rewriteAgent(text, edit) {
  const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
  const source = text.slice(bom.length);
  const opening = /^---\r?\n/.exec(source);
  const remainder = opening ? source.slice(opening[0].length) : '';
  const closing = opening ? /\r?\n---(?:\r?\n|$)/.exec(remainder) : null;
  if (!closing) return text;
  const crlf = opening[0].endsWith('\r\n');
  const header = `${remainder.slice(0, closing.index).replaceAll('\r\n', '\n')}\n`;
  const document = YAML.parseDocument(header);
  const before = JSON.stringify(document.toJS());
  const body = remainder.slice(closing.index + closing[0].length);
  const nextBody = edit(document, body);
  const delimiter = remainder.slice(closing.index, closing.index + closing[0].length).replace(/^\r?\n/, '');
  if (JSON.stringify(document.toJS()) === before) return nextBody === body ? text : `${bom}${opening[0]}${remainder.slice(0, closing.index + closing[0].length)}${nextBody}`;
  const rendered = renderPreservingFormatting(header, document);
  return `${bom}${opening[0]}${crlf ? rendered.replaceAll('\n', '\r\n') : rendered}${delimiter}${nextBody}`;
}

/** Rewrite cells of one agent resource table; every other line stays as it was. */
function rewriteTable(body, heading, rewriteCells) {
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start < 0) return body;
  let index = start + 1;
  while (index < lines.length && !lines[index].trim()) index += 1;
  if (!lines[index]?.trim().startsWith('|') || !lines[index + 1]?.includes('---')) return body;
  let changed = false;
  for (index += 2; index < lines.length && lines[index].trim().startsWith('|'); index += 1) {
    const cells = lines[index].trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    const next = rewriteCells([...cells]);
    if (next.join('\0') !== cells.join('\0')) {
      lines[index] = `| ${next.join(' | ')} |`;
      changed = true;
    }
  }
  return changed ? lines.join(newline) : body;
}

function phaseCell(cell, map) {
  const list = phaseListText(cell);
  return list ? withRenamed(list, map).join(',') : cell;
}

function generatedPlace(phase, target, map) {
  if (!map.has(phase)) return { phase, target };
  const prefix = `artifacts/${phase}/`;
  const moved = map.get(phase);
  return { phase: moved, target: typeof target === 'string' && target.startsWith(prefix) ? `artifacts/${moved}/${target.slice(prefix.length)}` : target };
}

/**
 * Import subjects under new names. `renames` maps `<kind>:<id>` to the new ID (a repository path
 * for a template file). The bundle is rewritten in place and returned; the caller recomputes its
 * digests and reads it again like any other bundle, so a reference this misses fails closed there.
 *
 * Agents keep what the repository's own steps rely on. An agent that already exists here gains a
 * renamed step next to the one it had; an agent arriving under a new name drafts only steps that
 * are new here, because the repository's own agent already drafts the rest.
 */
export function renameBundleSubjects(bundle, renames, { targetPhases, targetAgents, targetPath }) {
  const maps = {};
  for (const [subject, to] of renames) {
    const { kind, id } = parseSubject(subject);
    if (!maps[kind]) maps[kind] = new Map();
    maps[kind].set(id, to);
  }
  const map = (kind) => maps[kind] ?? new Map();
  const phaseMap = map('phase'); const agentMap = map('agent'); const serverMap = map('mcp-server');
  const { story, initiative } = bundle.objects;
  const descriptorOwners = new Set(bundle.assets.filter((asset) => asset.kind === 'vendored' && asset.owner.kind === 'mcp-server')
    .map((asset) => asset.owner.id));

  for (const [kind, [governs, catalog]] of Object.entries(CATALOG_SUBJECTS)) {
    if (maps[kind]) bundle.objects[governs][catalog] = renamedCatalog(bundle.objects[governs][catalog], maps[kind]);
  }
  // Agents name a server's tools by its host entry, `hostReference`, which defaults to its ID. A
  // server that arrives with its descriptor is a different program: its host entry takes the new
  // name (`mcp host add <new>` creates it) and so do the tools agents name. One configured by hand
  // keeps the host entry it had, now written out, and agents keep naming it.
  const hostMap = new Map();
  for (const [from, to] of serverMap) {
    const server = bundle.objects.story.mcpServers[to];
    if (!plain(server)) continue;
    const host = server.hostReference ?? from;
    if (host === from && descriptorOwners.has(from)) {
      server.hostReference = to;
      hostMap.set(from, to);
    } else server.hostReference = host;
  }
  for (const workflow of bundle.workflows) {
    workflow.id = map(workflow.governs === 'story' ? 'workflow' : 'initiative-workflow').get(workflow.id) ?? workflow.id;
  }

  const skillStepsBefore = new Map(Object.entries(story.phases).filter(([, phase]) => skillStep(phase))
    .map(([id, phase]) => [id, stable(phase)]));
  if (phaseMap.size) {
    for (const [from, to] of phaseMap) renameOwnStep(story.phases[to], from, to);
    for (const phase of Object.values(story.phases)) renameStepFields(phase, phaseMap);
    for (const type of Object.values(story.workTypes)) renameWorkflowStepFields(type, phaseMap);
    for (const server of Object.values(story.mcpServers)) swapList(server, 'phases', phaseMap);
  }
  if (maps['initiative-phase']) {
    const epicMap = maps['initiative-phase'];
    for (const [from, to] of epicMap) renameOwnStep(initiative.initiativePhases[to], from, to);
    for (const phase of Object.values(initiative.initiativePhases)) renameStepFields(phase, epicMap);
    for (const profile of Object.values(initiative.initiativeProfiles)) renameWorkflowStepFields(profile, epicMap, { epic: true });
  }
  if (maps['approval-group']) renameGroupFields(story, maps['approval-group']);
  if (maps['initiative-approval-group']) renameGroupFields(initiative, maps['initiative-approval-group']);
  if (maps['artifact-set']) eachObject(story, (object) => swapField(object, 'artifactSet', maps['artifact-set']));
  if (serverMap.size) {
    eachObject(story, (object) => {
      swapList(object, 'requiredServers', serverMap);
      if (object.tool) swapField(object, 'server', serverMap);
    });
  }
  if (maps['applicability-policy']) {
    eachObject(initiative, (object) => { if (plain(object.applicability)) swapField(object.applicability, 'policy', maps['applicability-policy']); });
  }
  if (agentMap.size) {
    eachObject(bundle.objects, (object) => {
      swapList(object, 'agents', agentMap);
      swapField(object, 'reviewerAgent', agentMap);
    });
  }

  // Template files under a new path, then every reference to agents' templates, catalog entries and files.
  const movedPaths = new Map();
  const fileReferences = new Map();
  for (const asset of bundle.assets.filter((candidate) => candidate.kind === 'template')) {
    const from = targetPath(asset);
    const to = map('template-file').get(from);
    if (!to) continue;
    const targetRoot = from.slice(0, from.length - asset.rootRelative.length - 1);
    const rootRelative = to.slice(targetRoot.length + 1);
    const sourceRoot = bundle.requirements.templateRoots[asset.governs];
    fileReferences.set(`${asset.governs}\0${asset.rootRelative}`, rootRelative);
    fileReferences.set(`${asset.governs}\0${sourceRoot}/${asset.rootRelative}`, `${sourceRoot}/${rootRelative}`);
    movedPaths.set(asset.path, `${sourceRoot}/${rootRelative}`);
    asset.rootRelative = rootRelative;
    asset.path = `${sourceRoot}/${rootRelative}`;
  }
  const templateMap = map('template');
  const rewriteReference = (governs, reference) => {
    if (reference.startsWith('agent:')) {
      const slash = reference.indexOf('/');
      const agent = reference.slice('agent:'.length, slash < 0 ? undefined : slash);
      return agentMap.has(agent) ? `agent:${agentMap.get(agent)}${slash < 0 ? '' : reference.slice(slash)}` : reference;
    }
    if (reference.startsWith('template:')) {
      const id = reference.slice('template:'.length);
      return templateMap.has(id) ? `template:${templateMap.get(id)}` : reference;
    }
    return fileReferences.get(`${governs}\0${reference}`) ?? reference;
  };
  renameTemplateReferences(bundle.objects, rewriteReference);
  for (const [id, declaration] of Object.entries(story.templates)) {
    if (typeof declaration === 'string') story.templates[id] = rewriteReference('story', declaration);
    else if (plain(declaration) && typeof declaration.path === 'string') declaration.path = rewriteReference('story', declaration.path);
  }
  for (const asset of bundle.assets.filter((candidate) => candidate.kind === 'template')) {
    asset.reference = rewriteReference(asset.governs, asset.reference);
  }

  // Agents: their files, locks, imported copies and what they draft.
  const renamedAgents = new Set(agentMap.values());
  const existsHere = (id) => !renamedAgents.has(id) && targetAgents.has(id);
  const changedAgents = new Map();
  for (const asset of bundle.assets.filter((candidate) => candidate.kind === 'agent')) {
    const from = asset.id;
    const to = agentMap.get(from) ?? from;
    const renamed = to !== from;
    const existing = existsHere(to);
    const before = asset.content;
    asset.content = rewriteAgent(asset.content, (document, body) => {
      if (renamed) {
        if (document.get('name') === from) document.set('name', to);
        const label = document.getIn(['metadata', 'sflow-label']);
        if (typeof label === 'string' && !label.endsWith(IMPORTED_LABEL)) document.setIn(['metadata', 'sflow-label'], `${label}${IMPORTED_LABEL}`);
      }
      if (hostMap.size) {
        const tools = document.get('tools', true);
        for (const item of YAML.isSeq(tools) ? tools.items : []) {
          if (YAML.isScalar(item) && typeof item.value === 'string') item.value = swapCompound(item.value, hostMap);
        }
      }
      if (!phaseMap.size) return body;
      const setMetadata = (key, value) => {
        const node = document.getIn(['metadata', key], true);
        if (YAML.isScalar(node)) node.value = value;
      };
      const phases = phaseListText(document.getIn(['metadata', 'sflow-phases']));
      if (phases) setMetadata('sflow-phases', withRenamed(phases, phaseMap).join(','));
      const defaults = phaseListText(document.getIn(['metadata', 'sflow-default-for']));
      if (defaults) {
        setMetadata('sflow-default-for', (existing ? withRenamed(defaults, phaseMap)
          : defaults.map((phase) => phaseMap.get(phase) ?? phase).filter((phase) => !renamed || !targetPhases.has(phase))).join(','));
      }
      let next = rewriteTable(body, 'Remote skills', (cells) => { cells[2] = phaseCell(cells[2], phaseMap); return cells; });
      next = rewriteTable(next, 'Remote artifact templates', (cells) => { cells[2] = phaseCell(cells[2], phaseMap); return cells; });
      if (!existing) {
        next = rewriteTable(next, 'Remote generated artifacts', (cells) => {
          const place = generatedPlace(cells[2], cells[3], phaseMap);
          cells[2] = place.phase; cells[3] = place.target;
          return cells;
        });
      }
      return next;
    });
    const lock = bundle.agentLocks[from];
    for (const dependency of lock?.dependencies ?? []) {
      if (Array.isArray(dependency.phases)) dependency.phases = withRenamed(dependency.phases, phaseMap);
      if (dependency.type === 'generated' && !existing) Object.assign(dependency, generatedPlace(dependency.phase, dependency.target, phaseMap));
      const prefix = `${AGENT_VENDOR_ROOT}/${from}/`;
      if (renamed && typeof dependency.vendored === 'string' && dependency.vendored.startsWith(prefix)) {
        dependency.vendored = `${AGENT_VENDOR_ROOT}/${to}/${dependency.vendored.slice(prefix.length)}`;
      }
    }
    if (renamed) {
      movedPaths.set(asset.path, `${AGENT_ROOT}/${to}.agent.md`);
      asset.id = to;
      asset.path = `${AGENT_ROOT}/${to}.agent.md`;
      if (lock) {
        lock.source = asset.path;
        delete bundle.agentLocks[from];
        bundle.agentLocks[to] = lock;
      }
    }
    if (asset.content !== before) changedAgents.set(to, asset.content);
  }
  for (const dependency of bundle.requirements.externalAgentDependencies ?? []) swapField(dependency, 'agent', agentMap);
  for (const asset of bundle.assets.filter((candidate) => candidate.kind === 'vendored')) {
    if (asset.owner.kind === 'agent' && agentMap.has(asset.owner.id)) {
      const prefix = `${AGENT_VENDOR_ROOT}/${asset.owner.id}/`;
      const to = agentMap.get(asset.owner.id);
      if (asset.path.startsWith(prefix)) {
        movedPaths.set(asset.path, `${AGENT_VENDOR_ROOT}/${to}/${asset.path.slice(prefix.length)}`);
        asset.path = movedPaths.get(asset.path) ?? asset.path;
      }
      asset.owner = { kind: 'agent', id: to };
    } else if (asset.owner.kind === 'mcp-server' && serverMap.has(asset.owner.id)) {
      const to = serverMap.get(asset.owner.id);
      movedPaths.set(asset.path, `${MCP_VENDOR_ROOT}/${to}.json`);
      asset.path = `${MCP_VENDOR_ROOT}/${to}.json`;
      asset.owner = { kind: 'mcp-server', id: to };
    }
  }
  for (const [from, to] of movedPaths) if (movedPaths.has(to) && to !== from) movedPaths.delete(to);

  for (const [id, before] of skillStepsBefore) {
    const now = story.phases[phaseMap.get(id) ?? id];
    if (stable(now) !== before) {
      fail(`Skill step '${id}' is compiled against the steps, groups and artifact sets it names, and a new name here would change it. Keep or replace those instead.`);
    }
  }
  // Records of where imported files came from follow their files and owners.
  if (plain(bundle.imports)) {
    bundle.imports = Object.fromEntries(Object.entries(bundle.imports).map(([key, record]) => {
      const target = plain(record.target) ? record.target : {};
      let next = key;
      if (['skill', 'generated'].includes(record.kind) && agentMap.has(target.agent)) {
        target.agent = agentMap.get(target.agent);
        next = `${record.kind}:${target.agent}/${target.id}`;
      }
      if (record.kind === 'agent' && agentMap.has(target.id)) { target.id = agentMap.get(target.id); next = `agent:${target.id}`; }
      if (record.kind === 'mcp-server' && serverMap.has(target.id)) { target.id = serverMap.get(target.id); next = `mcp-server:${target.id}`; }
      if (record.kind === 'template' && templateMap.has(target.id)) { target.id = templateMap.get(target.id); next = `template:${target.id}`; }
      for (const [from, to] of movedPaths) if (target.path === from) { target.path = to; break; }
      if (Array.isArray(target.phases)) target.phases = withRenamed(target.phases, phaseMap);
      if (record.kind === 'generated' && !existsHere(target.agent)) Object.assign(target, generatedPlace(target.phase, target.path, phaseMap));
      if (Array.isArray(target.agents)) target.agents = target.agents.map((id) => agentMap.get(id) ?? id);
      if (Array.isArray(target.tools)) target.tools = target.tools.map((tool) => swapCompound(tool, hostMap));
      // An imported agent whose file changed with the new names: record what is on disk now.
      if (record.kind === 'agent' && changedAgents.has(target.id)) {
        record.fileSha256 = sha256Hex(changedAgents.get(target.id));
        record.transforms = [...new Set([...(Array.isArray(record.transforms) ? record.transforms : []), 'renamed-on-import'])];
      }
      return [next, record];
    }));
  }
  return bundle;
}
