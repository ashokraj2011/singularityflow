import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { gitCommonDir } from './git.mjs';
import { canonicalJson } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { resolveWindowsSystemTool } from './platform-process.mjs';
import {
  listPrivateSidecar, readPrivateSidecar, safePrivateSidecarDirectory,
  writeMutablePrivateSidecar
} from './private-sidecar.mjs';
import { SingularityFlowError } from './util.mjs';

const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_STORAGE_STATE_BYTES = 2 * 1024 * 1024;
const MAX_COOKIES = 2_000;
const MAX_ORIGINS = 256;
const MAX_LOCAL_STORAGE_ITEMS = 20_000;
const MAX_STRING_BYTES = 1024 * 1024;
const MAX_PROFILE_STATE_FILES = 32;
const execFileAsync = promisify(execFile);
const WINDOWS_FULL_CONTROL = 2_032_127;
const WINDOWS_ACL_SCRIPT = [
  '$acl=Get-Acl -LiteralPath $args[0]',
  '$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {',
  '[pscustomobject]@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();inherited=$_.IsInherited;rights=[int]$_.FileSystemRights}',
  '})',
  '[pscustomobject]@{protected=$acl.AreAccessRulesProtected;rules=$rules} | ConvertTo-Json -Compress -Depth 4'
].join(';');
const WINDOWS_RECURSIVE_ACL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$target=[System.IO.Path]::GetFullPath($args[0])',
  '$sid=New-Object System.Security.Principal.SecurityIdentifier($args[1])',
  "$apply=$args[2] -eq 'apply'",
  '$root=Get-Item -LiteralPath $target -Force',
  '$items=@($root)+@(Get-ChildItem -LiteralPath $target -Force -Recurse)',
  "if($items.Count -gt 50001){throw 'private MCP tree exceeds its entry ceiling'}",
  '$unsafe=0',
  'foreach($item in $items){',
  "if(($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){throw 'private MCP tree contains a reparse point'}",
  'if($apply){',
  '$acl=Get-Acl -LiteralPath $item.FullName',
  '$acl.SetAccessRuleProtection($true,$false)',
  '@($acl.Access) | ForEach-Object { [void]$acl.RemoveAccessRuleSpecific($_) }',
  "$inheritance=if($item.PSIsContainer){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None}",
  '$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)',
  '[void]$acl.AddAccessRule($rule)',
  'Set-Acl -LiteralPath $item.FullName -AclObject $acl',
  '}',
  '$observed=Get-Acl -LiteralPath $item.FullName',
  '$rules=@($observed.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))',
  '$valid=$observed.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and $rules[0].AccessControlType.ToString() -eq "Allow" -and -not $rules[0].IsInherited -and (([int]$rules[0].FileSystemRights -band 2032127) -eq 2032127)',
  'if(-not $valid){$unsafe++}',
  '}',
  '[pscustomobject]@{protected=($unsafe -eq 0);entries=$items.Count;unsafe=$unsafe} | ConvertTo-Json -Compress'
].join(';');

function windowsSid(text) {
  return String(text ?? '').match(/S-\d+(?:-\d+)+/i)?.[0] ?? null;
}

function windowsAclExecutables(environment) {
  try {
    const cmd = resolveWindowsSystemTool(environment, 'cmd.exe');
    const system32 = path.win32.dirname(cmd);
    return Object.freeze({
      whoami: resolveWindowsSystemTool(environment, 'whoami.exe'),
      icacls: resolveWindowsSystemTool(environment, 'icacls.exe'),
      powershell: path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    });
  } catch (error) {
    throw new SingularityFlowError(
      'Windows system tools cannot be resolved from a fully qualified local SystemRoot or WINDIR.',
      { code: 'MCP_AUTH_WINDOWS_ACL_FAILED', cause: error }
    );
  }
}

