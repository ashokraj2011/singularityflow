/**
 * `singularity-flow app suggest [--capability ID] [--json]` [RUN amendment §3]: start entries drafted
 * from the IDE run configurations in the checkout. A read; it prints drafts and writes nothing.
 */
const SOURCE_WORDS = Object.freeze({
  intellij: 'IntelliJ', pycharm: 'PyCharm', webstorm: 'WebStorm', goland: 'GoLand', rider: 'Rider', vscode: 'VS Code',
  'launch-settings': '.NET launch settings', detected: 'detected'
});

export async function run(root, application, { json = false } = {}) {
  const { loadEnvironmentDeclaration } = await import('../environment-declaration.mjs');
  const { suggestApplication } = await import('../app-suggestions.mjs');
  const declaration = await loadEnvironmentDeclaration(root, { optional: true });
  const result = await suggestApplication(root, {
    capabilityId: application.capabilityId, capability: application.capability, repositoryId: application.repositoryId,
    repositories: application.repositories, declaration, policy: application.policy
  });
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
