/**
 * A specification published from the shipped template carries none of the template's guidance: the
 * author writes under it and leaves it in place, and publication removes it before the commit, so
 * a reviewer, an approver and every later step read only what the author wrote (Story after-cl,
 * 2026-11-11: the reviewer flagged the guidance sentences as leftovers).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, normalizePlannedClaimsPolicy, resolveWorkType } from '../src/config.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { setAgentSession } from '../src/session.mjs';
import { commitAndPublish, createWorkflow, loadConfig, preparePhaseInputs, publishGeneration } from '../src/state.mjs';
import { templateGuidanceComments } from '../src/template-guidance.mjs';

const ACTOR = { name: 'Guidance Driver', email: 'guidance@example.invalid', login: null };
const AUTHORSHIP = buildGenerationAuthorship({
  options: normalizeAuthorshipOptions({ producer: 'human', channel: 'manual-in-place', externalAiUse: 'none' }),
  actor: ACTOR, governedAgentContext: 'product-owner', source: null
});

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

/** What the author writes under each section, below the guidance it leaves in place. */
const WRITTEN = Object.freeze({
  'agent brief': ['Operators retry a payment that failed at the provider; each retry is a new attempt and the failed one stays for audit.'],
  actors: ['An operator holding the payments role, and the payments provider.'],
  'user scenarios': ['### S1 — An operator retries a failed payment', '', '**Priority:** P1', '',
    '- **Given** a payment that failed at the provider', '  **When** an operator retries it', '  **Then** a new attempt is created and the failed one is preserved'],
  'failure and empty states': ['- **Empty:** with no failed payment there is nothing to retry.', '- **Failure:** when the provider is unavailable the retry is refused and nothing changes.'],
  'scenario coverage': ['| Clause | Scenario | Outcome |', '|---|---|---|', '| `DRIVE:REQ-001` | S1 | success |',
    '| `DRIVE:REQ-002` | S1 | success |', '| `DRIVE:AC-001` | S1 | success |'],
  permissions: ['Only an operator with the payments role may retry; anyone else sees the payment read-only.'],
  'boundary conditions': ['Not applicable: this change adds no limit, size or timeout.'],
  requirements: ['- The system creates a new attempt when an operator retries a failed payment. *(S1)* [DRIVE:REQ-001]',
    '- The system preserves the failed attempt and its provider response. *(S1)* [DRIVE:REQ-002]', '',
    '- A retried payment shows a new attempt and keeps the failed one. *(S1)* [DRIVE:AC-001]'],
  'verification intent': ['| Clause | Methods | Criterion |', '|---|---|---|', '| `DRIVE:REQ-001` | test | - |',
    '| `DRIVE:REQ-002` | test | - |', '| `DRIVE:AC-001` | test | `DRIVE:AC-001` |'],
  'non-functional requirements': ['Not applicable: no new latency, throughput or retention target.'],
  'constitution articles': ['None cited.'],
  assumptions: ['The provider returns a stable failure code for every failed payment.'],
  'out of scope': ['Refunds and partial captures.'],
  sources: ['No supporting documents; the Story itself is the source.']
});

/**
 * The prepared draft as an author leaves it: the headings and every guidance line kept exactly,
 * each section's placeholders replaced by its written text, the kernel's own blocks untouched.
 */
