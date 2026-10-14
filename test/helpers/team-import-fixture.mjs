/**
 * A realistic team directory and a candidate interpreting it, for `workflow import-team` tests.
 *
 * The team: a Copilot entry agent that delegates to a planner and a builder, runs `npm test` with a
 * bounded retry, and asks a reviewer kept in a hidden tool directory (`.acme/agents`, beside its
 * `ACME.md`). A directory skill links a scoped instruction; a process document is linked; one file
 * holds a credential and one has a blocked name.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const LEAD = '.github/agents/delivery-lead.agent.md';

const FILES = {
  [LEAD]: `---
name: delivery-lead
description: Runs a change from plan to tested code.
tools: [read, edit, terminal]
---
# Delivery lead

Follow the [delivery process](../../docs/process.md).

## Steps
1. Ask @planner to write the plan.
2. Ask @builder to implement it, using the \`api-review\` skill for API changes.
3. Run \`npm test\`. If tests fail, send the work back to @builder, at most 3 times; then stop and ask the team lead.
4. Have @reviewer review the change.
`,
  '.github/agents/planner.agent.md': `---
name: planner
description: Writes the implementation plan.
---
# Planner
Write a plan with goals, steps and risks. Do not write code.
`,
  '.github/agents/builder.agent.md': `---
name: builder
description: Implements the plan.
tools: [read, edit, terminal]
---
# Builder
Implement the approved plan and keep tests green.
`,
  '.github/skills/api-review/SKILL.md': `---
name: api-review
description: Checks API changes for compatibility.
---
# API review
When changing an API contract, follow the compatibility rules in [api instructions](../../instructions/api.instructions.md).
`,
  '.github/instructions/api.instructions.md': `---
applyTo: "src/api/**"
---
Never remove a public field; deprecate it first.
`,
  '.acme/agents/reviewer.md': `---
name: reviewer
description: Reviews changes independently.
tools: [read]
---
Review the change against the plan. Report findings; do not edit.
`,
  'ACME.md': '# Team rules\nBe kind.\n',
  'docs/process.md': '# Delivery process\nPlan, build, test, review.\n',
  'docs/notes.md': 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n',
  'docs/tokens.md': 'never read\n'
};

/** A fresh team directory (and a separate state directory) removed after the test. */
export async function teamFixture(t, extra = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-team-import-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const team = path.join(base, 'team');
  for (const [relative, text] of Object.entries({ ...FILES, ...extra })) {
    if (text === null) continue;
    const file = path.join(team, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  const env = { ...process.env, SINGULARITY_FLOW_TEAM_IMPORT_STATE: path.join(base, 'state'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'home', 'mode.json') };
  return { base, team, env, issue: async () => 0 };
}

/** The candidate a careful interpretation of the fixture produces; `edit` adjusts it. */
export function fixtureCandidate(inspection, edit = (candidate) => candidate) {
  const sha = Object.fromEntries(inspection.closure.map((file) => [file.path, file.sha256]));
  const ev = (file, startLine, endLine) => ({ path: file, sha256: sha[file], startLine, endLine });
  const candidate = {
    schemaVersion: 1, kind: 'team-import-candidate', sessionId: inspection.session.id, captureSha256: inspection.capture.sha256,
    namespace: 'delivery',
    workflow: { id: 'delivery-flow', label: 'Delivery flow', phases: ['delivery-plan', 'delivery-build', 'delivery-review'],
      decisions: [{ id: 'delivery-tests', after: 'delivery-build', kind: 'loop', label: 'Tests pass?',
        inputs: [{ name: 'tests', values: ['pass', 'fail'] }], goal: { tests: 'pass' }, back: 'delivery-build', maxRounds: 3, by: ['delivery-leads'] }] },
    authorities: [{ id: 'delivery-leads', label: 'Team leads', kind: 'explicit', evidence: [ev(LEAD, 12, 12)] }],
    phases: [
      { id: 'delivery-plan', label: 'Plan', agent: 'delivery-planner', template: 'delivery/plan.md',
        artifact: { path: 'artifacts/delivery-plan/plan.md', kind: 'implementation-spec' }, writeScope: 'artifact-only', approval: 'none' },
      { id: 'delivery-build', label: 'Build', agent: 'delivery-builder', template: 'delivery/build.md',
        artifact: { path: 'artifacts/delivery-build/build-summary.md', kind: 'build-summary' }, inputs: ['delivery-plan'],
        writeScope: 'source-and-artifact', code: true, qualityCommands: [{ argv: ['npm', 'test'], evidence: [ev(LEAD, 12, 12)] }],
        approval: { mode: 'required', authorities: ['delivery-leads'], minimum: 1 } },
      { id: 'delivery-review', label: 'Review', agent: 'delivery-reviewer', template: 'delivery/review.md',
        artifact: { path: 'artifacts/delivery-review/review.md', kind: 'review' }, inputs: ['delivery-plan', 'delivery-build'],
        writeScope: 'artifact-only', approval: 'none' }
    ],
    agents: [
      { id: 'delivery-planner', label: 'Planner', description: 'Writes the implementation plan.', body: '# Planner\n\nWrite a plan with goals, steps and risks. Do not write code.' },
      { id: 'delivery-builder', label: 'Builder', description: 'Implements the approved plan.', tools: ['read', 'edit', 'terminal'], body: '# Builder\n\nImplement the approved plan and keep tests green.' },
      { id: 'delivery-reviewer', label: 'Reviewer', description: 'Reviews changes independently.', tools: ['read'], body: '# Reviewer\n\nReview the change against the plan. Report findings; do not edit.' }
    ],
    skills: [{ id: 'delivery-api-review', description: 'Checks API changes for compatibility.',
      body: '# API review\n\nWhen changing an API contract (files under src/api/), follow <instruction>delivery-api-compat</instruction>.' }],
    instructions: [{ id: 'delivery-api-compat', description: 'API compatibility rules.', body: 'Never remove a public field; deprecate it first.' }],
    templates: [
      { ref: 'delivery/plan.md', body: '# Plan\n\n## Goals\n\n## Steps\n\n## Risks\n' },
      { ref: 'delivery/build.md', body: '# Build summary\n\n## Changes\n\n## Tests\n' },
      { ref: 'delivery/review.md', body: '# Review\n\n## Findings\n' }
    ],
    attachments: [{ skill: 'delivery-api-review', agent: 'delivery-builder', steps: ['delivery-build'], use: 'For API changes' }],
    mappings: [
      { sourceItem: LEAD, evidence: [ev(LEAD, 9, 13)], target: 'workflow:delivery-flow', disposition: 'mapped', kind: 'explicit' },
      { sourceItem: '.github/agents/planner.agent.md', evidence: [ev('.github/agents/planner.agent.md', 1, 7)], target: 'agent:delivery-planner', disposition: 'mapped', kind: 'explicit' },
      { sourceItem: '.github/agents/builder.agent.md', evidence: [ev('.github/agents/builder.agent.md', 1, 8)], target: 'agent:delivery-builder', disposition: 'mapped', kind: 'explicit' },
      { sourceItem: '.acme/agents/reviewer.md', evidence: [ev('.acme/agents/reviewer.md', 1, 7)], target: 'agent:delivery-reviewer', disposition: 'mapped', kind: 'explicit' },
      { sourceItem: '.github/skills/api-review/SKILL.md', evidence: [ev('.github/skills/api-review/SKILL.md', 1, 7)], target: 'skill:delivery-api-review', disposition: 'mapped', kind: 'explicit' },
      { sourceItem: '.github/instructions/api.instructions.md', evidence: [ev('.github/instructions/api.instructions.md', 1, 5)], target: 'instruction:delivery-api-compat', disposition: 'approximated', kind: 'explicit',
        reason: 'applyTo "src/api/**" has no engine equivalent; placed in the API review skill at its point of use.' },
      { sourceItem: 'test-retry-loop', evidence: [ev(LEAD, 12, 12)], target: 'decision:delivery-tests', disposition: 'mapped', kind: 'explicit' },
      { sourceItem: 'plan-defines-clauses', evidence: [], target: 'phase:delivery-plan', disposition: 'mapped', kind: 'destination-policy',
        reason: 'SFlow needs the step before code to define the requirement clauses it meets; the plan step does.' },
      { sourceItem: 'build-approval', evidence: [], target: 'phase:delivery-build', disposition: 'mapped', kind: 'destination-policy', reason: 'A loop may send work back only after a signed-off step.' },
      { sourceItem: 'ACME.md', evidence: [ev('ACME.md', 1, 2)], target: 'none', disposition: 'excluded', kind: 'explicit', reason: 'General etiquette with no process behaviour.' }
    ],
    prerequisites: [], decisionsNeeded: []
  };
  return edit(candidate) ?? candidate;
}

/** Write `candidate` where inspect issued it. */
export async function writeCandidate(inspection, candidate) {
  await writeFile(inspection.candidate.path, `${JSON.stringify(candidate, null, 2)}\n`);
}
