import { createHash } from 'node:crypto';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { run, SingularityFlowError } from '../util.mjs';
import { redactDiagnosticText } from '../git-remote-diagnostics.mjs';
import { COMMIT_HOOK_STAGES, rcpDigest } from './policy.mjs';
import { withoutGitProcessOverrides } from '../git-enterprise-environment.mjs';

const CONFIG = /^(?:core\.(?:hooksPath|autocrlf|safecrlf|attributesfile|eol|filemode|symlinks|ignorecase|commentchar)|commit\.(?:cleanup|template|gpgsign)|i18n\.commitEncoding|gpg\.(?:format|program|openpgp\.program|ssh\.(?:program|allowedsignersfile))|user\.(?:name|email|signingkey)|filter\.[^.]+\.(?:clean|smudge|process|required))$/iu;
const SETUP = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.pre-commit-config.yaml', '.commitlintrc', '.commitlintrc.json', '.commitlintrc.yaml', '.commitlintrc.yml', 'commitlint.config.js', 'commitlint.config.cjs', 'commitlint.config.mjs', '.gitattributes', '.husky/pre-commit', '.husky/prepare-commit-msg', '.husky/commit-msg', '.husky/pre-push'];
const MAX_FILE = 4 * 1024 * 1024;
async function observation(file, { includeShebang = false } = {}) {
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { status: 'missing', sha256: null }; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE) return { status: 'unavailable', sha256: null, reason: 'Not a bounded regular file.' };
  const bytes = await readFile(file);
  const executable = await access(file, constants.X_OK).then(() => true, () => false);
  return { status: 'present', sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length,
    ...(includeShebang ? { executable, shebang: bytes.subarray(0, 256).toString('utf8').split(/\r?\n/u)[0].startsWith('#!') } : {}) };
}

/** Discovery reads files/configuration only. It never runs a hook, imports JS config or installs tools. */
export async function discoverCommitPolicy(root, { env = process.env, platform = process.platform, git = run } = {}) {
  root = await realpath(root);
  env = { ...withoutGitProcessOverrides(env), GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' };
  const read = args => git('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, env, allowFailure: true, timeoutMs: 15000, maxBuffer: 1024 * 1024 });
  const location = read(['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  const gitDirectory = read(['rev-parse', '--absolute-git-dir']);
  if (location.status !== 0 || gitDirectory.status !== 0) throw new SingularityFlowError('Cannot resolve the selected repository’s effective hook location.', { code: 'RCP_DISCOVERY_UNAVAILABLE' });
  const hooksPath = path.resolve(root, location.stdout.trim());
  const configRead = read(['config', '--null', '--show-origin', '--show-scope', '--get-regexp', '^(core\\.(hookspath|autocrlf|safecrlf|attributesfile|eol|filemode|symlinks|ignorecase|commentchar)|commit\\.(cleanup|template|gpgsign)|i18n\\.commitencoding|gpg\\.(format|program|openpgp\\.program|ssh\\.(program|allowedsignersfile))|user\\.(name|email|signingkey)|filter\\..*\\.(clean|smudge|process|required))$']);
  if (![0, 1].includes(configRead.status)) throw new SingularityFlowError('Cannot inspect effective Git settings and their origins.', { code: 'RCP_DISCOVERY_UNAVAILABLE' });
  // With -z, each row is scope NUL origin NUL key LF value NUL. No executable config is loaded.
  const fields = configRead.stdout.split('\0'); if (fields.at(-1) === '') fields.pop();
  if (fields.length % 3) throw new SingularityFlowError('Git returned malformed effective configuration origins.', { code: 'RCP_DISCOVERY_UNAVAILABLE' });
  const configuration = [];
  for (let n = 0; n < fields.length; n += 3) {
    const split = fields[n + 2].indexOf('\n'); const name = fields[n + 2].slice(0, split), value = fields[n + 2].slice(split + 1);
    if (split < 0 || !CONFIG.test(name)) throw new SingularityFlowError('Git returned an unexpected configuration item.', { code: 'RCP_DISCOVERY_UNAVAILABLE' });
    configuration.push({ scope: fields[n], origin: redactDiagnosticText(fields[n + 1]), name,
      valueSha256: rcpDigest(value), ...(name.toLowerCase().startsWith('filter.') ? {} : { value: redactDiagnosticText(value) }) });
  }
  const hooks = await Promise.all(COMMIT_HOOK_STAGES.map(async stage => {
    const absolutePath = path.join(hooksPath, stage), found = await observation(absolutePath, { includeShebang: true });
    return { stage, path: absolutePath, ...found, classification: found.status === 'missing' ? 'not-applicable' : found.status === 'present' ? 'requires-confirmation' : 'unavailable',
      execution: 'not-executed', nativeAvailability: found.status !== 'present' ? found.status : platform === 'win32' ? 'requires-native-git-check' : found.executable ? 'available' : 'not-executable' };
  }));
  const setup = [];
  for (const relative of SETUP) {
    const found = await observation(path.join(root, relative));
    if (found.status !== 'missing') setup.push({ path: relative, ...found, classification: found.status === 'present' ? 'recognized' : 'unavailable', semantics: 'setup-intent-not-adopted-policy' });
  }
  const inputFiles = [...setup];
  for (const setting of configuration.filter(entry => ['core.attributesfile','commit.template','gpg.ssh.allowedsignersfile'].includes(entry.name.toLowerCase()) && entry.value)) {
    const configured = setting.value.startsWith('~/') && env.HOME ? path.join(env.HOME, setting.value.slice(2)) : path.resolve(root, setting.value);
    inputFiles.push({setting:setting.name,path:configured,...await observation(configured)});
  }
  for (const relative of ['info/attributes']) {
    const absolutePath = path.join(gitDirectory.stdout.trim(), relative), found = await observation(absolutePath);
    if (found.status !== 'missing') inputFiles.push({ path: absolutePath, ...found });
  }
  const version = read(['--version']);
  const record = { schemaVersion: 1, kind: 'repository-commit-policy-discovery', repositoryPath: root, host: platform,
    effectiveHooksPath: hooksPath, configuration, hooks, setup, inputFiles,
    gitVersion: version.status === 0 ? version.stdout.trim() : null, observationsOnly: true,
    runtimeBinding: { platform, arch: process.arch, node: process.version, executableSha256: rcpDigest(process.execPath), pathSha256: rcpDigest(env.PATH ?? env.Path ?? ''), hookEnvironmentSha256: rcpDigest(Object.entries(env).filter(([name]) => /^(?:HUSKY|LEFTHOOK|SKIP|CI|NODE_OPTIONS|npm_config_|SHELL|COMSPEC)/iu.test(name)).sort()) },
    limitations: ['Checked-in setup intent does not establish installed hooks or approved equivalence.', 'No commit history, hook execution or executable configuration evaluation was used.'] };
  return { ...record, discoverySha256: rcpDigest(record) };
}