function authored(prepared) {
  const guidance = templateGuidanceComments(prepared);
  const inGuidance = (offset) => guidance.some((comment) => offset >= comment.start && offset < comment.end);
  const out = [];
  let offset = 0;
  let managed = false;
  let section = null;
  const flush = () => { if (section && WRITTEN[section]) out.push(...WRITTEN[section], ''); };
  for (const line of prepared.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    if (/^<!-- singularity-flow:/u.test(line)) managed = !/-->\s*$/u.test(line) || /:start -->$/u.test(line);
    if (managed || /^<!-- singularity-flow:|^-->$|:end -->$/u.test(line)) {
      out.push(line);
      if (/:end -->$|^-->$/u.test(line)) managed = false;
      continue;
    }
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading) { flush(); section = heading[1].toLowerCase(); out.push(line, ''); continue; }
    if (/^# /u.test(line)) { out.push(line, ''); continue; }
    if (inGuidance(start)) { out.push(line); if (/-->\s*$/u.test(line)) out.push(''); }
  }
  flush();
  return `${out.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
}

test('a specification published from the shipped template carries none of its guidance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-guidance-publication-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', ACTOR.name);
  git(root, 'config', 'user.email', ACTOR.email);
  await writeFile(path.join(root, 'README.md'), '# Payments\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize repository');
  git(root, 'switch', '-c', 'DRIVE-1');
  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'spec-driven-standard');
  resolved.sourceReview = { mode: 'off', phases: [], reviewerAgent: null };
  const specification = resolved.phases.find((phase) => phase.id === 'specification');
  const planning = resolved.phases.find((phase) => phase.id === 'planning');
  resolved.phases = [{
    ...specification, order: 0,
    clarification: { ...specification.clarification, mode: 'off', markers: { mode: 'off' } },
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['specification'] }
  }, { ...planning, order: 1, inputs: [] }];
  resolved.plannedClaims = normalizePlannedClaimsPolicy(null, { workTypeId: 'spec-driven-standard', phases: resolved.phases, spec: resolved.spec });
  await setAgentSession(root, config, ACTOR, 'product-owner', 'DRIVE-1', { phaseId: 'specification', source: 'test' });

  await withOperationContext({
    operation: { id: 'test.template-guidance', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' }, root, command: 'test'
  }, async () => {
    const workflow = await createWorkflow(root, config, {
      id: 'DRIVE-1', title: 'Retry a failed payment', baseBranch: 'main', workType: 'spec-driven-standard', agent: 'product-owner', resolved,
      source: { type: 'manual', key: 'DRIVE-1', title: 'Retry a failed payment', description: 'Let an operator retry a payment that failed at the provider.', acceptanceCriteria: ['A retry creates a new attempt.'] }
    });
    await preparePhaseInputs(root, config, workflow, 'specification');
    const relative = path.posix.join('singularity/work-items/DRIVE-1', workflow.phases.specification.requiredArtifact.path);
    const target = path.join(root, relative);
    const draft = authored(await readFile(target, 'utf8'));
    assert.match(draft, /<!-- sflow:guidance What this specification takes as true without proving\./u, 'the author left the guidance in place');
    await writeFile(target, draft);

    const phase = workflow.phases.specification;
    const generation = Number(phase.generation) + 1;
    await commitAndPublish(root, config, workflow, { type: 'artifact-generated', phaseId: 'specification', generation },
      `[DRIVE-1][phase:specification][generated:${generation}] publish`, (phase.artifacts ?? []).map((entry) => entry.path), {
        beforeStateWrite: (publicationEvent, transactionContext) => publishGeneration(root, config, workflow, {
          phaseId: 'specification', authorship: AUTHORSHIP, persist: false,
          publicationTransaction: { publicationEvent, transactionId: transactionContext.transactionId, expectedHead: transactionContext.expectedHead }
        })
      });

    const published = git(root, 'show', `HEAD:${relative}`);
    assert.doesNotMatch(published, /sflow:guidance/u);
    assert.doesNotMatch(published, /takes as true without proving|Who uses this, and what authority|Keep every section of this template/u);
    assert.match(published, /An operator holding the payments role, and the payments provider\./u);
    assert.match(published, /## Assumptions\n\nThe provider returns a stable failure code/u, 'no blank-line run where guidance was');
    // The working copy and the recorded digest are the published bytes.
    assert.equal(await readFile(target, 'utf8'), published);
    const recorded = workflow.phases.specification.artifacts.find((entry) => entry.path === relative);
    assert.equal(recorded.sha256, createHash('sha256').update(published).digest('hex'));
  });
});
