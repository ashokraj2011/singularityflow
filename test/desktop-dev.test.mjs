import assert from 'node:assert/strict';
import test from 'node:test';
import {
  desktopDevServerOptions,
  listeningDesktopPort
} from '../apps/desktop/electron/dev-server.mjs';

test('desktop development uses the preferred port but may recover when it is occupied', () => {
  assert.deepEqual(desktopDevServerOptions({}), {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false
  });
  assert.equal(listeningDesktopPort({
    httpServer: { address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 5174 }) }
  }, 5173), 5174);
});

test('an explicitly configured desktop port remains strict and validated', () => {
  assert.deepEqual(desktopDevServerOptions({ SINGULARITY_FLOW_DESKTOP_PORT: '6200' }), {
    host: '127.0.0.1',
    port: 6200,
    strictPort: true
  });
  assert.throws(
    () => desktopDevServerOptions({ SINGULARITY_FLOW_DESKTOP_PORT: 'not-a-port' }),
    /must be a valid TCP port/
  );
  assert.throws(
    () => desktopDevServerOptions({ SINGULARITY_FLOW_DESKTOP_PORT: '70000' }),
    /must be a valid TCP port/
  );
});
