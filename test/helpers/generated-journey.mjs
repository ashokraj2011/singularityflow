/**
 * The scripted agent, reviewer and person for a generated workflow's Story (test/step-intents-hosts.test.mjs), walked by
 * the route follower (test/helpers/route-follower.mjs) as Copilot CLI or VS Code drives it. A generated workflow has
 * random step IDs, so nothing here knows a step by its name: each step is written from its own prepared template by the
 * workflow walk's stub author (src/workflow-walk/author.mjs), as the step's settings say (it defines the requirement IDs,
 * it plans a code step, it changes code, or it cites what came before), and reviewed by the walk's stub reviewer
 * (src/workflow-walk/reviewer.mjs). The CLI's own checks decide whether each is good enough; nothing here bypasses them.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { answerSections, clauseSection, codeChange, definedClauses, fillDocument, hasPlannedClaimsTable, plannedClaimsSection, scenarioSection } from '../../src/workflow-walk/author.mjs';
import { reviewReport } from '../../src/workflow-walk/reviewer.mjs';
import { cooperativePerson, decideCard, scopeAnswers } from './journey-scripts.mjs';
import { newAgentFile } from '../../src/agent-file.mjs';
import { GENERATED_AGENT, generatedAgentFile } from './generated-workflows.mjs';
import { storyRecord } from './route-follower.mjs';

/** Every clause the Story's step documents define so far, in step order. */
async function storyClauses(story, workId) {
  const record = storyRecord(story);
  const found = [];
  for (const id of record?.phaseOrder ?? []) {
    const relative = record.phases?.[id]?.requiredArtifact?.path;
    if (!relative) continue;
    const text = await readFile(path.join(story.root, story.item, relative), 'utf8').catch(() => '');
    for (const clause of definedClauses(text, workId)) if (!found.includes(clause)) found.push(clause);
  }
  return found;
}

/** What a step is, from the Story's pinned resolution: it defines the IDs, plans a code step, writes code, or cites. */
function stepFacts(story, phase) {
  const record = storyRecord(story);
  const resolved = (record?.resolution?.phases ?? []).find((entry) => entry.id === phase) ?? {};
  const planned = record?.resolution?.plannedClaims ?? {};
  // A step that holds the scope writes the Story's clauses, pinned or not (a workflow that changes no code pins none).
  const defines = (planned.clausePhases ?? []).includes(phase) || ['requirements', 'implementation-spec', 'specification'].includes(resolved.artifact?.kind);
  const plans = Object.values(planned.owners ?? {}).includes(phase);
  return { record, resolved, defines, plans, code: resolved.generation?.task === 'code', cite: !defines && !plans,
    artifact: record?.phases?.[phase]?.requiredArtifact?.path ? path.posix.join(story.item, record.phases[phase].requiredArtifact.path) : null };
}

/** The step's draft from its prepared template, with what the platform needs and the template does not hold. */
function draftOf(before, { clauses, facts, workId }) {
  let text = fillDocument(before, { clauses, cite: facts.cite, defines: facts.defines, workId });
  if (text === before) text = answerSections(text, { cite: facts.cite, clauses });
  if (facts.defines && !definedClauses(text, workId).length) text = fillDocument(`${text}${clauseSection(workId)}`, { clauses, cite: false, defines: true, workId });
  const scenario = scenarioSection(text);
  if (scenario) text = scenario;
  const known = facts.defines ? [...new Set([...clauses, ...definedClauses(text, workId)])] : clauses;
  if (facts.plans && !hasPlannedClaimsTable(text)) text += plannedClaimsSection(known.length ? known : [`${workId}:AC-001`]);
  return text;
}

