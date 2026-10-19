/**
 * `singularity-flow app suggest [--capability ID] [--json]` [RUN amendment §3]: start entries drafted
 * from the IDE run configurations in the checkout. A read; it prints drafts and writes nothing.
 */
import path from 'node:path';

const SOURCE_WORDS = Object.freeze({
  intellij: 'IntelliJ', pycharm: 'PyCharm', webstorm: 'WebStorm', goland: 'GoLand', rider: 'Rider', vscode: 'VS Code',
  'launch-settings': '.NET launch settings', detected: 'detected'
});

/**
 * The private file an application block draft for this repository and capability goes in: outside
 * the repository, beside the workflow fix drafts, never created here. A live /sf-run-app turn may
 * write exactly this file and propose it with capability set|edit --application-file.
 */
export async function applicationDraftPath(root, capabilityId, { env = process.env } = {}) {
  const [{ createHash }, { realpathSync }, { workflowBuildStateRoot }] = await Promise.all([
    import('node:crypto'), import('node:fs'), import('../workflow-build/store.mjs')]);
  let resolved = path.resolve(root);
  try { resolved = realpathSync(resolved); } catch { /* the path as given */ }
  const repository = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  const name = /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(String(capabilityId ?? '')) ? capabilityId : 'capability';
  return path.join(workflowBuildStateRoot(env), 'application-drafts', repository, `${name}.application.yml`);
}

export async function run(root, application, { json = false } = {}) {
  const { loadEnvironmentDeclaration } = await import('../environment-declaration.mjs');
  const { suggestApplication } = await import('../app-suggestions.mjs');
  const declaration = await loadEnvironmentDeclaration(root, { optional: true });
  const result = await suggestApplication(root, {
    capabilityId: application.capabilityId, capability: application.capability, repositoryId: application.repositoryId,
    repositories: application.repositories, declaration, policy: application.policy
  });
  if (result.applicationDraft) {
    result.draft = { applicationFile: await applicationDraftPath(root, result.capability) };
    await import('../copilot-mutation-guard.mjs')
      .then(({ issueRunAppDraftStaging }) => issueRunAppDraftStaging(result.draft.applicationFile, { root })).catch(() => 0);
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (!result.suggestions.length) console.log(`No start entry to suggest for ${result.capability}.`);
  else console.log(`Start entries suggested for ${result.capability} (nothing was written):`);
  for (const suggestion of result.suggestions) {
    const { start, source } = suggestion;
    const from = suggestion.variants
      ? suggestion.variants.map((variant) => `'${variant.name}'`).join(', ')
      : `'${source.name}'`;
    console.log(`  ${start.id}: ${start.argv.join(' ')} · in ${start.workingDirectory} · ${start.url}`);
    console.log(`    from ${SOURCE_WORDS[source.kind] ?? source.kind} ${source.file} ${from}`);
    for (const [environment, list] of Object.entries(start.arguments ?? {})) console.log(`    ${environment}: + ${list.join(' ')}`);
    const names = suggestion.environmentNames.map((entry) => `${entry.name} (${entry.kind}${entry.environment ? `, ${entry.environment}` : ''})`);
    if (names.length) console.log(`    variables: ${names.join(', ')}`);
    for (const note of suggestion.notes) console.log(`    note: ${note}`);
  }
  for (const note of result.notes) console.log(`Note: ${note}`);
  if (result.files.skipped.length) {
    console.log(`Skipped ${result.files.skipped.length}:`);
    for (const skipped of result.files.skipped) console.log(`  ${skipped.file}: ${skipped.reason}`);
  }
  if (result.applicationDraft) {
    console.log('\nApplication block draft (save it to a file, review it, then capability set or capability edit --application-file):\n');
    console.log(result.applicationDraft.trimEnd());
  }
  if (result.environmentsDraft) {
    console.log('\nenvironments.yml additions (propose them through the configuration proposal; secrets are names only):\n');
    console.log(result.environmentsDraft.trimEnd());
  }
  return result;
}
