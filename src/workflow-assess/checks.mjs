/**
 * The findings of `workflow assess` (SPEC-WIA): what a step's agent is told twice, what contradicts
 * the step's own settings, the platform or another rule it reads, and what is longer or vaguer than
 * it needs to be. Each finding has a severity, plain words, the exact text it is about, its file
 * and line, and, where one exists, the change that fixes it as builder moves.
 *
 * Text is judged by who owns it (src/workflow-assess/layers.mjs): the team's own text for
 * everything; SFlow's own text only for what contradicts the step it runs in, since it repeats
 * itself on purpose (each agent file must hold on its own) and changes with SFlow. The platform's
 * composed rules are the reference, never judged.
 *
 * A suggestion is `decidedBy: 'sflow'` when it only makes the text say what the step already does
 * (the step's settings and the platform decide what happens either way), so accepting it cannot
 * change how a Story runs; `decidedBy: 'person'` when it changes behavior or picks between two of
 * the team's rules, with each choice's moves.
 */
import { createHash } from 'node:crypto';
import { guidanceConflicts, scanGuidanceText } from '../guidance-scan.mjs';
import { textUsers } from '../workflow-build/text-moves.mjs';
import { bytesOf, conditionCount, containment, contentWords, occurrences, sameSentence, similarity, vaguePhrase, wordCount } from './text.mjs';

export const ASSESS_SEVERITIES = Object.freeze(['problem', 'warning', 'note']);
export const ASSESS_KINDS = Object.freeze(['contradictory', 'redundant', 'lean', 'unclear']);
const SEVERITY_ORDER = Object.freeze({ problem: 0, warning: 1, note: 2 });
// Which copy of a repeated rule stays: the agent file outlives a template's guidance.
const KEEP_ORDER = Object.freeze({ agent: 0, instruction: 1, skill: 2, workflow: 3, step: 4 });
const PER_FILE = 5;
const OVERSIZED_BYTES = 6000;
const LONG_WORDS = 40;

