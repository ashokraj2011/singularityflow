import electron from 'electron';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number.parseInt(process.env.SINGULARITY_FLOW_DESKTOP_PORT ?? '5173', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SINGULARITY_FLOW_DESKTOP_PORT must be a valid TCP port.');
const server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true } });
await server.listen();
const child = spawn(electron, ['.'], {
  cwd: root,
  env: { ...process.env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${port}` },
  stdio: 'inherit'
});
const close = async () => { await server.close(); };
child.on('exit', async (code) => { await close(); process.exitCode = code ?? 0; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
