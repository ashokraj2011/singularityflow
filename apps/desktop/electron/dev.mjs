import electron from 'electron';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { desktopDevServerOptions, listeningDesktopPort } from './dev-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const serverOptions = desktopDevServerOptions();
const server = await createServer({ root, server: serverOptions });
await server.listen();
const port = listeningDesktopPort(server, serverOptions.port);
if (port !== serverOptions.port) {
  console.log(`Desktop port ${serverOptions.port} is already in use; continuing on http://${serverOptions.host}:${port}.`);
}
const child = spawn(electron, ['.'], {
  cwd: root,
  env: { ...process.env, VITE_DEV_SERVER_URL: `http://${serverOptions.host}:${port}` },
  stdio: 'inherit'
});
const close = async () => { await server.close(); };
child.on('exit', async (code) => { await close(); process.exitCode = code ?? 0; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