const NEGATED = /\b(?:never|not|don't|do not|must not|mustn't|should not|shouldn't|avoid|without|no need to|instead of)\b/iu;
const WRITES_CODE = /\b(?:write|implement|modify|change|edit|fix|refactor|update|patch|rewrite)\s+(?:the\s+|any\s+|all\s+|some\s+|new\s+|production\s+|application\s+|source\s+|its\s+|their\s+)*(?:code|source(?:\s+code)?|source files?|implementation|tests?|test files?|unit tests?)\b|\b(?:code|source) changes?\b/iu;
const ASKS = /\b(?:ask|check with|confirm with|consult)\s+(?:the\s+)?(?:user|person|people|human|requester|product owner|stakeholders?|customer|team lead)\b|\bask\s+(?:a\s+|any\s+|clarifying\s+|follow-up\s+)*questions?\b|\bask_user\b|\bvscode_askQuestions\b/iu;
const COMMITS = /\bgit\s+(?:commit|push|merge|rebase|tag)\b|\b(?:commit|push)\s+(?:your\s+|the\s+|all\s+|these\s+|any\s+|its\s+)*(?:changes?|work|files?|code|branch|commits?|fixes?)\b|\b(?:open|create|raise)\s+(?:a\s+)?(?:pull request|PR)\b|\bmerge\s+(?:the\s+)?(?:PR|pull request|branch)\b/iu;
const APPROVES = /^(?:then\s+|finally\s+|once[^,]*,\s*|when[^,]*,\s*|after[^,]*,\s*)?(?:approve|sign\s*off(?:\s+on)?|accept)\s+(?:your\s+|the\s+|this\s+|its\s+)?(?:own\s+)?(?:work|step|phase|document|artifact|report|changes?|story|it)\b/iu;
const IGNORES_TEMPLATE = /\b(?:ignore|skip|drop)\s+(?:the\s+)?template\b|\buse\s+your\s+own\s+(?:format|structure|headings|layout)\b/iu;
// Told to change an earlier step's approved document: said as an instruction, not as what the change is.
const EDITS_INPUTS = /(?:^|\b(?:then|also|and|you may|feel free to|go back and)\s+)(?:update|edit|change|rewrite|correct)\s+(?:the\s+)?(?:approved\s+)?(?:requirements|specification|spec|plan|design)(?:\s+document)?\b/iu;
const BARE_CLAUSE = /(?<![\w:[{-])(?:REQ|AC)-\d{1,4}\b/u;
const NUMBERING = /\b(?:number|label|prefix|id|ids|identifier)\b/iu;
const RUNS_COMMAND = /`[^`\n]+`|\brun\s+(?:the\s+)?(?:tests?|linter|build|script|command)/iu;
const EXECUTE_TOOLS = ['execute', 'bash', 'terminal', 'shell', 'runcommands', 'run_in_terminal', 'runinterminal', 'run', '*'];
// "Use the Jira MCP server", "through the figma MCP tools": an MCP server the text sends the agent to.
const MCP_NAMED = [/\b(?:use|using|with|via|through|call|open|query)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9-]{1,40})\s+MCP\b/giu, /\bMCP\s+server\s+[`"']?([A-Za-z][A-Za-z0-9-]{1,40})/giu];
const NOT_A_SERVER = new Set(['the', 'an', 'a', 'any', 'this', 'that', 'its', 'your', 'governed', 'local', 'remote', 'live', 'pinned', 'and', 'or', 'an', 'every', 'each', 'its', 'own']);
const SCRIPT_PATH = /(?:^|[\s`(])((?:\.\/)?(?:scripts?|bin|tools)\/[\w./-]+\.(?:sh|mjs|cjs|js|py|ps1))\b/gu;
const SECTION_DEMANDS = [
  /(?:^|[\s`"'])#{2,4}\s+([A-Z][^`"'\n#]{2,60}?)(?=[`"']|\s*$)/gu,
  /\b(?:add|include|write|create|fill(?:\s+in)?|complete)\s+(?:a|an|the)\s+["'`]([^"'`]{2,60})["'`]\s+section\b/giu,
  /\bsection\s+(?:called|named|titled|headed)\s+["'`]([^"'`]{2,60})["'`]/giu,
  /\bunder\s+(?:the\s+)?(?:heading\s+)?["'`]([^"'`]{2,60})["'`](?:\s+(?:heading|section))?/giu
];

const shortHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
const possessive = (name) => (/s$/u.test(String(name)) ? `${name}'` : `${name}'s`);
const listed = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const quoted = (text, limit = 240) => { const value = String(text).replace(/\s+/gu, ' ').trim(); return value.length > limit ? `${value.slice(0, limit - 1)}…` : value; };
const headingKey = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();

/**
 * One step's units: its layers' sentences with their words, and the platform's own sentences.
 * `sentences` are every sentence of a repository file this step's agent reads.
 */
function stepUnits(step) {
  const sentences = [];
  for (const layer of step.layers) {
    if (layer.layer === 'platform' || !layer.source) continue;
    for (const sentence of layer.source.sentences) sentences.push({ ...sentence, layer, words: contentWords(sentence.text) });
  }
  const platform = step.layers.filter((layer) => layer.layer === 'platform')
    .flatMap((layer) => layer.text.split(/(?<=[.!?])\s+|\n+/u).map((text) => text.replace(/^[-#>*\s]+/u, '').trim()).filter((text) => wordCount(text) >= 4))
    .map((text) => ({ text, words: contentWords(text) }));
  return { sentences, platform };
}

/** The span that removes `units` (one sentence, or a run of them in one block) from their file, whitespace included. */
function removalSpan(source, units) {
  const text = source.text;
  const first = units[0];
  const last = units.at(-1);
  const inBlock = source.sentences.filter((sentence) => sentence.block === first.block);
  const firstIndex = inBlock.findIndex((sentence) => sentence.start === first.start);
  const lastIndex = inBlock.findIndex((sentence) => sentence.start === last.start);
  if (firstIndex === 0 && lastIndex === inBlock.length - 1 && first.block === last.block) {
    // The whole paragraph or list item: its lines, and one blank line beside it.
    const lineStart = text.lastIndexOf('\n', first.block.start - 1) + 1;
    let end = text.indexOf('\n', first.block.end);
    end = end < 0 ? text.length : end + 1;
    const after = /^[ \t]*\n/u.exec(text.slice(end));
    const before = text.slice(0, lineStart).endsWith('\n\n') || lineStart === 0;
    if (after && before) end += after[0].length;
    return [lineStart, end];
  }
  if (lastIndex < inBlock.length - 1) return [first.start, inBlock[lastIndex + 1].start];
  return [inBlock[firstIndex - 1].end, last.end];
}

/** A section (its heading and everything under it) as a span to remove. */
function sectionSpan(source, heading) {
  const lines = source.lines;
  const index = lines.findIndex((entry) => entry.line === heading.line);
  const next = lines.slice(index + 1).find((entry) => entry.kind === 'heading' && entry.heading.level <= heading.level);
  return [lines[index].start, next ? next.start : source.text.length];
}

/**
 * The exact `old` and `new` for replacing `[start, end)` of a layer's file with `replacement`, as
 * the move's own text (the view) has it: widened by whole lines until it occurs there once.
 */
function editFor(layer, [start, end], replacement = '') {
  const view = layer.view;
  const text = layer.source?.text;
  if (view == null || text == null) return null;
  let [from, to] = [start, end];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const old = text.slice(from, to);
    const found = occurrences(view, old);
    if (found === 1) return { old, new: text.slice(from, start) + replacement + text.slice(end, to) };
    if (!found) {
      // The view leaves out what the file has around it (an agent's view is trimmed): quote the text itself.
      const trimmed = old.trim();
      if (!trimmed || trimmed === old || occurrences(view, trimmed) !== 1) return null;
      const lead = from + old.indexOf(trimmed);
      const tail = lead + trimmed.length;
      return { old: trimmed, new: `${text.slice(lead, Math.max(lead, start))}${replacement}${text.slice(Math.min(tail, end), tail)}`.trim() ? `${text.slice(lead, Math.max(lead, start))}${replacement}${text.slice(Math.min(tail, end), tail)}` : '' };
    }
    from = Math.max(0, text.lastIndexOf('\n', from - 2) + 1);
    const next = text.indexOf('\n', to);
    to = next < 0 ? text.length : next + 1;
  }
  return null;
}

/**
 * The builder move that makes an edit to a layer, and whether it can be made: an agent or skill
 * other workflows use is changed on a copy this workflow uses; a shared instruction cannot be.
 */
function moveFor(layer, step, edit, { model, workflowId }) {
  if (!edit || !layer.target || layer.owner === 'platform') return { move: null, blocked: layer.target ? null : 'SFlow\'s own text changes with SFlow.' };
  const { kind, id } = layer.target;
  const users = textUsers(model, kind, id, workflowId, step.id);
  const copy = users.length ? `${id}-${workflowId}`.slice(0, 64) : null;
  if (kind === 'agent') return { move: { move: 'agent.edit', agent: id, old: edit.old, new: edit.new, ...(copy ? { copy } : {}) }, users };
  if (kind === 'skill') return { move: { move: 'skill.edit', skill: id, old: edit.old, new: edit.new, ...(copy ? { copy } : {}) }, users };
  if (kind === 'instruction') {
    return users.length ? { move: null, blocked: `Instruction ${layer.label} is also used by ${listed(users)}; change it in Workflow Studio for all of them, or take it out of this workflow's skill.` }
      : { move: { move: 'instruction.edit', instruction: id, old: edit.old, new: edit.new }, users };
  }
  if (kind === 'template') return { move: { move: 'step.change', id: step.id, edit: { old: edit.old, new: edit.new } }, users };
  return { move: null, blocked: null };
}

/** The move for an exact edit a person or Copilot gives (`old` as the file has it), when it occurs once in the move's text. */
export function moveForEdit(layer, step, edit, context) {
  const found = occurrences(layer.view ?? '', edit.old);
  if (found !== 1) {
    return { move: null, blocked: found ? `The quoted text occurs ${found} times in ${layer.label}.` : `${layer.label} cannot be edited at that text.`,
      repair: 'Quote more of the text around it, so it occurs once.' };
  }
  return moveFor(layer, step, edit, context);
}

/** The workflow's findings collector: one finding per subject, located, with its suggestion. */
function collector(workflow) {
  const findings = new Map();
  return {
    add(entry) {
      const key = [entry.code, entry.location?.file ?? null, entry.location?.line ?? null, entry.quote ?? null, entry.subjectKey ?? null];
      const id = `af-${shortHash([workflow.id, ...key])}`;
      const existing = findings.get(id);
      if (existing) { existing.steps = [...new Set([...existing.steps, ...entry.steps])]; return existing; }
      const { subjectKey, ...rest } = entry;
      const finding = { id, by: 'sflow', ...rest, steps: [...new Set(entry.steps)] };
      findings.set(id, finding);
      return finding;
    },
    list: () => [...findings.values()]
  };
}

/** A suggestion that removes text, with what it saves for each step that reads it. */
function removal({ layer, step, span, reach, context, text, also = [] }) {
  const edit = editFor(layer, span);
  const { move, blocked } = moveFor(layer, step, edit, context);
  const extra = also.map((entry) => moveFor(entry.layer, entry.step, editFor(entry.layer, entry.span), context));
  const moves = move && extra.every((entry) => entry.move) ? [move, ...extra.map((entry) => entry.move)] : [];
  const bytes = edit ? bytesOf(edit.old) - bytesOf(edit.new) : bytesOf(layer.source.text.slice(...span));
  return { text, decidedBy: 'sflow', moves, ...(moves.length ? {} : { blocked: blocked ?? extra.find((entry) => entry.blocked)?.blocked ?? 'The text cannot be quoted so that it occurs once; edit it by hand.' }),
    saving: { bytes: bytes * reach, tokens: Math.ceil(Math.max(0, bytes) / 4) * reach, perStep: bytes, steps: reach } };
}

/** Run every check over one workflow's steps (src/workflow-assess/layers.mjs). */
export function assessSteps({ workflow, steps, model, definition, applicationExists }) {
  const out = collector(workflow);
  const context = { model, workflowId: workflow.id };
  const reachOf = new Map();
  for (const step of steps) for (const layer of step.layers) if (layer.key) reachOf.set(layer.key, [...(reachOf.get(layer.key) ?? []), step.id]);
  const reach = (layer) => new Set(reachOf.get(layer.key) ?? []).size;
  const stepsOf = (layer) => [...new Set(reachOf.get(layer.key) ?? [])];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const units = new Map(steps.map((step) => [step.id, stepUnits(step)]));
  const at = (sentence) => ({ file: sentence.file, line: sentence.line });
  const sentenceFinding = (sentence, step, fields) => out.add({ ...fields, steps: [step.id], location: at(sentence), quote: quoted(sentence.text, 400), owner: sentence.owner });

  // ---- Contradictory: what the step's settings, the platform or another rule says otherwise.
  for (const step of steps) {
    const { sentences } = units.get(step.id);
    const settings = step.settings;
    for (const sentence of sentences) {
      const layer = sentence.layer;
      const others = stepsOf(layer).map((id) => byId.get(id));
      const negated = NEGATED.test(sentence.text);
      const span = removalSpan(layer.source, [sentence]);
      if (!settings.changesCode && !negated && WRITES_CODE.test(sentence.text) && layer.layer !== 'step') {
        const coding = others.filter((other) => other.settings.changesCode);
        sentenceFinding(sentence, step, { code: 'ASSESS_WRITES_CODE_IN_NO_CODE_STEP', kind: 'contradictory', severity: 'problem',
          title: `${step.label} is told to change code, but it changes no code`,
          detail: `${step.label} writes only its own document (write scope ${settings.writeScope}), so the step's guard refuses every edit to the repository's files: an agent that follows "${quoted(sentence.text, 120)}" is refused and stalls.`,
          suggestion: coding.length
            ? { text: `${layer.label} also drafts ${listed(coding.map((other) => other.label))}, which changes code: say in that sentence which step it is for.`, decidedBy: 'person', moves: [] }
            : { ...removal({ layer, step, span, reach: reach(layer), context, text: `Take the sentence out: ${step.label} reports what it finds and a later step changes the code. If ${step.label} should change code itself, change the step instead (Workflow Studio: may change code).` }) } });
      }
      if (settings.clarification === 'off' && settings.authorIsAgent && !negated && ASKS.test(sentence.text)) {
        const asking = others.filter((other) => other.settings.clarification !== 'off');
        sentenceFinding(sentence, step, { code: 'ASSESS_ASKS_WITH_CLARIFICATION_OFF', kind: 'contradictory', severity: 'warning',
          title: `${step.label} is told to ask a person, but it asks nothing`,
          detail: `${possessive(step.label)} clarifying questions are off, so the platform tells its agent not to ask and refuses to record an answer; "${quoted(sentence.text, 120)}" says the opposite, and an agent that follows it stops to wait for a reply nobody can record.`,
          suggestion: asking.length
            ? { text: `${layer.label} also drafts ${listed(asking.map((other) => other.label))}, which asks: say in that sentence which step it is for.`, decidedBy: 'person', moves: [] }
            : { ...removal({ layer, step, span, reach: reach(layer), context, text: `Take the sentence out. If ${step.label} should ask, turn its clarifying questions on instead (when-needed).` }),
              alternatives: [{ id: 'ask', label: `Let ${step.label} ask when something material is unclear`, moves: [{ move: 'step.clarify', id: step.id, mode: 'when-needed', maxQuestions: 3 }] }] } });
      }
      if (!negated && COMMITS.test(sentence.text)) {
        sentenceFinding(sentence, step, { code: 'ASSESS_COMMITS_WHERE_KERNEL_COMMITS', kind: 'contradictory', severity: 'problem',
          title: `${step.label} is told to commit or push, which SFlow does`,
          detail: `SFlow records each step's work itself when the step is published; a commit, push or pull request the agent makes changes the branch outside that record, and the step's guard reports it. "${quoted(sentence.text, 120)}"`,
          suggestion: removal({ layer, step, span, reach: reach(layer), context, text: 'Take the sentence out: publishing the step commits its work.' }) });
      }
      if (!negated && APPROVES.test(sentence.text)) {
        sentenceFinding(sentence, step, { code: 'ASSESS_CONTRADICTS_PLATFORM', kind: 'contradictory', severity: 'problem',
          title: `${step.label} is told to approve work, which only a person does`,
          detail: `A step is approved by the people of its approval group in their own review, never by its agent; "${quoted(sentence.text, 120)}" asks the agent for something the platform refuses.`,
          suggestion: removal({ layer, step, span, reach: reach(layer), context, text: 'Take the sentence out; the step\'s sign-off is set in its approval settings.' }) });
      }
      if (!negated && IGNORES_TEMPLATE.test(sentence.text) && settings.template) {
        sentenceFinding(sentence, step, { code: 'ASSESS_CONTRADICTS_PLATFORM', kind: 'contradictory', severity: 'warning',
          title: `${step.label} is told to set its template aside`,
          detail: `The step's template is the shape its document is checked against when it is published; "${quoted(sentence.text, 120)}" tells the agent to write something publication then refuses.`,
          suggestion: removal({ layer, step, span, reach: reach(layer), context, text: 'Take the sentence out, and put the shape the team wants into the template.' }) });
      }
      const earlierScope = steps.slice(0, steps.indexOf(step)).some((other) => other.settings.definesClauses);
      if (!negated && earlierScope && !step.settings.definesClauses && EDITS_INPUTS.test(sentence.text)) {
        sentenceFinding(sentence, step, { code: 'ASSESS_CONTRADICTS_PLATFORM', kind: 'contradictory', severity: 'warning',
          title: `${step.label} is told to change an approved earlier document`,
          detail: `What earlier steps approved is fixed evidence: the platform tells the agent never to edit it and to record a discrepancy instead. "${quoted(sentence.text, 120)}"`,
          suggestion: { text: 'Say what to do instead: list the problem under the document\'s Upstream discrepancies section.', decidedBy: 'person', moves: [] } });
      }
      if (sentence.owner === 'team' && layer.layer !== 'step' && BARE_CLAUSE.test(sentence.text)) {
        const numbering = NUMBERING.test(sentence.text) && !others.some((other) => other.settings.definesClauses);
        sentenceFinding(sentence, step, { code: 'ASSESS_BARE_CLAUSE_NUMBERS', kind: 'contradictory', severity: 'warning',
          title: `${step.label} is told to use bare REQ-/AC- numbers`,
          detail: `Clause IDs carry the Story's namespace, like <WORK-ID>:REQ-001, and only the step that defines the requirements numbers them; the platform tells ${possessive(step.label)} agent that this overrides any guidance that numbers them, so "${quoted(sentence.text, 120)}" is set aside in every Story.`,
          suggestion: numbering ? removal({ layer, step, span, reach: reach(layer), context, text: 'Take the numbering out: the step that defines the requirements numbers them, and every later step cites them by full ID.' })
            : { text: 'Write the full ID, like <WORK-ID>:REQ-001, wherever a clause is cited.', decidedBy: 'person', moves: [] } });
      }
      // Tools, MCP servers and scripts the text sends the agent to that the step does not have.
      const tools = (step.agent?.tools ?? []).map((tool) => String(tool).toLowerCase());
      if (tools.length && !tools.some((tool) => EXECUTE_TOOLS.includes(tool.replace(/\/.*$/u, ''))) && RUNS_COMMAND.test(sentence.text) && scanGuidanceText(sentence.text).commands.length) {
        sentenceFinding(sentence, step, { code: 'ASSESS_TOOL_UNAVAILABLE', kind: 'contradictory', severity: 'warning',
          title: `${step.label} is told to run a command its agent cannot run`,
          detail: `${step.agent.label} has no tool that runs commands (its tools: ${tools.join(', ')}), so "${quoted(sentence.text, 120)}" cannot be done.`,
          suggestion: { text: `Give ${step.agent.label} the execute tool, or take the command out.`, decidedBy: 'person', moves: [] } });
      }
      for (const pattern of negated ? [] : MCP_NAMED) {
        for (const match of sentence.text.matchAll(pattern)) {
          const name = match[1].toLowerCase();
          if (NOT_A_SERVER.has(name)) continue;
          const servers = Object.entries(definition.mcpServers ?? {});
          const named = (id, server) => id.toLowerCase() === name || String(server?.hostReference ?? '').toLowerCase() === name;
          const configured = servers.some(([id, server]) => named(id, server));
          // A name nobody configured is a server only when it is written as one (Jira, GitHub), never a plain word.
          if (!configured && !/^[A-Z]/u.test(match[1])) continue;
          const here = servers.filter(([id]) => settings.mcpServers.includes(id)).some(([id, server]) => named(id, server))
            || tools.some((tool) => tool === `${name}/*` || tool.startsWith(`${name}/`));
          if (here) continue;
          sentenceFinding(sentence, step, { code: 'ASSESS_TOOL_UNAVAILABLE', kind: 'contradictory', severity: 'warning', subjectKey: name,
            title: `${step.label} is told to use the ${match[1]} MCP server, which it does not have`,
            detail: configured ? `${match[1]} is configured, but not for ${step.label} or its agent, so the agent never sees its tools.`
              : `No MCP server called ${match[1]} is configured in this repository, so the agent never sees its tools.`,
            suggestion: { text: configured ? `Give ${step.label} the ${match[1]} server in Workflow Studio, or take the sentence out.` : 'Add the server in Workflow Studio, or take the sentence out.', decidedBy: 'person', moves: [] } });
        }
      }
      for (const match of sentence.text.matchAll(SCRIPT_PATH)) {
        const script = match[1].replace(/^\.\//u, '');
        if (!applicationExists || applicationExists(script)) continue;
        sentenceFinding(sentence, step, { code: 'ASSESS_TOOL_UNAVAILABLE', kind: 'contradictory', severity: 'warning', subjectKey: script,
          title: `${step.label} is told to run ${script}, which the repository does not have`,
          detail: `"${quoted(sentence.text, 120)}" names ${script}; there is no such file in this repository, so the agent cannot run it.`,
          suggestion: { text: `Add ${script} to the repository, or correct its path.`, decidedBy: 'person', moves: [] } });
      }
      // Sections it demands that the step's template does not have.
      if (sentence.owner === 'team' && layer.layer !== 'step') {
        const headings = new Set(others.flatMap((other) => other.settings.templateHeadings).map(headingKey));
        if (!others.some((other) => other.settings.template) || !headings.size) continue;
        for (const pattern of SECTION_DEMANDS) {
          for (const match of sentence.text.matchAll(pattern)) {
            const wanted = match[1].trim();
            if (headings.has(headingKey(wanted)) || [...headings].some((heading) => heading.includes(headingKey(wanted)))) continue;
            const template = step.layers.find((entry) => entry.layer === 'step');
            const tail = template?.source ? template.source.text.replace(/\s+$/u, '') : '';
            const appendOld = tail ? tail.slice(tail.lastIndexOf('\n') + 1) : null;
            const appendMove = template && appendOld && occurrences(template.view ?? '', appendOld) === 1
              ? moveFor(template, step, { old: appendOld, new: `${appendOld}\n\n## ${wanted}\n\nTODO: ${wanted}.` }, context).move : null;
            sentenceFinding(sentence, step, { code: 'ASSESS_SECTION_NOT_IN_TEMPLATE', kind: 'contradictory', severity: 'warning', subjectKey: wanted,
              title: `${step.label} is told to write a "${wanted}" section its template does not have`,
              detail: `The template ${settings.template} has no "${wanted}" heading, so the agent either adds a section the template never asks for or leaves out what the team wants.`,
              suggestion: { text: `Add the section to the template, or take the demand out.`, decidedBy: 'person', moves: [],
                alternatives: [
                  ...(appendMove ? [{ id: 'template', label: `Add a "${wanted}" section to ${settings.template}`, moves: [appendMove] }] : []),
                  ...(() => { const taken = removal({ layer, step, span, reach: reach(layer), context, text: '' }); return taken.moves.length ? [{ id: 'remove', label: 'Take the demand out', moves: taken.moves }] : []; })()
                ] } });
          }
        }
      }
    }
    // Rules that cannot both be followed, across every layer of the step (the platform's included).
    const sources = step.layers.map((layer) => ({ file: layer.file ?? `${layer.label}`, layer, scan: scanGuidanceText(layer.layer === 'platform' ? layer.text : layer.source?.text ?? layer.text) }));
    for (const conflict of guidanceConflicts(sources.map(({ file, scan }) => ({ file, scan })))) {
      const sideOf = (end) => {
        const source = sources.find((entry) => entry.file === end.file);
        if (!source || source.layer.layer === 'platform') return { source, sentence: null, owner: 'platform' };
        const sentence = source.layer.source?.sentences.find((entry) => entry.line <= end.line && entry.endLine >= end.line && entry.text.includes(end.text.slice(0, 20)))
          ?? source.layer.source?.sentences.find((entry) => entry.line === end.line) ?? null;
        return { source, sentence, owner: sentence?.owner ?? source.layer.owner };
      };
      const [first, second] = [sideOf(conflict.first), sideOf(conflict.second)];
      const team = [first, second].filter((side) => side.owner === 'team' && side.sentence);
      if (!team.length) continue;
      const located = team[0];
      const other = located === first ? second : first;
      const otherWhere = other.owner === 'platform' ? 'the platform\'s rules for this step' : `${other.source.file} line ${(other === first ? conflict.first : conflict.second).line}`;
      const choices = [first, second].filter((side) => side.owner === 'team' && side.sentence).map((side) => {
        const keep = side === first ? second : first;
        const taken = removal({ layer: side.source.layer, step, span: removalSpan(side.source.layer.source, [side.sentence]), reach: reach(side.source.layer), context, text: '' });
        const kept = quoted(keep.sentence?.text ?? (keep === first ? conflict.first.text : conflict.second.text), 80).replace(/[.;:]+$/u, '');
        return taken.moves.length ? { id: `keep-${keep === first ? 'first' : 'second'}`, label: `Keep "${kept}"`, moves: taken.moves } : null;
      }).filter(Boolean);
      const platformWins = other.owner !== 'team';
      out.add({ code: 'ASSESS_RULES_CONFLICT', kind: 'contradictory', severity: 'warning', steps: [step.id], owner: 'team',
        title: `${step.label} reads two rules that may not both be followed`,
        detail: `"${quoted(conflict.first.text, 140)}" and "${quoted(conflict.second.text, 140)}" (${otherWhere}) say opposite things about ${conflict.summary}.`,
        location: at(located.sentence), quote: quoted(located.sentence.text, 400),
        related: other.owner === 'platform' ? [] : [{ file: other.source.file, line: (other === first ? conflict.first : conflict.second).line }],
        suggestion: platformWins
          ? { ...removal({ layer: located.source.layer, step, span: removalSpan(located.source.layer.source, [located.sentence]), reach: reach(located.source.layer), context,
            text: `Take the team's rule out: ${other.owner === 'platform' ? 'the platform\'s' : 'SFlow\'s'} rule holds in every Story.` }) }
          : { text: 'Keep one of the two rules, or say when each applies.', decidedBy: 'person', moves: [], alternatives: choices } });
    }
  }

  // ---- Redundant: the same rule twice for one step, a platform rule restated, a rule in many steps' files.
  const pairs = [];
  for (const step of steps) {
    const { sentences, platform } = units.get(step.id);
    const team = sentences.filter((sentence) => sentence.owner === 'team' && new Set(sentence.words).size >= 5);
    for (let i = 0; i < team.length; i += 1) {
      for (let j = i + 1; j < team.length; j += 1) {
        const [a, b] = [team[i], team[j]];
        if (a.file === b.file && a.start === b.start) continue;
        if (sameSentence(a.words, b.words)) pairs.push({ step, a, b });
      }
    }
    for (const sentence of sentences.filter((entry) => entry.owner === 'team')) {
      const words = sentence.words;
      if (new Set(words).size < 6) continue;
      const match = platform.find((rule) => similarity(words, rule.words) >= 0.6
        || (containment(words, rule.words) >= 0.8 && new Set(words).size >= 7 && rule.words.length <= 3 * words.length));
      if (!match) continue;
      const layer = sentence.layer;
      // Removed only where every step that reads it is told the same by the platform.
      const covered = stepsOf(layer).every((id) => units.get(id).platform.some((rule) => similarity(words, rule.words) >= 0.6 || containment(words, rule.words) >= 0.8));
      sentenceFinding(sentence, step, { code: 'ASSESS_RESTATES_PLATFORM', kind: 'redundant', severity: 'note',
        title: `${layer.label} repeats what the platform already tells ${possessive(step.label)} agent`,
        detail: `The platform's own rules for this step say "${quoted(match.text, 160)}"; every Story's prompt carries it, so this copy only adds length and can drift from it.`,
        suggestion: covered ? removal({ layer, step, span: removalSpan(layer.source, [sentence]), reach: reach(layer), context, text: 'Take the sentence out; the platform says it in every step that reads it.' })
          : { text: `Keep it: some steps ${layer.label} reaches are not told this by the platform.`, decidedBy: 'person', moves: [] } });
    }
  }
  // Within one step: keep the copy every reader of the other one also reads.
  const seenPair = new Set();
  const runs = [];
  for (const { step, a, b } of pairs) {
    const rank = (sentence) => KEEP_ORDER[sentence.layer.layer] ?? 5;
    const [keep, drop] = rank(a) < rank(b) || (rank(a) === rank(b) && (a.file < b.file || (a.file === b.file && a.start < b.start))) ? [a, b] : [b, a];
    const key = `${keep.file}:${keep.start}\u0000${drop.file}:${drop.start}`;
    if (seenPair.has(key)) { runs.find((run) => run.key === key)?.steps.add(step.id); continue; }
    seenPair.add(key);
    runs.push({ key, keep, drop, steps: new Set([step.id]), step });
  }
  runs.sort((left, right) => (left.drop.file === right.drop.file ? left.drop.start - right.drop.start : left.drop.file < right.drop.file ? -1 : 1));
  const merged = [];
  for (const run of runs) {
    const last = merged.at(-1);
    const between = last && last.drops.at(-1).file === run.drop.file && last.keep.file === run.keep.file ? run.drop.layer.source.text.slice(last.drops.at(-1).end, run.drop.start) : null;
    if (last && between != null && !between.trim()) { last.drops.push(run.drop); last.keeps.push(run.keep); run.steps.forEach((id) => last.steps.add(id)); continue; }
    merged.push({ keep: run.keep, keeps: [run.keep], drops: [run.drop], steps: run.steps, step: run.step });
  }
  for (const run of merged) {
    const [drop, keep] = [run.drops[0], run.keep];
    const keepReaches = new Set(stepsOf(keep.layer));
    const safe = stepsOf(drop.layer).every((id) => keepReaches.has(id)) && !(drop.file === keep.file && run.drops.some((entry) => run.keeps.includes(entry)));
    const sameFile = drop.file === keep.file;
    out.add({ code: 'ASSESS_REPEATED_IN_STEP', kind: 'redundant', severity: 'note', steps: [...run.steps], owner: 'team',
      title: sameFile ? `${drop.layer.label} says the same thing twice` : `${possessive(run.step.label)} agent is told the same thing twice: in ${keep.layer.label} and ${drop.layer.label}`,
      detail: `"${quoted(drop.text, 160)}" is also at ${keep.file} line ${keep.line}${run.drops.length > 1 ? `, with the ${run.drops.length - 1} sentence${run.drops.length === 2 ? '' : 's'} after it` : ''}: the agent reads both, and a later edit to one leaves them saying different things.`,
      location: at(drop), quote: quoted(run.drops.map((entry) => entry.text).join(' '), 400), related: [{ file: keep.file, line: keep.line }],
      suggestion: safe ? removal({ layer: drop.layer, step: run.step, span: removalSpan(drop.layer.source, run.drops), reach: reach(drop.layer), context,
        text: `Keep it in ${keep.layer.label} (${keep.file} line ${keep.line}) and take this copy out.` })
        : { text: `Keep one copy where every step that needs it reads it; ${keep.layer.label} does not reach every step ${drop.layer.label} does.`, decidedBy: 'person', moves: [] } });
  }
  // Across steps: one rule in several files that reach different steps; one shared instruction would do.
  const everyTeam = [];
  for (const step of steps) for (const sentence of units.get(step.id).sentences) {
    if (sentence.owner !== 'team' || new Set(sentence.words).size < 5 || sentence.layer.layer === 'step') continue;
    if (!everyTeam.some((entry) => entry.file === sentence.file && entry.start === sentence.start)) everyTeam.push(sentence);
  }
  const clusters = [];
  for (const sentence of everyTeam) {
    const home = clusters.find((cluster) => cluster.some((entry) => entry.file !== sentence.file && sameSentence(entry.words, sentence.words)));
    if (home) { if (!home.some((entry) => entry.file === sentence.file)) home.push(sentence); }
    else clusters.push([sentence]);
  }
  for (const cluster of clusters.filter((entries) => entries.length >= 2)) {
    const reached = [...new Set(cluster.flatMap((entry) => stepsOf(entry.layer)))];
    if (reached.length < 2) continue;
    const [first] = cluster;
    const sources = cluster.map((entry) => {
      const edit = editFor(entry.layer, removalSpan(entry.layer.source, [entry]));
      const kind = entry.layer.target?.kind;
      const users = kind ? textUsers(model, kind, entry.layer.target.id, workflow.id, stepsOf(entry.layer)[0]) : ['SFlow'];
      return { entry, edit, kind, users };
    });
    const blocked = sources.find((source) => !source.edit || !source.kind || source.users.length || source.kind === 'template');
    const slug = (first.text.toLowerCase().match(/[a-z0-9]+/gu) ?? []).filter((word) => word.length > 2 && !['the', 'and', 'for', 'with', 'every', 'each', 'your'].includes(word)).slice(0, 4).join('-').slice(0, 40) || 'rule';
    const id = `${workflow.id}-${slug}`.replace(/-+$/u, '').slice(0, 60);
    // Each step it reaches then reads the rule once, in the instruction, and the skill's one line that places it.
    const delivered = bytesOf(first.text) + bytesOf(`- <instruction>${id}</instruction>`);
    const removed = sources.reduce((sum, source) => sum + (source.edit ? (bytesOf(source.edit.old) - bytesOf(source.edit.new)) * reach(source.entry.layer) : 0), 0);
    out.add({ code: 'ASSESS_REPEATED_ACROSS_STEPS', kind: 'redundant', severity: 'note', steps: reached, owner: 'team', subjectKey: cluster.map((entry) => entry.file).join(','),
      title: `${cluster.length} files tell ${reached.length} steps the same rule`,
      detail: `"${quoted(first.text, 160)}" is written in ${listed(cluster.map((entry) => `${entry.file} line ${entry.line}`))}. One shared instruction that these steps read keeps it in one place, so it cannot drift.`,
      location: at(first), quote: quoted(first.text, 400), related: cluster.slice(1).map((entry) => ({ file: entry.file, line: entry.line })),
      suggestion: blocked
        ? { text: 'Keep it in one shared instruction these steps read.', decidedBy: 'person', moves: [],
          blocked: blocked.users?.length ? `${blocked.entry.layer.label} is also used by ${listed(blocked.users)}, which would lose the rule.` : `${blocked.entry.layer.label} cannot be edited by a move here.` }
        : { text: `Move it into one instruction, ${id}, that ${listed(reached.map((stepId) => byId.get(stepId).label))} read, and take it out of each file.`, decidedBy: 'sflow',
          moves: [{ move: 'instruction.extract', id, label: quoted(first.text, 60), description: `A rule ${possessive(workflow.label)} steps share: ${quoted(first.text, 100)}`, text: first.text,
            steps: reached, from: sources.map((source) => ({ [source.kind === 'template' ? 'step' : source.kind]: source.entry.layer.target.id, old: source.edit.old })) }],
          saving: { bytes: removed - delivered * reached.length, tokens: Math.round((removed - delivered * reached.length) / 4), steps: reached.length } } });
  }

  // ---- Lean and clear: oversized steps, other steps' work, vague, nested and long sentences.
  const teamBytes = new Map(steps.map((step) => [step.id, step.layers.filter((layer) => layer.delivered !== 'on-demand').reduce((sum, layer) => sum + (layer.teamBytes ?? 0), 0)]));
  const sizes = [...teamBytes.values()].sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : 0;
  for (const step of steps) {
    const bytes = teamBytes.get(step.id);
    if (bytes <= OVERSIZED_BYTES || bytes <= 2 * Math.max(median, 1)) continue;
    const sections = step.layers.filter((layer) => layer.owner === 'team' && layer.source).flatMap((layer) => layer.sections
      .filter((section) => section.level >= 2).map((section) => ({ ...section, file: layer.file, label: layer.label })))
      .sort((a, b) => b.bytes - a.bytes).slice(0, 3);
    const target = Math.max(median, 3000);
    const biggest = sections[0];
    out.add({ code: 'ASSESS_STEP_OVERSIZED', kind: 'lean', severity: 'warning', steps: [step.id], owner: 'team',
      title: `${possessive(step.label)} instructions are much longer than its other steps' (${bytes.toLocaleString('en-US')} bytes, about ${Math.ceil(bytes / 4).toLocaleString('en-US')} tokens)`,
      detail: `The team's text this step's agent reads is ${bytes.toLocaleString('en-US')} bytes; the workflow's typical step has ${median.toLocaleString('en-US')} bytes. `
        + `${sections.length ? `The biggest sections: ${sections.map((section) => `${section.title} (${section.file} line ${section.line}, ${section.bytes.toLocaleString('en-US')} bytes)`).join(', ')}. ` : ''}`
        + 'Every byte is read on every run and every rework of this step; background, history and notes the step never acts on crowd out what it must do.',
      location: biggest ? { file: biggest.file, line: biggest.line } : null, quote: biggest ? biggest.title : null,
      suggestion: { text: `Keep what ${step.label} acts on; move background and history to a document the team reads, not the agent. Cutting to about ${target.toLocaleString('en-US')} bytes saves about ${(bytes - target).toLocaleString('en-US')} bytes on every run.`,
        decidedBy: 'person', moves: [], saving: { bytes: bytes - target, tokens: Math.round((bytes - target) / 4), steps: 1 } } });
  }
  // Instructions for another step's work: a section, or a sentence, about a step this file's agent never drafts.
  const prefix = (() => {
    const first = steps.map((step) => String(step.label).split(/\s+/u)[0].toLowerCase());
    return steps.length > 1 && first.every((word) => word === first[0]) ? first[0] : null;
  })();
  const namesOf = (other) => [other.id.toLowerCase(), String(other.label).toLowerCase(),
    ...(prefix && String(other.label).toLowerCase().startsWith(`${prefix} `) ? [String(other.label).toLowerCase().slice(prefix.length + 1)] : [])].filter((name) => name.length >= 5);
  for (const step of steps) {
    for (const layer of step.layers.filter((entry) => entry.owner === 'team' && entry.source && entry.layer !== 'step')) {
      const readers = new Set(stepsOf(layer));
      for (const other of steps.filter((entry) => !readers.has(entry.id))) {
        const names = namesOf(other);
        const flagged = [];
        for (const section of layer.source.sections.filter((entry) => entry.level >= 2)) {
          if (!names.includes(headingKey(section.title)) && !names.some((name) => headingKey(section.title) === headingKey(name))) continue;
          flagged.push(section);
          out.add({ code: 'ASSESS_OTHER_STEP_WORK', kind: 'lean', severity: 'warning', steps: [...readers], owner: 'team', subjectKey: other.id,
            title: `${layer.label} has a section for ${other.label}, a step its readers never do`,
            detail: `"${section.title}" (${layer.file} line ${section.line}, ${section.bytes.toLocaleString('en-US')} bytes) is about ${other.label}, but ${layer.label} reaches only ${listed([...readers].map((id) => byId.get(id).label))}: their agents read it on every run and never do that work.`,
            location: { file: layer.file, line: section.line }, quote: section.title,
            suggestion: removal({ layer, step, span: sectionSpan(layer.source, section), reach: readers.size, context,
              text: `Take the section out of ${layer.label}; put what ${other.label} needs into its own agent or template.` }) });
        }
        // A sentence in a section already found goes with that section.
        for (const sentence of layer.source.sentences.filter((entry) => entry.owner === 'team' && !flagged.some((section) => entry.line >= section.line && entry.line <= section.endLine))) {
          const lower = sentence.text.toLowerCase();
          const name = names.find((candidate) => new RegExp(`^(?:in|during|for|when you (?:draft|write|do|run))\\s+(?:the\\s+)?${candidate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u').test(lower));
          if (!name) continue;
          sentenceFinding(sentence, step, { code: 'ASSESS_OTHER_STEP_WORK', kind: 'lean', severity: 'warning', subjectKey: other.id,
            title: `${layer.label} tells its agent what to do in ${other.label}, a step it never drafts`,
            detail: `"${quoted(sentence.text, 140)}" is for ${other.label}, but ${layer.label} reaches only ${listed([...readers].map((id) => byId.get(id).label))}.`,
            suggestion: removal({ layer, step, span: removalSpan(layer.source, [sentence]), reach: readers.size, context, text: `Take it out; put it where ${possessive(other.label)} agent reads it.` }) });
        }
      }
    }
  }
  // Vague, nested and long sentences in the team's text, a few per file each.
  const perFile = new Map();
  const capped = (code, file) => { const key = `${code}\u0000${file}`; perFile.set(key, (perFile.get(key) ?? 0) + 1); return perFile.get(key) > PER_FILE; };
  for (const step of steps) {
    for (const sentence of units.get(step.id).sentences.filter((entry) => entry.owner === 'team')) {
      const layer = sentence.layer;
      if (layer.layer === 'step' && /\bTODO\b/u.test(sentence.text)) continue;
      const vague = vaguePhrase(sentence.text);
      if (vague && !capped('vague', sentence.file)) {
        sentenceFinding(sentence, step, { code: 'ASSESS_VAGUE_WORDING', kind: 'unclear', severity: 'note',
          title: `"${vague}" leaves ${possessive(step.label)} agent to guess`, detail: `"${quoted(sentence.text, 160)}": say exactly what to do, or when, instead of "${vague}".`,
          suggestion: { text: `Name the condition or the thing meant by "${vague}".`, decidedBy: 'person', moves: [] } });
      }
      const conditions = conditionCount(sentence.text);
      if (conditions >= 3 && !capped('nested', sentence.file)) {
        sentenceFinding(sentence, step, { code: 'ASSESS_NESTED_CONDITIONS', kind: 'unclear', severity: 'note',
          title: `One sentence sets ${conditions} conditions`, detail: `"${quoted(sentence.text, 200)}": an agent following it can take the wrong branch; one condition per line is easier to follow.`,
          suggestion: { text: 'Split it into a short list, one condition and what to do for each.', decidedBy: 'person', moves: [] } });
      }
      const words = wordCount(sentence.text);
      if (words > LONG_WORDS && conditions < 3 && !capped('long', sentence.file)) {
        sentenceFinding(sentence, step, { code: 'ASSESS_LONG_SENTENCE', kind: 'unclear', severity: 'note',
          title: `A ${words}-word sentence`, detail: `"${quoted(sentence.text, 200)}": split it so each sentence says one thing.`,
          suggestion: { text: 'Split it into shorter sentences, one instruction each.', decidedBy: 'person', moves: [] } });
      }
    }
  }

  // One change per text: a later finding about text an earlier one already takes out points at it.
  const findings = out.list().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || steps.findIndex((step) => step.id === a.steps[0]) - steps.findIndex((step) => step.id === b.steps[0])
    || String(a.location?.file ?? '').localeCompare(String(b.location?.file ?? '')) || (a.location?.line ?? 0) - (b.location?.line ?? 0));
  const taken = new Map();
  for (const finding of findings) {
    for (const move of finding.suggestion?.moves ?? []) {
      const key = JSON.stringify([move.move, move.agent ?? move.skill ?? move.instruction ?? move.id, move.old ?? move.edit?.old ?? move.from?.map((entry) => entry.old)]);
      if (taken.has(key)) { finding.suggestion = { ...finding.suggestion, moves: [], covered: taken.get(key) }; break; }
    }
    for (const move of finding.suggestion?.moves ?? []) taken.set(JSON.stringify([move.move, move.agent ?? move.skill ?? move.instruction ?? move.id, move.old ?? move.edit?.old ?? move.from?.map((entry) => entry.old)]), finding.id);
  }
  return findings;
}
