import path from 'node:path';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { nowIso, run, writeJson } from './util.mjs';

function redactRemote(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/@]+@/, '//***@');
  }
}

function git(root, args) {
  return run('git', args, { cwd: root, allowFailure: true });
}

export async function validateLedgerDeployment(root, rawConfig = {}, {
  offline = false,
  confirmations = {},
  record = false,
  outputPath = 'singularity/deployment/ledger-validation.json'
} = {}) {
  const config = normalizeLedgerConfig(rawConfig);
  const checks = [];
  checks.push({
    id: 'ledger-enabled',
    status: config.enabled ? 'pass' : 'fail',
    detail: config.enabled ? 'append-only ledger is enabled' : 'ledger.enabled is false; there is no deployment to validate'
  });
  const remote = git(root, ['remote', 'get-url', config.remote]);
  const remoteUrl = remote.status === 0 ? remote.stdout.trim() : null;
  checks.push({
    id: 'remote-configured',
    status: remoteUrl ? 'pass' : 'fail',
    detail: remoteUrl ? `${config.remote}: ${redactRemote(remoteUrl)}` : `Git remote '${config.remote}' is not configured`
  });

  if (remoteUrl && !offline) {
    const remoteRefs = git(root, ['ls-remote', config.remote]);
    checks.push({
      id: 'remote-readable',
      status: remoteRefs.status === 0 ? 'pass' : 'fail',
      detail: remoteRefs.status === 0 ? 'remote refs are readable with the current Git credentials' : (remoteRefs.stderr || remoteRefs.stdout).trim()
    });
    const branch = git(root, ['ls-remote', '--heads', config.remote, `refs/heads/${config.branch}`]);
    checks.push({
      id: 'ledger-branch',
      status: branch.status === 0 && branch.stdout.trim() ? 'pass' : 'fail',
      detail: branch.stdout.trim() ? `${config.branch} exists on ${config.remote}` : `${config.branch} is not published on ${config.remote}`
    });
    if (config.pinTransport !== 'none') {
      const pattern = config.pinTransport === 'refs' ? 'refs/singularity/pins/*' : 'refs/heads/singularity/pins/*';
      const pins = git(root, ['ls-remote', config.remote, pattern]);
      checks.push({
        id: 'pin-transport-readable',
        status: pins.status === 0 ? 'pass' : 'fail',
        detail: pins.status === 0
          ? `${config.pinTransport} pin namespace is readable${pins.stdout.trim() ? '' : ' (no pins published yet)'}`
          : (pins.stderr || pins.stdout).trim()
      });
    }
  } else if (offline) checks.push({ id: 'remote-readable', status: 'warn', detail: 'network checks skipped by --offline' });

  const signingKey = git(root, ['config', '--get', 'user.signingkey']);
  const signingRequired = config.signing === 'commit';
  checks.push({
    id: 'commit-signing',
    status: !signingRequired || signingKey.status === 0 ? 'pass' : 'fail',
    detail: !signingRequired ? 'commit signing is not required by this trust tier' : signingKey.status === 0 ? 'Git signing key is configured' : 'ledger signing requires user.signingkey'
  });

  const highTrust = ['T2', 'T3'].includes(config.trustTier);
  checks.push({
    id: 'protected-branch-policy',
    status: confirmations.protectedBranch ? 'pass' : highTrust ? 'fail' : 'warn',
    detail: confirmations.protectedBranch
      ? 'administrator confirmed ledger branch protection and non-force-push policy'
      : 'Git cannot inspect host branch-protection policy; administrator confirmation is required for T2/T3'
  });
  checks.push({
    id: 'authenticated-push-policy',
    status: confirmations.pushPolicy ? 'pass' : highTrust ? 'fail' : 'warn',
    detail: confirmations.pushPolicy
      ? 'administrator confirmed authenticated append permissions and force-push denial'
      : 'read-only validation cannot prove server-side push authorization'
  });
  if (config.pinTransport !== 'none') {
    checks.push({
      id: 'pin-retention-policy',
      status: confirmations.pinRetention ? 'pass' : config.trustTier === 'T3' ? 'fail' : 'warn',
      detail: confirmations.pinRetention
        ? 'administrator confirmed pin retention for the configured transport'
        : 'server retention and deletion policy requires administrator confirmation'
    });
  }

  const result = {
    schemaVersion: 1,
    checkedAt: nowIso(),
    repositoryCommit: git(root, ['rev-parse', 'HEAD']).stdout.trim() || null,
    trustTier: config.trustTier,
    remote: config.remote,
    remoteUrl: redactRemote(remoteUrl),
    branch: config.branch,
    pinTransport: config.pinTransport,
    offline,
    checks,
    valid: !checks.some((check) => check.status === 'fail')
  };
  if (record) {
    result.recordedPath = outputPath;
    await writeJson(path.join(root, outputPath), result);
  }
  return result;
}
