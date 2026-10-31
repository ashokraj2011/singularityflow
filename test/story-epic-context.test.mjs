import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { storyEpicContext } from '../src/story-epic-context.mjs';
import { run } from '../src/util.mjs';

const WORK_ID = 'EPIC-9-STORY-001';
const CONTEXT = `singularity/story-context/${WORK_ID}`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const REQUIREMENTS = `# Requirements

## Requirements

### REQ-001

- Statement: Show the discounted total.

### REQ-0010

- Statement: A look-alike ID that must not be taken for REQ-001.

### REQ-002 — Expired coupons

- Statement: Refuse an expired coupon.

\`\`\`text
### REQ-003 inside a fence is not a heading
\`\`\`

## Acceptance criteria

### AC-001

- Then: the cart shows the discounted total.

## Decisions

| ID | Decision | Status |
| --- | --- | --- |
| D-001 | One coupon per order | Decided |

## Requirements coverage

| Requirement | Acceptance criteria |
| --- | --- |
| REQ-001 | AC-001 |
`;

/** A Story checkout carrying a seed whose governed context pins the given files. */
async function checkout(files, { requirements = ['REQ-001', 'REQ-002'], acceptanceCriteria = ['AC-001'], pins = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-epic-context-'));
  const governedContext = [];
  for (const [id, { name, body }] of Object.entries(files)) {
    const relative = `${CONTEXT}/${name}`;
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), body);
    governedContext.push({ id, path: pins[id]?.path ?? relative, sha256: pins[id]?.sha256 ?? sha256(body), bytes: Buffer.byteLength(body) });
  }
  await mkdir(path.join(root, 'singularity/seeds'), { recursive: true });
  await writeFile(path.join(root, `singularity/seeds/${WORK_ID}.yml`), YAML.stringify({
    version: 1,
    initiative: { id: 'EPIC-9' },
    story: { id: WORK_ID, workId: WORK_ID, planId: 'STORY-001', requirements, acceptanceCriteria },
    governedContext
  }));
  return root;
}

