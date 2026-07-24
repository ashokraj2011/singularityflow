import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const mutationTails = new Map();

export async function withLocalStoreMutation(file, operation) {
  const key = path.resolve(file);
  const previous = mutationTails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  mutationTails.set(key, current);
  try {
    return await current;
  } finally {
    if (mutationTails.get(key) === current) mutationTails.delete(key);
  }
}

export async function atomicPrivateWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => {});
    await rename(temporary, file);
    await chmod(file, 0o600).catch(() => {});
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function atomicPrivateJson(file, value) {
  return atomicPrivateWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}
