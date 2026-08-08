import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowedCopilotLaunchers = new Set([
  'src/model-providers/copilot-cli.mjs',
  'src/host-session-launcher.mjs',
  // Plugin management invokes `copilot plugin`, not a model.
  'src/plugin.mjs'
]);

async function sourceFiles(directory = path.join(root, 'src')) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [path.relative(root, absolute)] : [];
  }));
  return nested.flat();
}

const failures = [];
for (const file of await sourceFiles()) {
  const text = await readFile(path.join(root, file), 'utf8');
  if (!allowedCopilotLaunchers.has(file)
    && /(?:spawn|spawnSync|execFile|execFileSync|run|execute)\s*\([^\n]{0,100}['"`]copilot(?:\.cmd)?['"`]/.test(text)) {
    failures.push(`${file}: starts Copilot outside the registered model/host boundary`);
  }
  if (file !== 'src/model-provider-registry.mjs' && /from\s+['"`]\.\/model-providers\//.test(text)) {
    failures.push(`${file}: imports a model provider directly instead of using model-runner.mjs`);
  }
  if (file !== 'src/model-runner.mjs' && /from\s+['"`]\.\/model-provider-registry\.mjs['"`]/.test(text)) {
    failures.push(`${file}: imports the provider registry directly instead of using model-runner.mjs`);
  }
}

if (failures.length) {
  console.error(`Model-boundary audit failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Model-boundary audit passed.');
}
