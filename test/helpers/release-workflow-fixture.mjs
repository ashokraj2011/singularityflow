/**
 * A `mobile-release` workflow with one of every object a workflow bundle carries: steps, a template
 * catalog entry and template files, an artifact set, approval groups named by approval, a decision
 * and a specification-quality exception, an MCP server with its imported descriptor, a default
 * agent with an imported (vendored) skill and a generated artifact, a read-only source reviewer,
 * and the records of where the imported files came from. With `librarySkill`, the agent also
 * attaches `store-review` from the skill master.
 *
 * The `local` variant has the same names with different content, for same-name conflicts.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export const DESCRIPTOR_TEXT = `${JSON.stringify({
  format: 'sflow-mcp-server@1', id: 'app-store-connect', label: 'App Store Connect',
  policy: { tools: ['upload_build', 'submit_review'], approval: 'confirm', evidence: { captureToolCalls: true, captureResults: false } },
  host: { type: 'stdio', command: 'npx', args: ['app-store-connect-mcp@1.2.3'] }
}, null, 2)}\n`;

export function skillText(variant) {
  return `# Store checklist (${variant})\n\n- Screenshots\n- Privacy labels\n`;
}

export const LIBRARY_SKILL_PATH = 'singularity/skill-library/store-review/SKILL.md';

/** The skill master's `store-review`, which the release manager attaches with `librarySkill`. */
export function librarySkillText(variant) {
  return `---
name: store-review
description: Reviews a store listing before it is submitted. Use it before a build goes to the store.
---

Check the screenshots, the privacy labels and the release notes (${variant}).
`;
}

function managerAgent(variant, { generated, librarySkill }) {
  return `---
name: release-manager
description: Plans mobile releases and prepares store submissions.
tools: [app-store-connect/upload_build, app-store-connect/submit_review]
metadata:
  sflow-phases: "release-plan,store-submission"
  sflow-default-for: "release-plan,store-submission"
---

# Release manager

Plan the release and prepare the store submission (${variant}).

## Remote skills

| ID | URL | Phases | Optional | Max bytes |
|---|---|---|---|---|
| store-checklist | https://example.com/skills/store-checklist.md | store-submission | false | 4096 |
${generated ? `
## Remote generated artifacts

| ID | URL template | Phase | Target | Optional | Max bytes |
|---|---|---|---|---|---|
| release-notes | https://example.com/{workId}/notes.md | store-submission | artifacts/store-submission/generated-notes.md | true | 4096 |
` : ''}${librarySkill ? `
## Attached skills

| Skill | Phases | When to use it |
|---|---|---|
| store-review | store-submission | Before you submit the build |
` : ''}`;
}

function reviewerAgent(variant) {
  return `---
name: release-reviewer
description: Reviews release plans against the repository, read-only.
tools: [read, search]
metadata:
  sflow-mode: read-only-review
---

# Release reviewer

Review the release plan against the repository (${variant}). Change nothing.
`;
}

