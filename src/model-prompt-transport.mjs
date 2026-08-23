import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { SingularityFlowError } from './util.mjs';

export const DEFAULT_MODEL_PROMPT_MAXIMUM_BYTES = 8 * 1024 * 1024;

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function promptBytes(prompt) {
  if (!prompt || (typeof prompt.text === 'string') === Boolean(prompt.file)) {
    throw new SingularityFlowError('Model request requires exactly one of prompt.text or prompt.file.', {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  if (typeof prompt.text === 'string') return Promise.resolve(Buffer.from(prompt.text, 'utf8'));
  return lstat(prompt.file).then(async (info) => {
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SingularityFlowError('Model prompt file must be a regular non-symbolic file.', {
        code: 'MODEL_REQUEST_INVALID'
      });
    }
    const bytes = await readFile(prompt.file);
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch {
      throw new SingularityFlowError('Model prompt file is not valid UTF-8.', {
        code: 'MODEL_PROMPT_ENCODING_INVALID'
      });
    }
    return bytes;
  });
}

/**
 * Snapshot a public model prompt into a private, single-owner attachment.
 *
 * The source is read exactly once. The returned digest and byte count therefore describe the same
 * immutable bytes the provider receives, even if a caller-owned source file changes afterwards.
 */
export async function stageModelPrompt(prompt, {
  maximumBytes = DEFAULT_MODEL_PROMPT_MAXIMUM_BYTES,
  tempRoot = os.tmpdir()
} = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new SingularityFlowError('Model prompt byte limit must be a positive integer.', {
      code: 'MODEL_REQUEST_INVALID'
    });
  }
  let bytes;
  try { bytes = await promptBytes(prompt); }
  catch (error) {
    if (['MODEL_REQUEST_INVALID', 'MODEL_PROMPT_ENCODING_INVALID'].includes(error?.code)) throw error;
    throw new SingularityFlowError('Unable to read the model prompt for private staging.', {
      code: 'MODEL_PROMPT_STAGE_FAILED', cause: error,
      details: { nativeCode: error?.code ?? null }
    });
  }
  if (bytes.length > maximumBytes) {
    throw new SingularityFlowError(`Model prompt exceeds the ${maximumBytes}-byte input policy.`, {
      code: 'MODEL_PROMPT_LIMIT', details: { promptBytes: bytes.length, maximumBytes }
    });
  }

  let directory = null;
  try {
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(path.join(tempRoot, `sflow-model-${randomUUID()}-`));
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    const file = path.join(directory, 'request.md');
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(bytes); }
    finally { await handle.close(); }
    if (process.platform !== 'win32') await chmod(file, 0o600);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SingularityFlowError('Staged model prompt is not a regular private file.', {
        code: 'MODEL_PROMPT_STAGE_FAILED'
      });
    }
    let cleaned = false;
    return Object.freeze({
      file,
      directory,
      sha256: sha256(bytes),
      bytes: bytes.length,
      encoding: 'utf-8',
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(directory, { recursive: true, force: true });
      }
    });
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error?.code === 'MODEL_PROMPT_STAGE_FAILED') throw error;
    throw new SingularityFlowError('Unable to create the private model prompt attachment.', {
      code: 'MODEL_PROMPT_STAGE_FAILED', cause: error,
      details: { nativeCode: error?.code ?? null }
    });
  }
}
