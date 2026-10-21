import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolveWindowsSystemTool } from '../src/platform-process.mjs';
import { withCreationContext } from '../src/creation-context.mjs';
import { secureWindowsAuthAcl, verifyWindowsPrivateDirectories } from '../src/mcp-auth-profile.mjs';

const environment = { SystemRoot: 'C:\\Windows' }, sid = 'S-1-5-21-123';
test('SID shares within one request but every bounded directory batch checks fresh ACLs', async () => {
  let identity = 0, shells = 0, unsafe = false;
  const execute = async (exe, args) => {
    if (/whoami/iu.test(exe)) { identity++; return { stdout: sid }; }
    shells++;
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /Get-Acl -LiteralPath/);
    assert.match(script, /ReparsePoint/);
    assert.doesNotMatch(script, /Set-Acl/);
    return { stdout: JSON.stringify({ entries: 2, unsafe: unsafe ? 1 : 0 }) };
  };
  const options = { environment, execFileCommand: execute };
  await withCreationContext(async () => {
    await verifyWindowsPrivateDirectories(['C:\\store\\a', "C:\\store\\b'c"], options);
    unsafe = true;
    await assert.rejects(verifyWindowsPrivateDirectories(['C:\\store\\a', 'C:\\store\\b'], options), { code: 'MCP_AUTH_WINDOWS_ACL_UNSAFE' });
  });
  assert.equal(identity, 1); assert.equal(shells, 2);
  unsafe = false;
  await withCreationContext(() => verifyWindowsPrivateDirectories(['C:\\store\\a', 'C:\\store\\b'], options));
  assert.equal(identity, 2, 'principal is not retained across requests');
});

test('native private-directory proof remains valid on each host and refuses widened Windows ACLs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-acl-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targets = [path.join(root, 'one'), path.join(root, 'two')];
  for (const target of targets) await mkdir(target, { mode: 0o700 });
  if (process.platform === 'win32') {
    await withCreationContext(async () => {
      for (const target of targets) await secureWindowsAuthAcl(target, { directory: true });
      await verifyWindowsPrivateDirectories(targets);
      const system = path.win32.dirname(resolveWindowsSystemTool(process.env, 'cmd.exe'));
      const shell = path.win32.join(system, 'WindowsPowerShell/v1.0/powershell.exe');
      const literal = "'" + targets[0].replaceAll("'", "''") + "'";
      const script = `$env:PSModulePath=$PSHOME+'\\Modules';$ErrorActionPreference='Stop';$acl=Get-Acl -LiteralPath ${literal};$acl.SetAccessRuleProtection($false,$true);Set-Acl -LiteralPath ${literal} -AclObject $acl`;
      execFileSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
      await assert.rejects(verifyWindowsPrivateDirectories(targets), { code: 'MCP_AUTH_WINDOWS_ACL_UNSAFE' });
    });
  } else {
    // Fake executors above test the protocol on every OS; native Windows runs exercise Get-Acl.
    await assert.rejects(verifyWindowsPrivateDirectories(targets, { environment }), { code: 'MCP_AUTH_WINDOWS_ACL_FAILED' });
  }
});