/** The agent: writes each step from its template, corrects what its check names, reviews, and asks one question. */
export function generatedAgent(workId) {
  return {
    async author({ story, phase, generation }) {
      const facts = stepFacts(story, phase);
      const clauses = await storyClauses(story, workId);
      if (facts.code) for (const [relative, text] of Object.entries(codeChange(clauses, { pass: Math.max(1, Number(generation) || 1) }))) await story.write(relative, text);
      if (!facts.artifact) return true;
      const before = await readFile(path.join(story.root, facts.artifact), 'utf8').catch(() => null);
      if (before == null) return true;
      const text = draftOf(before, { clauses, facts, workId });
      if (text !== before) await story.write(facts.artifact, text);
      return true;
    },
    /** What the step's check asks the author to correct: an evidence file it requires, or every clause in its plan. */
    async correct({ story, phase, result }) {
      const asked = [...(result?.act?.fix ?? []), ...(result?.findings ?? []).map((entry) => `${entry.code ?? ''} at ${entry.path ?? ''}: ${entry.message ?? ''}`)].join('\n');
      let corrected = false;
      for (const member of new Set([...asked.matchAll(/required-member-missing at (\S+?)(?=[:\s]|$)/gu)].map((match) => match[1]))) {
        const target = member.endsWith('/') ? `${member}evidence-index.md` : member;
        const clauses = await storyClauses(story, workId);
        await story.write(target, `# Evidence index — ${workId}\n\n${clauses.map((clause) => `\`${clause}\``).join(', ') || 'The change'}: \`test/value.test.mjs\` passed against \`src/value.mjs\` on the recorded run.\n`);
        corrected = true;
      }
      const unlinked = /specification\.scope-unlinked at (\S+?):/u.exec(asked);
      if (unlinked) {
        const items = [...new Set(asked.match(/SRI-[0-9a-f]{12}/gu) ?? [])];
        const lines = (await readFile(path.join(story.root, unlinked[1]), 'utf8')).split('\n');
        const defines = new RegExp(`\\[${workId}:(?:REQ|BEH|IFC|AC|CON)-\\d{3}\\]`, 'u');
        const at = lines.findIndex((line) => !line.trimStart().startsWith('<!--') && defines.test(line.replace(/`[^`]*`/gu, '')));
        if (at >= 0) lines[at] = `${lines[at]}${items.map((item) => ` [scope:${item}]`).join('')}`;
        else lines.push('', ...items.map((item) => `[scope-open:${item}] No clause of this step states it; the approver decides it.`));
        await story.write(unlinked[1], lines.join('\n'));
        corrected = true;
      }
      if (/planned-test-missing|planned-claim/u.test(asked)) {
        const facts = stepFacts(story, phase);
        const before = facts.artifact ? await readFile(path.join(story.root, facts.artifact), 'utf8').catch(() => null) : null;
        const after = before == null ? null : fillDocument(before, { clauses: await storyClauses(story, workId), defines: facts.defines, workId });
        if (after != null && after !== before) { await story.write(facts.artifact, after); corrected = true; }
      }
      return corrected;
    },
    review: ({ packet }) => reviewReport(packet),
    clarify: ({ phase }) => [{ question: `Before writing ${phase}: is 2 the approved value every caller should read?`, answer: 'Yes: 2, for every caller, and nothing else changes.' }]
  };
}

/** The Story's first clause, where its scope decisions include each statement of its sources; null while it has none. */
export function firstClause(story, workId) {
  const record = storyRecord(story);
  for (const id of record?.phaseOrder ?? []) {
    const relative = record.phases?.[id]?.requiredArtifact?.path;
    if (!relative) continue;
    let text = '';
    try { text = readFileSync(path.join(story.root, story.item, relative), 'utf8'); } catch { continue; }
    const [clause] = definedClauses(text, workId);
    if (clause) return clause;
  }
  return null;
}

/**
 * The person: approves at their own terminal, says yes to what SFlow asks, settles scope and the decisions card. On the
 * card they take the recommended choice they can make: one that names a clause only when there is one to name.
 */
export function generatedPerson(story, workId) {
  const usable = (item) => {
    const can = (option) => !option.needs?.clause || (option.needs.clause.known ?? []).length;
    return (item.options ?? []).find((option) => option.recommended && can(option)) ?? (item.options ?? []).find(can) ?? null;
  };
  return cooperativePerson(({ route }) => {
    if (/^\/(?:sf-)?decide\b/u.test(route.copilot ?? '') || /^singularity-flow decisions\b/u.test(route.shell ?? '')) {
      const clause = firstClause(story, workId);
      const scope = clause ? scopeAnswers(story, clause) : [];
      if (scope.length) return { commands: scope, then: { copilot: '/sf-approve', person: true } };
      const card = decideCard(story, { choose: usable });
      if (card) return { command: card.command };
    }
    return null;
  });
}

/** The generated workflow's agent file in the journey's repository, committed and pushed as its configuration. */
export async function addGeneratedAgent(story, generated) {
  const file = path.join(story.root, 'singularity/agents', `${GENERATED_AGENT}.agent.md`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, generatedAgentFile(newAgentFile, generated.ids));
  story.git('add', '-A');
  story.git('commit', '-qm', 'The agent that drafts the generated workflow');
  story.git('push', '-q', 'origin', 'main');
}
