/** Native child-process crash/failure probes. Never included in a distribution. */
import * as filesystem from 'node:fs/promises';
import path from 'node:path';

const request = JSON.parse(process.argv[2]);
if (request.fault) {
  const { mock } = await import('node:test');
  const { default: _default, ...namedExports } = filesystem;
  let linked = false;
  namedExports.link = async (from, to) => {
    const commit = path.basename(path.dirname(to)) === 'commits';
    if (commit && request.fault === 'before-link') process.kill(process.pid, 'SIGKILL');
    if (commit && request.fault === 'refused-link') throw Object.assign(new Error('fixture link denied'), { code: 'EACCES' });
    const result = await filesystem.link(from, to);
    if (commit) linked = true;
    if (commit && request.fault === 'lost-link-response') throw Object.assign(new Error('fixture response timed out'), { code: 'ETIMEDOUT' });
    if (commit && request.fault === 'after-link') process.kill(process.pid, 'SIGKILL');
    return result;
  };
  namedExports.open = async (file, ...args) => {
    if (request.fault === 'deny-read' && path.basename(path.dirname(file)) === 'commits') {
      throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    }
    const handle = await filesystem.open(file, ...args);
    if (request.fault !== 'directory-sync' || !linked || path.basename(file) !== 'commits') return handle;
    return new Proxy(handle, { get(target, key) {
      if (key === 'sync') return async () => { throw Object.assign(new Error('fixture directory flush failed'), { code: 'EIO' }); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  mock.module('node:fs/promises', { namedExports });
}
const { createFilesystemNamespaceStore } = await import('../../src/sda/filesystem-namespace-adapter.mjs');
try {
  const adapter = await createFilesystemNamespaceStore({ root: request.root, binding: { kind: 'shared' } });
  const result = request.read
    ? await adapter.read(request.scope, 'state', request.read)
    : await adapter.transact(request.scope, request.transaction);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, causeCode: error.cause?.code ?? null, details: error.details }));
}
