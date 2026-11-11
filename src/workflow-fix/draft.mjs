/**
 * What the fixers of one `workflow fix` run have drafted so far, as the Workflow Studio change set
 * it will become. Fixers edit a template, skill, instruction or agent as text, a step's settings, a
 * workflow's fields, or add any other Studio change; later fixers read what earlier ones drafted, so
 * two fixes to one template become one `template.update`. Nothing here writes a file: `changeSet()`
 * is applied, if at all, by the reviewed proposal path (`workflow studio apply --change-set --propose`).
 *
 * Each fix is recorded (`record`): the keys it touched and, for text, its own before and after, so a
 * person reviews every fix with its diff.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { instructionPath } from '../instruction-library.mjs';
import { librarySkillPath, parseLibrarySkill } from '../skill-library.mjs';
import { WORKFLOW_PATH } from '../config.mjs';
import { unifiedDiff } from '../workflow-studio.mjs';
import { splitFrontMatter } from './text.mjs';

const keyOf = (target) => `${target.kind}:${target.id ?? target.path}`;

export class FixDraft {
  /** `raw` is workflow.yml as written; `agents` the model's agents (for their files). */
  constructor({ configRoot, templatesRoot, raw, agents = [] }) {
    this.configRoot = configRoot;
    this.templatesRoot = templatesRoot;
    this.raw = raw ?? {};
    this.agents = new Map(agents.map((agent) => [agent.id, agent]));
    this.texts = new Map();      // key -> { target, base, text, create }
    this.removed = new Map();    // key -> remove op
    this.phases = new Map();     // `${id}\0${workflow}` -> { id, workflow, fields }
    this.workflows = new Map();  // id -> { fields }
    this.ops = [];               // [{ key, op }]
    this.lines = new Map();      // configuration file -> { base, text } (a configuration that does not load)
    this.order = [];             // keys in the order first touched
    this.recording = null;
  }

  touch(key) {
    if (!this.order.includes(key)) this.order.push(key);
    if (this.recording) this.recording.keys.add(key);
  }

  /** Where a text target lives in the configuration. */
  file(target) {
    if (target.kind === 'template') return path.posix.join(this.templatesRoot, target.path);
    if (target.kind === 'skill') return librarySkillPath(target.id);
    if (target.kind === 'instruction') return instructionPath(target.id);
    if (target.kind === 'agent') return this.agents.get(target.id)?.path ?? null;
    return null;
  }

  has(target) { return this.texts.has(keyOf(target)); }
  isRemoved(target) { return this.removed.has(keyOf(target)); }

  /** A target's text as the fixes so far leave it; null when it does not exist. */
  async text(target) {
    const key = keyOf(target);
    if (this.removed.has(key)) return null;
    if (this.texts.has(key)) return this.texts.get(key).text;
    const file = this.file(target);
    const base = file ? await readFile(path.join(this.configRoot, file), 'utf8').catch(() => null) : null;
    if (base == null) return null;
    this.texts.set(key, { target, base, text: base, create: false });
    return base;
  }

  /** Change a target's text; a transform that returns null or the same text changes nothing. */
  async edit(target, transform) {
    const current = await this.text(target);
    if (current == null) return false;
    const next = await transform(current);
    if (next == null || next === current) return false;
    const entry = this.texts.get(keyOf(target));
    if (this.recording && !this.recording.before.has(keyOf(target))) this.recording.before.set(keyOf(target), current);
    entry.text = next;
    this.touch(keyOf(target));
    return true;
  }

  /** A new template (or one in place of a file that cannot be used). */
  create(target, content) {
    const key = keyOf(target);
    if (this.recording && !this.recording.before.has(key)) this.recording.before.set(key, null);
    this.texts.set(key, { target, base: null, text: content.endsWith('\n') ? content : `${content}\n`, create: true });
    this.touch(key);
  }

  /** Take away a skill, instruction or agent; any text edit to it is dropped. */
  remove(kind, id) {
    const key = keyOf({ kind, id });
    this.removed.set(key, { op: `${kind}.remove`, id });
    this.touch(key);
  }

  /** Step settings (`phase.update` fields), merged per step and workflow; `workflow` scopes per-workflow fields. */
  phase(id, fields, { workflow = null } = {}) {
    const key = `phase:${id}\0${workflow ?? ''}`;
    const entry = this.phases.get(key) ?? { id, workflow, fields: {} };
    entry.fields = { ...entry.fields, ...structuredClone(fields) };
    this.phases.set(key, entry);
    this.touch(key);
  }

  /** Whether a fix already asks for a sign-off on this step. */
  signedOff(id) {
    return [...this.phases.values()].some((entry) => entry.id === id && entry.fields.approval && entry.fields.approval !== 'none');
  }

  /** Whether a fix already wrote this step's description. */
  describes(id) {
    return [...this.phases.values()].some((entry) => entry.id === id && Object.hasOwn(entry.fields, 'description'));
  }

  /** A workflow's field as written, with the fixes so far. */
  workflowField(id, field) {
    const drafted = this.workflows.get(id)?.fields;
    if (drafted && Object.hasOwn(drafted, field)) return structuredClone(drafted[field]);
    const value = this.raw.workTypes?.[id]?.[field];
    return value === undefined ? undefined : structuredClone(value);
  }

  /** Set a workflow field for `workflow.update` (decisions, phases, plannedClaims, sourceReview, omits). */
  workflow(id, field, value) {
    const key = `workflow:${id}`;
    const entry = this.workflows.get(id) ?? { fields: {} };
    entry.fields[field] = structuredClone(value);
    this.workflows.set(id, entry);
    this.touch(key);
  }

  /** Any other Workflow Studio change, as is. */
  op(op) {
    const key = `op:${this.ops.length}`;
    this.ops.push({ key, op: structuredClone(op) });
    this.touch(key);
  }

  /** A configuration file's text as the fixes so far leave it, or null. */
  async fileText(file) {
    return this.lines.get(`file:${file}`)?.text ?? readFile(path.join(this.configRoot, file), 'utf8').catch(() => null);
  }

  /** One line of a configuration file as the fixes so far leave it. */
  async lineOf(file, line) {
    return (await this.fileText(file))?.split('\n')[line - 1] ?? null;
  }

  /** One line of a configuration file that does not load, changed as written (`configuration save`). */
  async editLine(file, line, transform, { remove = false } = {}) {
    const key = `file:${file}`;
    if (!this.lines.has(key)) {
      const base = await readFile(path.join(this.configRoot, file), 'utf8').catch(() => null);
      if (base == null) return false;
      this.lines.set(key, { file, base, text: base });
    }
    const entry = this.lines.get(key);
    const lines = entry.text.split('\n');
    if (line < 1 || line > lines.length) return false;
    const next = remove ? null : transform(lines[line - 1]);
    if (!remove && (next == null || next === lines[line - 1])) return false;
    if (this.recording && !this.recording.before.has(key)) this.recording.before.set(key, entry.text);
    if (remove) lines.splice(line - 1, 1); else lines[line - 1] = next;
    entry.text = lines.join('\n');
    this.touch(key);
    return true;
  }

  /** Run `fn` and return what it touched: its keys and, for each text it changed, its own diff. */
  async record(fn) {
    const outer = this.recording;
    this.recording = { keys: new Set(), before: new Map() };
    let value;
    try { value = await fn(); }
    finally {
      const recording = this.recording;
      this.recording = outer;
      if (outer) { for (const key of recording.keys) outer.keys.add(key); for (const [key, text] of recording.before) if (!outer.before.has(key)) outer.before.set(key, text); }
      this.lastRecording = recording;
    }
    const recording = this.lastRecording;
    const diffs = [];
    for (const [key, before] of recording.before) {
      const entry = this.texts.get(key) ?? this.lines.get(key);
      const file = entry?.file ?? (entry?.target ? this.file(entry.target) : null);
      if (!entry || this.removed.has(key)) continue;
      const diff = unifiedDiff(before, entry.text, file);
      if (diff) diffs.push({ file, diff });
    }
    return { value, keys: [...recording.keys], diffs };
  }

  /** The Workflow Studio change for one key, as the whole draft leaves it; null when it changes nothing. */
  compile(key) {
    if (this.removed.has(key)) return this.removed.get(key);
    const text = this.texts.get(key);
    if (text) {
      if (text.text === text.base) return null;
      const { target } = text;
      if (target.kind === 'template') return { op: text.create ? 'template.create' : 'template.update', path: target.path, content: text.text };
      if (target.kind === 'skill') {
        const parsed = parseLibrarySkill(text.text, { id: target.id });
        return { op: 'skill.update', id: target.id, instructions: parsed.instructions, instructionRefs: [...parsed.declaredInstructionRefs] };
      }
      const body = splitFrontMatter(text.text).body.trim();
      return target.kind === 'instruction' ? { op: 'instruction.update', id: target.id, instructions: body } : { op: 'agent.update', id: target.id, instructions: body };
    }
    if (key.startsWith('phase:')) {
      const entry = this.phases.get(key);
      return entry ? { op: 'phase.update', id: entry.id, ...(entry.workflow ? { workflow: entry.workflow } : {}), ...entry.fields } : null;
    }
    if (key.startsWith('workflow:')) {
      const id = key.slice('workflow:'.length);
      return { op: 'workflow.update', id, ...this.workflows.get(id).fields };
    }
    if (key.startsWith('op:')) return this.ops.find((entry) => entry.key === key)?.op ?? null;
    return null;
  }

  /** Every Studio change the draft holds, in the order first touched; a removal replaces any edit to what it removes. */
  studioChanges(exclude = null) {
    return this.order.filter((key) => !key.startsWith('file:') && !exclude?.has(key)).map((key) => this.compile(key)).filter(Boolean);
  }

  /** Configuration files changed as text (a configuration that does not load), each with its new content. */
  files() {
    return [...this.lines.values()].filter((entry) => entry.text !== entry.base).map((entry) => ({ path: entry.file ?? WORKFLOW_PATH, content: entry.text }));
  }
}