/** Write the workflow into an initialized repository at `root`. */
export async function addReleaseWorkflow(root, variant = 'source', { descriptor = true, generated = true, librarySkill = false } = {}) {
  const write = async (relative, text) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  };
  const file = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(file, 'utf8'));
  await write('singularity/templates/mobile-release/release-plan.md', `# {{work.id}} release plan (${variant})\n\n## Rollout\n\n## Rollback\n`);
  await write('singularity/templates/mobile-release/intake.md', `# {{work.id}} release intake (${variant})\n\n## Release scope\n`);
  configuration.templates = {
    ...(configuration.templates ?? {}),
    'release-intake': { path: 'mobile-release/intake.md', label: 'Release intake', kind: 'requirements' }
  };
  configuration.phases['release-plan'] = {
    ...structuredClone(configuration.phases.requirements),
    label: variant === 'source' ? 'Release plan' : 'Release plan (local)',
    defaultTemplate: 'mobile-release/release-plan.md',
    artifact: { path: 'artifacts/release-plan/release-plan.md', kind: 'requirements', minimumBytes: 200 },
    approval: { authorities: ['product-approvers'], minimum: 1, rejectTo: ['intake', 'release-plan'] }
  };
  configuration.artifactSets['release-bundle'] = {
    primary: 'notes.md',
    members: [
      { path: 'notes.md', role: 'release-notes', required: true },
      { path: 'checklist.md', role: 'store-checklist', required: false, authority: 'advisory' }
    ]
  };
  configuration.phases['store-submission'] = {
    ...structuredClone(configuration.phases.planning),
    label: 'Store submission', defaultTemplate: 'mobile-release/release-plan.md',
    artifact: { path: 'artifacts/store-submission/notes.md', kind: 'design', minimumBytes: 200 },
    artifactSet: 'release-bundle',
    approval: { authorities: ['architecture-reviewers'], minimum: 1, rejectTo: ['release-plan', 'store-submission'] },
    specificationQuality: { mode: 'off', exceptionAuthority: 'release-leads' }
  };
  // One group only a decision names, one only an exception names.
  configuration.approvalAuthorities['release-managers'] = {
    label: variant === 'source' ? 'Release managers' : 'Release managers (local)', allowAnyGitIdentity: true, members: []
  };
  configuration.approvalAuthorities['release-leads'] = { label: 'Release leads', allowAnyGitIdentity: true, members: [] };
  configuration.mcpServers['app-store-connect'] = {
    label: 'App Store Connect', hostReference: 'app-store-connect', agents: ['release-manager'], phases: ['store-submission'],
    tools: ['upload_build', 'submit_review'], required: false, approval: 'confirm',
    evidence: { captureToolCalls: true, captureResults: false }
  };
  configuration.workTypes['mobile-release'] = {
    label: 'Mobile release',
    phases: ['intake', 'release-plan', 'store-submission'],
    templateOverrides: { intake: 'template:release-intake' },
    omits: [
      { responsibility: 'implement', reason: 'Store submission ships a reviewed build; it writes no new code.', authority: 'product-approvers' },
      { responsibility: 'verify', reason: 'The submitted build was verified by the delivery workflow that produced it.', authority: 'product-approvers' }
    ],
    decisions: [{
      id: 'go-no-go', after: 'release-plan', kind: 'ask', label: 'Go or no-go', by: ['release-managers'],
      routes: [{ id: 'go', to: 'next', label: 'Submit to the store' }, {
        id: 'no-go', to: 'end', label: 'Stop the release', omits: [
          { responsibility: 'implement', reason: 'A stopped release ships no build, so nothing is implemented.', authority: 'product-approvers' },
          { responsibility: 'verify', reason: 'A stopped release ships no build, so there is nothing to verify.', authority: 'product-approvers' }
        ]
      }]
    }],
    sourceReview: { mode: 'enforce', phases: ['release-plan'], reviewerAgent: 'release-reviewer' }
  };
  await writeFile(file, YAML.stringify(configuration));

  const manager = managerAgent(variant, { generated, librarySkill });
  const skill = skillText(variant);
  if (librarySkill) await write(LIBRARY_SKILL_PATH, librarySkillText(variant));
  await write('.github/agents/release-manager.agent.md', manager);
  await write('.github/agents/release-reviewer.agent.md', reviewerAgent(variant));
  await write('singularity/imports/agents/release-manager/skill-store-checklist.md', skill);
  const lockFile = path.join(root, 'singularity/agents.lock.yml');
  const lock = YAML.parse(await readFile(lockFile, 'utf8').catch(() => 'version: 1\nagents: {}\n')) ?? { version: 1, agents: {} };
  lock.agents ??= {};
  lock.agents['release-manager'] = {
    source: '.github/agents/release-manager.agent.md', sourceSha256: sha256(manager), lockedAt: '2026-10-05T00:00:00.000Z',
    dependencies: [{
      id: 'store-checklist', type: 'skill', url: 'https://example.com/skills/store-checklist.md', phases: ['store-submission'],
      optional: false, maxBytes: 4096, sha256: sha256(skill), size: Buffer.byteLength(skill),
      resolvedUrl: 'https://example.com/skills/store-checklist.md',
      vendored: 'singularity/imports/agents/release-manager/skill-store-checklist.md'
    }, ...(generated ? [{
      id: 'release-notes', type: 'generated', urlTemplate: 'https://example.com/{workId}/notes.md', optional: true, maxBytes: 4096,
      phase: 'store-submission', target: 'artifacts/store-submission/generated-notes.md', dynamic: true,
      sha256: null, size: null, resolvedUrl: null
    }] : [])]
  };
  await writeFile(lockFile, YAML.stringify(lock));
  const imports = {
    'skill:release-manager/store-checklist': {
      kind: 'skill', source: { url: 'https://example.com/skills/store-checklist.md' }, sha256: sha256(skill),
      bytes: Buffer.byteLength(skill), fetchedAt: '2026-10-05T00:00:00.000Z',
      target: { agent: 'release-manager', id: 'store-checklist', phases: ['store-submission'], path: 'singularity/imports/agents/release-manager/skill-store-checklist.md' }
    }
  };
  if (generated) {
    imports['generated:release-manager/release-notes'] = {
      kind: 'generated', source: { kind: 'url', urlTemplate: 'https://example.com/{workId}/notes.md' }, sha256: null, bytes: null, fetchedAt: null,
      target: { agent: 'release-manager', id: 'release-notes', phase: 'store-submission', path: 'artifacts/store-submission/generated-notes.md' }
    };
  }
  if (descriptor) {
    await write('singularity/imports/mcp/app-store-connect.json', DESCRIPTOR_TEXT);
    imports['mcp-server:app-store-connect'] = {
      kind: 'mcp-server', source: { url: 'https://example.com/mcp/app-store-connect.json' }, sha256: sha256(DESCRIPTOR_TEXT),
      bytes: Buffer.byteLength(DESCRIPTOR_TEXT), fetchedAt: '2026-10-05T00:00:00.000Z',
      target: {
        id: 'app-store-connect', path: 'singularity/imports/mcp/app-store-connect.json', agents: ['release-manager'],
        phases: ['store-submission'], tools: ['app-store-connect/upload_build', 'app-store-connect/submit_review']
      }
    };
  }
  await writeFile(path.join(root, 'singularity/imports.lock.yml'), YAML.stringify({ version: 1, imports }));
}