/** Apply and/or verify a non-inherited, current-user-only Windows ACL without a shell. */
export async function secureWindowsAuthAcl(target, {
  directory = false,
  apply = true,
  recursive = false,
  execFileCommand = execFileAsync,
  environment = process.env
} = {}) {
  const executables = windowsAclExecutables(environment);
  let identity;
  try {
    identity = await execFileCommand(executables.whoami, ['/user', '/fo', 'csv', '/nh'], {
      shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024,
      env: environment
    });
  } catch (error) {
    throw new SingularityFlowError('Windows could not resolve the current user SID for private MCP state.', {
      code: 'MCP_AUTH_WINDOWS_ACL_FAILED', cause: error
    });
  }
  const sid = windowsSid(identity?.stdout);
  if (!sid) {
    throw new SingularityFlowError('Windows did not return a valid current-user SID for private MCP state.', {
      code: 'MCP_AUTH_WINDOWS_ACL_FAILED'
    });
  }
  if (recursive) {
    let observed;
    try {
      const result = await execFileCommand(executables.powershell, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        WINDOWS_RECURSIVE_ACL_SCRIPT, target, sid, apply ? 'apply' : 'verify'
      ], {
        shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024,
        env: environment
      });
      observed = JSON.parse(String(result?.stdout ?? '').trim());
    } catch (error) {
      throw new SingularityFlowError('Windows could not apply or verify a user-only ACL on private MCP state.', {
        code: 'MCP_AUTH_WINDOWS_ACL_FAILED', cause: error
      });
    }
    if (observed?.protected !== true || !Number.isSafeInteger(observed?.entries)
        || observed.entries < 1 || observed.entries > 50_001 || observed?.unsafe !== 0) {
      throw new SingularityFlowError('Private MCP state does not have a recursively verified current-user-only Windows ACL.', {
        code: 'MCP_AUTH_WINDOWS_ACL_UNSAFE'
      });
    }
    return {
      protected: true, principal: 'current-user', access: 'full-control',
      recursive: true, entries: observed.entries
    };
  }
  if (apply) {
    try {
      await execFileCommand(executables.icacls, [
        target, '/inheritance:r', '/grant:r',
        `*${sid}:${directory ? '(OI)(CI)' : ''}(F)`
      ], {
        shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024,
        env: environment
      });
    } catch (error) {
      throw new SingularityFlowError('Windows could not apply a user-only ACL to private MCP state.', {
        code: 'MCP_AUTH_WINDOWS_ACL_FAILED', cause: error
      });
    }
  }
  let observed;
  try {
    const result = await execFileCommand(executables.powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_SCRIPT, target
    ], {
      shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024,
      env: environment
    });
    observed = JSON.parse(String(result?.stdout ?? '').trim());
  } catch (error) {
    throw new SingularityFlowError('Windows could not verify the ACL on private MCP state.', {
      code: 'MCP_AUTH_WINDOWS_ACL_FAILED', cause: error
    });
  }
  const rules = Array.isArray(observed?.rules)
    ? observed.rules
    : observed?.rules ? [observed.rules] : [];
  const valid = observed?.protected === true
    && rules.length === 1
    && String(rules[0]?.sid).toUpperCase() === sid.toUpperCase()
    && rules[0]?.type === 'Allow'
    && rules[0]?.inherited === false
    && (Number(rules[0]?.rights) & WINDOWS_FULL_CONTROL) === WINDOWS_FULL_CONTROL;
  if (!valid) {
    throw new SingularityFlowError('Private MCP state does not have a verified current-user-only Windows ACL.', {
      code: 'MCP_AUTH_WINDOWS_ACL_UNSAFE'
    });
  }
  return { protected: true, principal: 'current-user', access: 'full-control' };
}

function fail(message, code = 'MCP_AUTH_STORAGE_STATE_INVALID') {
  throw new SingularityFlowError(message, { code });
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, label, { allowEmpty = false, optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || (!allowEmpty && !value.length)
      || Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) {
    fail(`Playwright storage state ${label} must be a bounded${allowEmpty ? '' : ', non-empty'} string.`);
  }
  return value;
}

