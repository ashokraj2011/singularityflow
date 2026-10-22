/** Request-local batched metadata. Git's dependency stamps, not a timer, fence every reuse. */
import { creationConfigurationOwner } from './creation-context.mjs';
import { installCreationRead } from './git-remote-diagnostics.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { run, SingularityFlowError } from './util.mjs';

installCreationRead((root, remote, env) => {
  if (!creationConfigurationOwner()?.active) return null;
  const literal = String(remote).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const result = run('git', ['config', '--local', '--null', '--get-regexp',
    `^remote\\.${literal}\\.(url|pushurl)$`], {
    cwd: root, allowFailure: true, env: withoutGitProcessOverrides(env), timeoutClass: 'local-read'
  });
  const failed = result?.error || result?.signal || result?.timedOut || result?.blocked
    || result?.outputOverflow || result?.aborted;
  const absent = result?.status === 1 && result.stdout === '' && result.stderr === '' && !failed;
  if (!absent && (result?.status !== 0 || failed || typeof result.stdout !== 'string'
      || result.stderr !== '' || !result.stdout.endsWith('\0'))) throw new SingularityFlowError(
    'Cannot read the configured Git remote authority safely.', { code: 'GIT_REMOTE_CONFIG_UNAVAILABLE',
      details: { status: result?.status ?? null, timedOut: result?.timedOut === true,
        blocked: result?.blocked === true, outputOverflow: result?.outputOverflow === true,
        aborted: result?.aborted === true } });
  const batch = new Map();
  for (const row of result.stdout.split('\0').filter(Boolean)) {
    const separator = row.indexOf('\n'), key = row.slice(0, separator);
    if (separator < 0 || ![`remote.${remote}.url`, `remote.${remote}.pushurl`].includes(key)) {
      throw new SingularityFlowError('Git returned malformed configured remote authority data.',
        { code: 'GIT_REMOTE_CONFIG_INVALID' });
    }
    if (!batch.has(key)) batch.set(key, []);
    batch.get(key).push(row.slice(separator + 1));
  }
  incrementCommandCounter('git.creation-remote-config-batches');
  return key => {
    const values = batch.get(key) ?? [];
    return { status: values.length ? 0 : 1, stdout: values.length ? `${values.join('\n')}\n` : '', stderr: '' };
  };
});
