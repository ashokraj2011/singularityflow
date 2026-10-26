/**
 * `singularity-flow app config preview --application-file FILE [--capability ID] [--json]`
 * [RUN amendment "IntelliJ-style run configurations" §1]: a whole application block checked and
 * resolved, the way IntelliJ previews a run configuration's command line. A read: the file is read
 * bounded, nothing runs and nothing is written. The capability (by default the one that owns this
 * checkout) gives the repositories an entry may name and the private paths a run would use; its own
 * block in capabilities.yml is not read, so a broken block can be previewed while it is fixed.
 */
import path from 'node:path';

import { optionString, SingularityFlowError } from '../util.mjs';

export const APP_CONFIG_PREVIEW_RESULT = 'sflow-app-config-preview';

function lineFor(resolved) {
  return `${resolved.argv.join(' ')}${resolved.envNames.length ? ` (with ${resolved.envNames.join(', ')} set)` : ''}`;
}

export async function run(root, options, positionals, { json = false } = {}) {
  if (['save-local', 'reset-local'].includes(positionals[2])) {
    if (positionals.length > 3) throw new SingularityFlowError('A local run configuration takes no extra operands.');
    const { resolveCapabilityApplication } = await import('../capability-application-context.mjs');
    const context = await resolveCapabilityApplication(root, { capabilityId: optionString(options, 'capability'), readApplication: false });
    const local = await import('../local-application-profile.mjs');
    let result;
    if (positionals[2] === 'reset-local') result = await local.resetLocalApplicationProfile(root, context.capabilityId);
    else {
      const { readApplicationBlockFile } = await import('../capability-application-file.mjs');
      const file = optionString(options, 'application-file');
      if (!file) throw new SingularityFlowError('save-local needs --application-file.');
      result = await local.saveLocalApplicationProfile(root, context, readApplicationBlockFile(file, { suffix: '' }));
    }
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (positionals[2] !== 'preview' || positionals.length > 3) {
    throw new SingularityFlowError('Use app config preview|save-local --application-file <FILE>, or app config reset-local [--capability ID] [--json].', {
      code: 'APP_COMMAND_INVALID', details: { available: ['preview', 'save-local', 'reset-local'] } });
  }
  const file = optionString(options, 'application-file', null);
  if (!file) {
    throw new SingularityFlowError('app config preview needs --application-file <FILE>: the application block to check (YAML or JSON).', {
      code: 'APP_COMMAND_INVALID' });
  }
  const [{ readApplicationBlockFile }, { resolveCapabilityApplication }, { previewApplication }, { appRunPaths }] = await Promise.all([
    import('../capability-application-file.mjs'), import('../capability-application-context.mjs'), import('../run-configurations.mjs'),
    import('../application-run.mjs')]);
  const block = readApplicationBlockFile(file, { suffix: '' });
  const relative = path.relative(root, process.cwd()).replaceAll('\\', '/');
  const context = await resolveCapabilityApplication(root, {
    capabilityId: optionString(options, 'capability', null), subjectPath: relative && !relative.startsWith('..') ? relative : '', readApplication: false
  });
  const preview = previewApplication(context.capabilityId, block, {
    checkoutRoot: root, repositoryId: context.repositoryId, repositories: context.repositories.length ? context.repositories : context.implicit ? [context.capabilityId] : [],
    pathsFor: (startId) => appRunPaths(root, context.capabilityId, startId)
  });
  const result = { resultType: APP_CONFIG_PREVIEW_RESULT, capability: context.capabilityId, file, ...preview };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log(`Application block in ${file} for ${context.capabilityId} (checked only; nothing ran and nothing was written):`);
  if (!result.entries.length) console.log('  no start entries');
  for (const entry of result.entries) {
    const label = `${entry.id ?? `start[${entry.index}]`}${entry.name && entry.name !== entry.id ? ` (${entry.name})` : ''} · ${entry.type}`;
    if (entry.errors.length) {
      console.log(`  ${label}: ${entry.errors.length} error${entry.errors.length === 1 ? '' : 's'}`);
      for (const error of entry.errors) console.log(`    ${error.path}: ${error.message}`);
      continue;
    }
    console.log(`  ${label}`);
    for (const environment of entry.environments) {
      console.log(`    ${environment.name ?? 'command line'}: ${lineFor(environment.resolved)}`);
      for (const step of environment.resolved.beforeLaunch) console.log(`      before launch: ${step.argv.join(' ')} (in ${step.workingDirectory})`);
    }
  }
  for (const error of result.errors) console.log(`Block${error.path ? ` ${error.path}` : ''}: ${error.message}`);
  console.log(result.valid ? 'Valid. Write it with capability set <ID> --application-file, or propose it with capability edit <ID> --lead <URL> --application-file --mode set.'
    : 'Fix the errors above, then preview again; nothing is written until capability set or capability edit.');
  return result;
}
