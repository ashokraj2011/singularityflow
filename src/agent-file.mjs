/**
 * An agent file as every route writes it (`.github/agents/<id>.agent.md`).
 *
 * Workflow Studio's change set (`agent.create`, `agent.update`, `phase.agent`), `agents create|edit`,
 * the progressive builder and team import all render agents here, so the same agent comes out the
 * same bytes whichever route made it: the same frontmatter layout, and a new agent's instructions
 * between the shared repository boundary and clarification sentences. Bundle import carries an
 * exported agent's bytes unchanged instead (src/workflow-transfer.mjs), so an agent made here in one
 * repository arrives as made.
 */
import YAML from 'yaml';
import { AGENT_CLARIFICATION_GUIDANCE, REPOSITORY_AGENT_BOUNDARY, STORY_AGENT_BOUNDARY } from './agent-guidance.mjs';
import { withoutAttachedSkills, withoutTableSection } from './skill-library.mjs';
import { SingularityFlowError } from './util.mjs';
import { renderPreservingFormatting } from './yaml-formatting.mjs';

/** Starting points for a new agent: tools, knowledge views and instructions a person then edits. */
export const AGENT_ROLES = Object.freeze([
  Object.freeze({ id: 'analyst', label: 'Analyst', hint: 'Compares options and writes analyses', tools: ['read', 'search', 'edit', 'ask_user'], views: ['biz.rules'], instructions: 'Read only the approved inputs named in the composed phase prompt. Compare the options against the stated criteria in one table, give the evidence for every judgement, and list open questions instead of guessing. Stop for human review when the analysis is written.' }),
  Object.freeze({ id: 'product-owner', label: 'Product owner', hint: 'Intake, requirements, outcomes', tools: ['read', 'search', 'edit', 'bash', 'ask_user'], views: ['biz.rules'], instructions: 'Restate the request as measurable outcomes and acceptance criteria. Keep scope explicit: what is in, what is out, and what is assumed. Cite the evidence each requirement rests on.' }),
  Object.freeze({ id: 'architect', label: 'Architect', hint: 'Designs and specifications', tools: ['read', 'search', 'edit', 'bash', 'ask_user'], views: ['arch.contracts'], instructions: 'Define boundaries, contracts, data flow and risks for the approved requirements. Prefer the smallest design that follows existing repository patterns, and record every decision with its alternatives.' }),
  Object.freeze({ id: 'developer', label: 'Developer', hint: 'Changes code and tests', tools: ['read', 'search', 'edit', 'bash', 'ask_user'], views: ['dev.impact'], instructions: 'Implement the approved specification with the smallest coherent change that follows existing conventions, error handling and tests. Record changed files, commands actually run, and residual risk.' }),
  Object.freeze({ id: 'tester', label: 'Tester', hint: 'Verifies against the spec', tools: ['read', 'search', 'edit', 'bash', 'ask_user'], views: ['dev.impact'], instructions: 'Verify behaviour against the approved specification. Record each check, the command or steps used, the observed result and the evidence, and report gaps rather than passing them.' }),
  Object.freeze({ id: 'designer', label: 'Designer', hint: 'Works from designs', tools: ['read', 'search', 'edit', 'ask_user'], views: ['biz.rules'], instructions: 'Work from the approved design sources. Name each screen and component you rely on, note gaps between the design and the request, and keep visual decisions traceable to the source.' }),
  Object.freeze({ id: 'reviewer', label: 'Reviewer', hint: "Checks others' work", tools: ['read', 'search', 'edit', 'ask_user'], views: [], instructions: "Review the approved inputs and the step's draft against the stated criteria. List each finding with its evidence and severity, and separate blocking issues from suggestions." }),
  Object.freeze({ id: 'blank', label: 'Blank', hint: 'Write it yourself', tools: ['read', 'search', 'edit'], views: [], instructions: 'Describe what this agent should do in each step it drafts.' })
]);

export function splitAgentText(text, label) {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const opening = /^---\r?\n/.exec(normalized);
  if (!opening) throw new SingularityFlowError(`Agent ${label} has no frontmatter.`);
  const remainder = normalized.slice(opening[0].length);
  const closing = /\r?\n---(?:\r?\n|$)/.exec(remainder);
  if (!closing) throw new SingularityFlowError(`Agent ${label} frontmatter is not closed.`);
  // The frontmatter text with its last line break, so an edit can be written back over it.
  const header = `${remainder.slice(0, closing.index)}\n`;
  return { document: YAML.parseDocument(header), header, body: remainder.slice(closing.index + closing[0].length) };
}

