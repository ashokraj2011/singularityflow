/** Explicit designer preflight only; never load the compiler for ordinary catalog search. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BUILD_INFO, versionLine } from './build-info.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';

export async function workflowIntentCapabilities() {
  const [compiler, parser] = await Promise.all([import('./workflow-markup.mjs'), import('./workflow-markup-parser.mjs')]);
  const required = ['commands/workflow.mjs', 'commands/workflow-intent.mjs', 'commands/workflow-markup.mjs',
    'workflow-markup.mjs', 'workflow-markup-parser.mjs', 'workflow-markup-references.mjs', 'phase-overrides.mjs', 'workflow-intent-capabilities.mjs'];
  const hash = createHash('sha256');
  for (const file of required) hash.update(file).update('\0').update(await readFile(path.join(PACKAGE_ROOT, 'src', file)));
  const { resolveHelp } = await import('./help-service.mjs');
  const documentation = [];
  for (const id of ['workflow-intent', 'workflow-markup']) {
    const topic = await resolveHelp(id, { maxBytes: 512 });
    documentation.push({ id, available: topic.status === 'resolved' && topic.topic?.id === id,
      version: topic.topic?.version ?? null, sha256: topic.served?.sha256 ?? null });
  }
  hash.update(JSON.stringify(documentation));
  const canCompile = typeof compiler.compileWorkflowMarkup === 'function';
  const canParse = typeof parser.parseWorkflowMarkup === 'function';
  return { protocol: 1, engine: { ...BUILD_INFO, description: versionLine(), sha256: `sha256:${hash.digest('hex')}` },
    grammarVersions: [2], nativeTool: 'singularityFlow_workflowAuthoring',
    cli: { catalog: true, asset: true, attachments: true, compile: canCompile && canParse,
      documentation: documentation.every(topic => topic.available), docs: documentation },
    permissionEffect: 'none', meaning: 'Engine capabilities only. Native tool exposure, group membership and human approval are not established.' };
}
