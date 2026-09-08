import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { nowIso, run, SingularityFlowError, writeJson } from './util.mjs';

const SETTINGS = Object.freeze({
  fsmonitor: 'core.fsmonitor',
  'untracked-cache': 'core.untrackedCache'
});

function get(root, key) {
  const result = run('git', ['config', '--local', '--get', key], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitVersion(root) {
  const text = run('git', ['version'], { cwd: root }).stdout.trim();
  return text.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? [0, 0, 0];
}

function supportsBuiltinFsmonitor(version) {
  return version[0] > 2 || (version[0] === 2 && version[1] >= 37);
}

export function inspectFosGitSpeed(root) {
  const version = gitVersion(root);
  const settings = Object.fromEntries(Object.entries(SETTINGS).map(([id, key]) => [id, {
    key,
    value: get(root, key),
    compatible: id !== 'fsmonitor' || supportsBuiltinFsmonitor(version),
    scope: 'repository-local'
  }]));
  return {
    status: 'inspected',
    gitVersion: version.join('.'),
    platform: process.platform,
    settings,
    changed: false
  };
}

export async function applyFosGitSpeed(root, enabled = []) {
  const selected = [...new Set(enabled)];
  if (!selected.length || selected.some((id) => !Object.hasOwn(SETTINGS, id))) {
    throw new SingularityFlowError(
      'Choose one or more supported accelerators: fsmonitor, untracked-cache.', {
        code: 'GIT_SPEED_SELECTION_INVALID'
      }
    );
  }
  const before = inspectFosGitSpeed(root);
  for (const id of selected) {
    const state = before.settings[id];
    if (!state.compatible) throw new SingularityFlowError(
      `Git accelerator '${id}' is not compatible with this Git/runtime. Nothing was changed.`, {
        code: 'GIT_SPEED_UNSUPPORTED'
      }
    );
    if (state.value != null && !['false', 'true'].includes(state.value.toLowerCase())) {
      throw new SingularityFlowError(
        `Git setting '${state.key}' already has a custom repository value. Review it manually; SFlow preserved it.`,
        { code: 'GIT_SPEED_CUSTOM_SETTING' }
      );
    }
  }
  const changed = [];
  try {
    for (const id of selected) {
      if (before.settings[id].value?.toLowerCase() === 'true') continue;
      run('git', ['config', '--local', SETTINGS[id], 'true'], { cwd: root });
      changed.push(id);
    }
    const after = inspectFosGitSpeed(root);
    for (const id of selected) {
      if (after.settings[id].value?.toLowerCase() !== 'true') throw new SingularityFlowError(
        `Git did not retain '${SETTINGS[id]}' as requested.`, { code: 'GIT_SPEED_VERIFY_FAILED' }
      );
    }
    const receipt = {
      schemaVersion: currentSchemaVersion('fos-git-accelerator-receipt'),
      kind: 'fos-git-accelerator-receipt',
      receiptId: `fos-git-speed-${randomUUID()}`,
      scope: 'repository-local',
      selected,
      changed,
      before: Object.fromEntries(selected.map((id) => [id, before.settings[id].value])),
      after: Object.fromEntries(selected.map((id) => [id, after.settings[id].value])),
      recordedAt: nowIso()
    };
    await writeJson(path.join(gitCommonDir(root), 'singularity-flow', 'fos', 'git-speed',
      'receipts', `${receipt.receiptId}.json`), receipt);
    return { status: 'applied', changed: changed.length > 0, receipt, report: after };
  } catch (error) {
    for (const id of changed.reverse()) {
      const current = get(root, SETTINGS[id]);
      if (current?.toLowerCase() !== 'true') continue;
      if (before.settings[id].value == null) {
        run('git', ['config', '--local', '--unset', SETTINGS[id]], { cwd: root, allowFailure: true });
      } else {
        run('git', ['config', '--local', SETTINGS[id], before.settings[id].value], { cwd: root });
      }
    }
    throw error;
  }
}