export function quoted(document, value) {
  const node = document.createNode(value);
  node.type = 'QUOTE_DOUBLE';
  return node;
}

export function renderAgentFile(entry) {
  const base = entry.text ?? `---\nname: ${entry.id}\ndescription: ""\n---\n`;
  const { document, header, body } = splitAgentText(base, entry.id);
  if (!entry.text) document.set('name', entry.id);
  document.set('description', entry.description);
  // A field is written only when it changed, and over the file's own text, so editing one field of
  // an agent changes one line rather than restyling its whole frontmatter.
  // No tools at all (null) is not an empty list: an agent file without `tools` may use every tool.
  if (entry.tools != null && JSON.stringify(document.get('tools')?.toJSON?.() ?? null) !== JSON.stringify(entry.tools)) {
    document.set('tools', document.createNode([...entry.tools], { flow: true }));
  }
  const metadata = document.get('metadata') ?? document.createNode({});
  if (!document.has('metadata')) document.set('metadata', metadata);
  // A step this agent gives to an APM agent stays in its file, where the file had it: it drafts the
  // step again whenever the APM agent cannot be used.
  const drafts = new Set([...entry.defaultFor, ...(entry.yielded ?? [])]);
  const written = String(document.getIn(['metadata', 'sflow-default-for']) ?? '').split(',').map((step) => step.trim()).filter((step) => drafts.has(step));
  const defaultFor = [...new Set([...written, ...entry.defaultFor, ...(entry.yielded ?? [])])];
  for (const [key, value] of [
    ['sflow-label', entry.label], ['sflow-phases', entry.phases.join(',')],
    ['sflow-default-for', defaultFor.join(',')]
    // An old sflow-world-model-views header is left as authored; nothing reads it any more.
  ]) if (document.getIn(['metadata', key]) !== value) document.setIn(['metadata', key], quoted(document, value));
  // Further metadata a route declares (a review-only mode, a user-defined folder), after Studio's own and
  // written plain, as `call add` writes it: Studio recognizes a user-defined agent by that exact line.
  for (const [key, value] of Object.entries(entry.extraMetadata ?? {})) {
    if (document.getIn(['metadata', key]) !== value) document.setIn(['metadata', key], value);
  }
  const text = entry.body != null ? `\n${entry.body.trim()}\n` : body;
  return `---\n${renderPreservingFormatting(header, document)}---\n${text}`;
}

/**
 * An existing agent's instructions as the starting text of a new one: without its title, the shared
 * boundary and clarification lines (newAgentBody adds those again), its attached-skills table
 * (copied as attachments instead) and its remote resources, which a new agent must lock itself.
 */
export function starterInstructions(body) {
  let text = withoutAttachedSkills(body);
  for (const heading of ['Remote skills', 'Remote artifact templates', 'Remote generated artifacts']) text = withoutTableSection(text, heading);
  // A shipped profile may continue a shared sentence in the same paragraph; keep only its own words.
  const shared = [STORY_AGENT_BOUNDARY, REPOSITORY_AGENT_BOUNDARY, AGENT_CLARIFICATION_GUIDANCE];
  return text.replace(/^\s*# [^\n]*\n/u, '').split(/\n{2,}/u)
    .map((paragraph) => shared.reduce((rest, sentence) => rest.startsWith(sentence) ? rest.slice(sentence.length).trim() : rest, paragraph.trim()))
    .filter(Boolean).join('\n\n');
}

export function newAgentBody(label, instructions) {
  return [`# ${label} agent`, '', REPOSITORY_AGENT_BOUNDARY, '', String(instructions ?? '').trim() || 'Describe what this agent should do in each step it drafts.', '', AGENT_CLARIFICATION_GUIDANCE].join('\n');
}

/** The role IDs `agent.create` starts from. */
export const AGENT_ROLE_IDS = Object.freeze(AGENT_ROLES.map((role) => role.id));

/**
 * A new agent's whole file, exactly as Workflow Studio's `agent.create` writes it: `instructions`
 * become its body between the shared sentences (`starter` first strips a title and those sentences
 * from instructions taken from another agent file). `tools: null` writes no tools list.
 */
export function newAgentFile({ id, label, description, tools = null, phases = [], defaultFor = [], instructions = '', starter = false, extraMetadata = {} }) {
  const own = starter ? starterInstructions(String(instructions ?? '')) : instructions;
  return renderAgentFile({ id, text: null, label, description, tools, phases, defaultFor, extraMetadata, body: newAgentBody(label, own) });
}