function validateCookie(cookie, index) {
  if (!plainObject(cookie)) fail(`Playwright storage state cookie ${index + 1} must be an object.`);
  for (const field of ['name', 'domain', 'path']) boundedString(cookie[field], `cookie ${index + 1} ${field}`);
  boundedString(cookie.value, `cookie ${index + 1} value`, { allowEmpty: true });
  if (cookie.expires != null && (!Number.isFinite(cookie.expires) || cookie.expires < -1)) {
    fail(`Playwright storage state cookie ${index + 1} expires must be a finite number greater than or equal to -1.`);
  }
  for (const field of ['httpOnly', 'secure']) {
    if (cookie[field] != null && typeof cookie[field] !== 'boolean') {
      fail(`Playwright storage state cookie ${index + 1} ${field} must be boolean.`);
    }
  }
  if (cookie.sameSite != null && !['Strict', 'Lax', 'None'].includes(cookie.sameSite)) {
    fail(`Playwright storage state cookie ${index + 1} sameSite must be Strict, Lax, or None.`);
  }
}

function validateJsonValue(value, label, depth = 0) {
  if (depth > 20) fail(`Playwright storage state ${label} exceeds the nesting limit.`);
  if (value == null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string') boundedString(value, label, { allowEmpty: true });
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`Playwright storage state ${label} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_LOCAL_STORAGE_ITEMS) fail(`Playwright storage state ${label} contains too many entries.`);
    value.forEach((entry, index) => validateJsonValue(entry, `${label}[${index}]`, depth + 1));
    return;
  }
  if (!plainObject(value)) fail(`Playwright storage state ${label} contains an unsupported value.`);
  const entries = Object.entries(value);
  if (entries.length > 1_000) fail(`Playwright storage state ${label} contains too many fields.`);
  for (const [key, entry] of entries) {
    boundedString(key, `${label} key`);
    validateJsonValue(entry, `${label}.${key}`, depth + 1);
  }
}

/** Validate the documented Playwright storage-state envelope without logging any stored value. */
export function validatePlaywrightStorageState(value) {
  if (!plainObject(value)) fail('Playwright storage state must be a JSON object.');
  if (!Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    fail('Playwright storage state must contain cookies and origins arrays.');
  }
  if (value.cookies.length > MAX_COOKIES) fail(`Playwright storage state exceeds the ${MAX_COOKIES}-cookie limit.`);
  if (value.origins.length > MAX_ORIGINS) fail(`Playwright storage state exceeds the ${MAX_ORIGINS}-origin limit.`);
  value.cookies.forEach(validateCookie);
  value.origins.forEach((origin, index) => {
    if (!plainObject(origin)) fail(`Playwright storage state origin ${index + 1} must be an object.`);
    const rawOrigin = boundedString(origin.origin, `origin ${index + 1}`);
    let parsed;
    try { parsed = new URL(rawOrigin); } catch { fail(`Playwright storage state origin ${index + 1} is not a valid URL origin.`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.origin !== rawOrigin) {
      fail(`Playwright storage state origin ${index + 1} must be an exact HTTP(S) origin without credentials.`);
    }
    if (!Array.isArray(origin.localStorage)) {
      fail(`Playwright storage state origin ${index + 1} localStorage must be an array.`);
    }
    if (origin.localStorage.length > MAX_LOCAL_STORAGE_ITEMS) {
      fail(`Playwright storage state origin ${index + 1} contains too many localStorage entries.`);
    }
    origin.localStorage.forEach((entry, itemIndex) => {
      if (!plainObject(entry)) fail(`Playwright storage state localStorage item ${itemIndex + 1} must be an object.`);
      boundedString(entry.name, `origin ${index + 1} localStorage name`);
      boundedString(entry.value, `origin ${index + 1} localStorage value`, { allowEmpty: true });
    });
    // Recent Playwright releases can include IndexedDB snapshots. Keep them bounded and JSON-only;
    // the Playwright runtime owns their evolving internal representation.
    if (origin.indexedDB != null) validateJsonValue(origin.indexedDB, `origin ${index + 1} indexedDB`);
  });
  return structuredClone(value);
}

function authRoot(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'mcp', 'auth', 'playwright');
}

function activeProfilePath(root) {
  return path.join(authRoot(root), 'active.json');
}

function profileStatePath(root, profileId, storageStateSha256) {
  if (!PROFILE_ID.test(profileId) || !SHA256.test(storageStateSha256)) {
    fail('Managed Playwright authentication profile metadata is invalid.', 'MCP_AUTH_PROFILE_INVALID');
  }
  return path.join(authRoot(root), 'states', `${profileId}-${storageStateSha256.slice(7)}.json`);
}

function storageStateDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function preparePrivateAuthDirectory(root, directory, {
  platform = process.platform, windowsAcl = secureWindowsAuthAcl
} = {}) {
  await safePrivateSidecarDirectory(root, directory, { create: true });
  if (platform === 'win32') await windowsAcl(directory, { directory: true, apply: true });
  else {
    await chmod(directory, 0o700);
    const info = await stat(directory);
    if ((info.mode & 0o077) !== 0) {
      fail('Managed Playwright authentication directory permissions are not private.', 'MCP_AUTH_PROFILE_PERMISSIONS');
    }
  }
}

async function protectPrivateAuthFile(root, file, {
  platform = process.platform, windowsAcl = secureWindowsAuthAcl
} = {}) {
  await safePrivateSidecarDirectory(root, path.dirname(file));
  if (platform === 'win32') await windowsAcl(file, { directory: false, apply: true });
  else {
    await chmod(file, 0o600);
    const info = await stat(file);
    if ((info.mode & 0o077) !== 0) {
      fail('Managed Playwright authentication file permissions are not private.', 'MCP_AUTH_PROFILE_PERMISSIONS');
    }
  }
}

async function verifyPrivateAuthPermissions(root, file, {
  platform = process.platform, windowsAcl = secureWindowsAuthAcl
} = {}) {
  for (const directory of [authRoot(root), path.join(authRoot(root), 'states')]) {
    await safePrivateSidecarDirectory(root, directory);
    if (platform === 'win32') await windowsAcl(directory, { directory: true, apply: false });
    else {
      const info = await stat(directory);
      if ((info.mode & 0o077) !== 0) {
        fail('Managed Playwright authentication directory permissions are not private.', 'MCP_AUTH_PROFILE_PERMISSIONS');
      }
    }
  }
  for (const protectedFile of [activeProfilePath(root), file]) {
    const info = await lstat(protectedFile);
    if (!info.isFile() || info.isSymbolicLink()) {
      fail('Managed Playwright authentication file permissions are not private.', 'MCP_AUTH_PROFILE_PERMISSIONS');
    }
    if (platform === 'win32') await windowsAcl(protectedFile, { directory: false, apply: false });
    else if ((info.mode & 0o077) !== 0) {
      fail('Managed Playwright authentication file permissions are not private.', 'MCP_AUTH_PROFILE_PERMISSIONS');
    }
  }
}

async function readBoundedSource(file) {
  const target = path.resolve(String(file ?? ''));
  let before;
  try { before = await lstat(target); } catch {
    fail('The Playwright storage-state source could not be read.', 'MCP_AUTH_STORAGE_STATE_UNAVAILABLE');
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_STORAGE_STATE_BYTES) {
    fail('The Playwright storage-state source must be a regular, non-symbolic-link file within the size limit.',
      before.size > MAX_STORAGE_STATE_BYTES ? 'MCP_AUTH_STORAGE_STATE_LIMIT' : 'MCP_AUTH_STORAGE_STATE_UNSAFE');
  }
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('The Playwright storage-state source changed identity while it was opened.', 'MCP_AUTH_STORAGE_STATE_UNSAFE');
    }
    const bounded = Buffer.alloc(MAX_STORAGE_STATE_BYTES + 1);
    let offset = 0;
    while (offset < bounded.length) {
      const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_STORAGE_STATE_BYTES) {
      fail('The Playwright storage-state source exceeds the installed byte limit.', 'MCP_AUTH_STORAGE_STATE_LIMIT');
    }
    return bounded.subarray(0, offset);
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    fail('The Playwright storage-state source could not be read safely.', 'MCP_AUTH_STORAGE_STATE_UNSAFE');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function inspectSource(file) {
  const bytes = await readBoundedSource(file);
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    fail('The Playwright storage-state source is not valid JSON.');
  }
  const state = validatePlaywrightStorageState(parsed);
  const canonical = Buffer.from(canonicalJson(state));
  if (canonical.length > MAX_STORAGE_STATE_BYTES) {
    fail('The canonical Playwright storage state exceeds the installed byte limit.', 'MCP_AUTH_STORAGE_STATE_LIMIT');
  }
  return { canonical, storageStateSha256: storageStateDigest(canonical) };
}

async function readDescriptor(root) {
  const bytes = await readPrivateSidecar(root, activeProfilePath(root), {
    maximumBytes: 16 * 1024, optional: true
  });
  return bytes == null ? null : readRecord('mcp-auth-profile', bytes).record;
}

function safeBinding(descriptor) {
  if (!descriptor) return null;
  if (descriptor.serverId !== 'playwright' || !PROFILE_ID.test(descriptor.profileId ?? '')
      || !SHA256.test(descriptor.storageStateSha256 ?? '')) {
    fail('Managed Playwright authentication profile metadata is invalid.', 'MCP_AUTH_PROFILE_INVALID');
  }
  return Object.freeze({
    profileId: descriptor.profileId,
    storageStateSha256: descriptor.storageStateSha256
  });
}

async function verifiedProfile(root, {
  platform = process.platform, windowsAcl = secureWindowsAuthAcl
} = {}) {
  const descriptor = await readDescriptor(root);
  const binding = safeBinding(descriptor);
  if (!binding) return null;
  const file = profileStatePath(root, binding.profileId, binding.storageStateSha256);
  await verifyPrivateAuthPermissions(root, file, { platform, windowsAcl });
  const bytes = await readPrivateSidecar(root, file, { maximumBytes: MAX_STORAGE_STATE_BYTES });
  if (storageStateDigest(bytes) !== binding.storageStateSha256) {
    fail('Managed Playwright authentication state no longer matches its recorded digest.', 'MCP_AUTH_PROFILE_STALE');
  }
  let state;
  try { state = JSON.parse(bytes.toString('utf8')); } catch {
    fail('Managed Playwright authentication state is invalid.', 'MCP_AUTH_PROFILE_INVALID');
  }
  validatePlaywrightStorageState(state);
  return { descriptor, binding, file };
}

/** Return only non-secret profile identity and digest. */
export async function playwrightAuthProfileStatus(root, {
  platform = process.platform, windowsAcl = secureWindowsAuthAcl
} = {}) {
  try {
    const profile = await verifiedProfile(root, { platform, windowsAcl });
    return profile
      ? { status: 'configured', serverId: 'playwright', ...profile.binding }
      : { status: 'none', serverId: 'playwright', profileId: null, storageStateSha256: null };
  } catch (error) {
    return {
      status: 'invalid', serverId: 'playwright', profileId: null, storageStateSha256: null,
      reason: error?.code ?? 'MCP_AUTH_PROFILE_INVALID'
    };
  }
}

/** Non-mutating import inspection. The source path and all authentication values stay undisclosed. */
export async function previewPlaywrightAuthImport(root, {
  storageState, profileId, platform = process.platform, windowsAcl = secureWindowsAuthAcl
} = {}) {
  if (!PROFILE_ID.test(String(profileId ?? ''))) {
    fail('Playwright authentication profile must use lower-case kebab-case.', 'MCP_AUTH_PROFILE_INVALID');
  }
  if (!storageState) fail('Playwright authentication import requires --storage-state.', 'MCP_AUTH_STORAGE_STATE_UNAVAILABLE');
  const source = await inspectSource(storageState);
  const current = await playwrightAuthProfileStatus(root, { platform, windowsAcl });
  return {
    serverId: 'playwright', profileId,
    storageStateSha256: source.storageStateSha256,
    status: current.status === 'configured'
      && current.profileId === profileId
      && current.storageStateSha256 === source.storageStateSha256 ? 'unchanged'
      : current.status === 'configured' ? 'replace' : 'create',
    confirmation: source.storageStateSha256,
    requiresConfirmation: true
  };
}

async function removeRegularPrivateFile(root, file) {
  await safePrivateSidecarDirectory(root, path.dirname(file));
  const info = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink()) {
    fail('Managed Playwright authentication path is unsafe.', 'MCP_AUTH_PROFILE_INVALID');
  }
  await rm(file);
  return true;
}

/** Import and activate one private profile after exact content-bound confirmation. */
export async function importPlaywrightAuthProfile(root, {
  storageState, profileId, confirmation, platform = process.platform,
  windowsAcl = secureWindowsAuthAcl
} = {}) {
  const preview = await previewPlaywrightAuthImport(root, {
    storageState, profileId, platform, windowsAcl
  });
  if (confirmation !== preview.confirmation) {
    throw new SingularityFlowError(
      `Playwright authentication import requires --confirm ${preview.confirmation}.`,
      { code: 'MCP_AUTH_CONFIRMATION_REQUIRED', details: { profileId, storageStateSha256: preview.storageStateSha256 } }
    );
  }
  return withSubjectLock(root, { kind: 'mcp-auth', id: 'playwright' }, async () => {
    const source = await inspectSource(storageState);
    if (source.storageStateSha256 !== preview.storageStateSha256) {
      fail('The Playwright storage-state source changed after preview.', 'MCP_AUTH_STORAGE_STATE_CHANGED');
    }
    const prior = await verifiedProfile(root, { platform, windowsAcl }).catch(() => null);
    const target = profileStatePath(root, profileId, source.storageStateSha256);
    await preparePrivateAuthDirectory(root, authRoot(root), { platform, windowsAcl });
    await preparePrivateAuthDirectory(root, path.dirname(target), { platform, windowsAcl });
    await writeMutablePrivateSidecar(root, target, source.canonical, {
      maximumBytes: MAX_STORAGE_STATE_BYTES
    });
    await protectPrivateAuthFile(root, target, { platform, windowsAcl });
    const descriptor = {
      schemaVersion: currentSchemaVersion('mcp-auth-profile'),
      serverId: 'playwright', profileId, storageStateSha256: source.storageStateSha256
    };
    await writeMutablePrivateSidecar(root, activeProfilePath(root), canonicalJson(descriptor), {
      maximumBytes: 16 * 1024
    });
    await protectPrivateAuthFile(root, activeProfilePath(root), { platform, windowsAcl });
    if (prior?.file && prior.file !== target) await removeRegularPrivateFile(root, prior.file);
    return {
      serverId: 'playwright', profileId, storageStateSha256: source.storageStateSha256,
      status: preview.status === 'unchanged' ? 'unchanged' : 'configured'
    };
  });
}

/** Remove the active private profile after exact digest-bound confirmation. */
export async function removePlaywrightAuthProfile(root, {
  profileId, confirmation, platform = process.platform, windowsAcl = secureWindowsAuthAcl
} = {}) {
  return withSubjectLock(root, { kind: 'mcp-auth', id: 'playwright' }, async () => {
    const active = await verifiedProfile(root, { platform, windowsAcl });
    if (!active) return { status: 'none', serverId: 'playwright', profileId: null, storageStateSha256: null };
    if (profileId !== active.binding.profileId) {
      fail('The requested Playwright authentication profile is not active.', 'MCP_AUTH_PROFILE_MISMATCH');
    }
    if (confirmation !== active.binding.storageStateSha256) {
      throw new SingularityFlowError(
        `Removing the Playwright authentication profile requires --confirm ${active.binding.storageStateSha256}.`,
        { code: 'MCP_AUTH_CONFIRMATION_REQUIRED', details: active.binding }
      );
    }
    // Unpublish the active selector first. A crash can leave an unreachable secret file, but can
    // never leave the runtime believing a partly removed profile is usable.
    await removeRegularPrivateFile(root, activeProfilePath(root));
    await removeRegularPrivateFile(root, active.file);
    return { status: 'removed', serverId: 'playwright', ...active.binding };
  });
}

async function clearInventory(root) {
  const descriptor = await readPrivateSidecar(root, activeProfilePath(root), {
    maximumBytes: 16 * 1024, optional: true
  });
  const statesDirectory = path.join(authRoot(root), 'states');
  const entries = await listPrivateSidecar(root, statesDirectory, { optional: true });
  if (entries.length > MAX_PROFILE_STATE_FILES) {
    fail('Managed Playwright authentication storage contains too many files for safe clearing.', 'MCP_AUTH_PROFILE_INVALID');
  }
  const states = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail('Managed Playwright authentication storage contains an unsafe entry.', 'MCP_AUTH_PROFILE_INVALID');
    }
    const file = path.join(statesDirectory, entry.name);
    const bytes = await readPrivateSidecar(root, file, { maximumBytes: MAX_STORAGE_STATE_BYTES });
    states.push({ file, name: entry.name, sha256: storageStateDigest(bytes) });
  }
  const fingerprint = {
    descriptorSha256: descriptor ? storageStateDigest(descriptor) : null,
    states: states.map(({ name, sha256 }) => ({ name, sha256 }))
  };
  return {
    descriptor,
    states,
    confirmation: storageStateDigest(Buffer.from(canonicalJson(fingerprint)))
  };
}

/** Preview a recovery clear even when the active descriptor or state bytes are invalid. */
export async function previewClearPlaywrightAuthProfile(root) {
  const inventory = await clearInventory(root);
  return {
    serverId: 'playwright',
    status: inventory.descriptor || inventory.states.length ? 'clear' : 'none',
    stateFileCount: inventory.states.length,
    confirmation: inventory.confirmation,
    requiresConfirmation: Boolean(inventory.descriptor || inventory.states.length)
  };
}

/** Remove all managed Playwright auth state using an exact inventory-bound recovery digest. */
export async function clearPlaywrightAuthProfile(root, { confirmation } = {}) {
  return withSubjectLock(root, { kind: 'mcp-auth', id: 'playwright' }, async () => {
    const inventory = await clearInventory(root);
    if (!inventory.descriptor && !inventory.states.length) {
      return { status: 'none', serverId: 'playwright', removedStateFiles: 0 };
    }
    if (confirmation !== inventory.confirmation) {
      throw new SingularityFlowError(
        `Clearing managed Playwright authentication requires --confirm ${inventory.confirmation}.`,
        {
          code: 'MCP_AUTH_CONFIRMATION_REQUIRED',
          details: { serverId: 'playwright', stateFileCount: inventory.states.length }
        }
      );
    }
    await removeRegularPrivateFile(root, activeProfilePath(root));
    for (const state of inventory.states) await removeRegularPrivateFile(root, state.file);
    return {
      status: 'cleared', serverId: 'playwright', removedStateFiles: inventory.states.length
    };
  });
}

/** Bind the managed state only in memory immediately before a Playwright child is launched. */
export async function resolvePlaywrightAuthRuntime(root, entry, {
  platform = process.platform, windowsAcl = secureWindowsAuthAcl
} = {}) {
  const active = await verifiedProfile(root, { platform, windowsAcl });
  if (!active) return { entry, authProfile: null };
  const args = [...(entry?.args ?? [])];
  if (args.includes('--storage-state')) {
    throw new SingularityFlowError(
      'The repository MCP entry declares an unmanaged --storage-state path while a managed profile is active. Remove that argument or remove the managed profile.',
      { code: 'MCP_AUTH_HOST_CONFLICT', details: active.binding }
    );
  }
  return {
    entry: { ...entry, args: [...args, '--storage-state', active.file] },
    authProfile: active.binding
  };
}

export async function currentPlaywrightAuthBinding(root, options = {}) {
  return (await verifiedProfile(root, options))?.binding ?? null;
}