test('a released Story\'s Epic context quotes only its allocated clauses, the decisions and its specification', async () => {
  const root = await checkout({
    requirements: { name: 'requirements.md', body: REQUIREMENTS },
    traceability: { name: 'traceability.yml', body: 'version: 1\n' },
    'story-specification': { name: 'story-specification.md', body: '# Story Specification — STORY-001\n\nApply one coupon.\n' }
  }, { requirements: ['REQ-001', 'REQ-002', 'REQ-009'] });
  const context = await storyEpicContext(root, WORK_ID);
  assert.deepEqual(context.records.map((record) => [record.id, record.verified]),
    [['requirements', true], ['traceability', true], ['story-specification', true]]);
  const { text } = context;
  assert.match(text, /^## Pinned Epic context\n/);
  // The requirements quote a fence of their own, so theirs is one backtick longer.
  assert.match(text, /### Allocated requirements: REQ-001, REQ-002, REQ-009\n\n````markdown\n### REQ-001\n\n- Statement: Show the discounted total\.\n\n### REQ-002 — Expired coupons/);
  // A fenced look-alike heading stays inside its section; the next real heading ends it.
  assert.match(text, /### REQ-003 inside a fence is not a heading\n```\n````\n\n### Allocated acceptance criteria/);
  assert.doesNotMatch(text, /look-alike ID/, 'REQ-0010 is not REQ-001');
  assert.match(text, /Allocated but not found in the pinned requirements: REQ-009\./);
  assert.match(text, /### Allocated acceptance criteria: AC-001\n\n```markdown\n### AC-001\n\n- Then: the cart shows the discounted total\.\n```/);
  assert.match(text, /### Epic decisions\n\n```markdown\n## Decisions\n\n\| ID \| Decision \| Status \|\n\| --- \| --- \| --- \|\n\| D-001 \| One coupon per order \| Decided \|\n```/);
  assert.doesNotMatch(text, /Requirements coverage/);
  assert.match(text, /### Story specification\n\n```markdown\n# Story Specification — STORY-001\n\nApply one coupon\.\n```$/);
  assert.match(text, new RegExp(`\`${CONTEXT}/traceability\\.yml\` \\(traceability\\) · \`${sha256('version: 1\n').slice(0, 12)}\` verified`));
});

test('a pinned file that no longer matches its seed hash is withheld and named, never quoted', async () => {
  const outside = 'singularity/../../outside.md';
  const root = await checkout({
    requirements: { name: 'requirements.md', body: REQUIREMENTS },
    'story-specification': { name: 'story-specification.md', body: 'Edited after release.\n' },
    'parent-specification': { name: 'parent-specification.md', body: '# Parent\n' }
  }, { pins: { 'story-specification': { sha256: sha256('Released bytes.\n') }, 'parent-specification': { path: outside } } });
  const context = await storyEpicContext(root, WORK_ID);
  assert.deepEqual(context.records.map((record) => [record.id, record.verified]),
    [['requirements', true], ['story-specification', false], ['parent-specification', false]]);
  assert.match(context.text, new RegExp(`\`${CONTEXT}/story-specification\\.md\` \\(story-specification\\) is withheld: it does not match the SHA-256 its seed pins \\(found \`${sha256('Edited after release.\n').slice(0, 12)}\`\\)\\. Story finalization refuses until the released file is restored\\.`));
  assert.match(context.text, /`singularity\/\.\.\/\.\.\/outside\.md` \(parent-specification\) is withheld: its seed path is not inside this checkout\./);
  assert.doesNotMatch(context.text, /Edited after release|### Story specification/);
  assert.match(context.text, /### REQ-001/, 'verified files are still quoted');
});

test('a checkout that differs from the released bytes only by line endings is verified from Git', async () => {
  const body = '# Story Specification — STORY-001\n\nApply one coupon.\n';
  const root = await checkout({ 'story-specification': { name: 'story-specification.md', body } });
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'add', '.'], { cwd: root });
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '-m', 'Seed'], { cwd: root });
  await writeFile(path.join(root, CONTEXT, 'story-specification.md'), body.replaceAll('\n', '\r\n'));
  const context = await storyEpicContext(root, WORK_ID);
  assert.equal(context.records[0].verified, true);
  assert.match(context.text, /```markdown\n# Story Specification — STORY-001\n\nApply one coupon\.\n```/);
});

test('each part is cut at its own ceiling, and quoted text cannot close its fence', async () => {
  const specification = `# Story Specification\n\n\`\`\`\`js\nconst fenced = true;\n\`\`\`\`\n\n${'- A long line of specification text.\n'.repeat(400)}`;
  const root = await checkout({ 'story-specification': { name: 'story-specification.md', body: specification } });
  const { text } = await storyEpicContext(root, WORK_ID);
  assert.match(text, /### Story specification\n\n`````markdown\n# Story Specification\n\n````js\n/);
  assert.match(text, new RegExp(`\n\`\`\`\`\`\n\nCut at 6000 bytes; the full verified text is in \`${CONTEXT}/story-specification\\.md\`\\.$`));
  assert.ok(Buffer.byteLength(text) < 7_000, `${Buffer.byteLength(text)} bytes`);
});

test('a Story without a seed, with another Story\'s seed, or with no governed context has no Epic context', async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-epic-context-none-'));
  assert.equal(await storyEpicContext(empty, WORK_ID), null);
  const pinned = await checkout({ requirements: { name: 'requirements.md', body: REQUIREMENTS } });
  await copyFile(path.join(pinned, `singularity/seeds/${WORK_ID}.yml`), path.join(pinned, 'singularity/seeds/EPIC-9-STORY-002.yml'));
  assert.equal(await storyEpicContext(pinned, 'EPIC-9-STORY-002'), null);
  const lite = await checkout({});
  assert.equal(await storyEpicContext(lite, WORK_ID), null);
});
