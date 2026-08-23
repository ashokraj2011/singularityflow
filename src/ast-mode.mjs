import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError, writeJson } from './util.mjs';

const AST_PREFERENCE_SCHEMA_VERSION = currentSchemaVersion('ast-preference');

function preferencePath() {
  return process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE
    ? path.resolve(process.env.SINGULARITY_FLOW_AST_PREFERENCE_FILE)
    : path.join(os.homedir(), '.singularity-flow', 'ast-preference.json');
}

export async function readAstPreference() {
  try {
    const value = readRecord('ast-preference', await readFile(preferencePath())).record;
    if (!['auto', 'off'].includes(value.mode)) throw new Error('unsupported preference');
    return { schemaVersion: AST_PREFERENCE_SCHEMA_VERSION, mode: value.mode, path: preferencePath(), exists: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: AST_PREFERENCE_SCHEMA_VERSION, mode: 'auto', path: preferencePath(), exists: false };
    if (error instanceof SingularityFlowError) throw error;
    throw new SingularityFlowError(`AST preference is invalid at ${preferencePath()}. Remove it or run 'wm ast preference set auto'.`);
  }
}

export async function setAstPreference(mode) {
  if (!['auto', 'off'].includes(mode)) throw new SingularityFlowError('AST preference must be auto or off.');
  const value = { schemaVersion: AST_PREFERENCE_SCHEMA_VERSION, mode, updatedAt: new Date().toISOString() };
  await writeJson(preferencePath(), value);
  return { ...value, path: preferencePath() };
}

function environmentMode() {
  const value = String(process.env.SINGULARITY_FLOW_AST ?? 'auto').trim().toLowerCase();
  if (!['auto', 'off'].includes(value)) throw new SingularityFlowError('SINGULARITY_FLOW_AST must be auto or off.');
  return value;
}

/** The most restrictive repository, machine, environment, or operation switch wins. */
export async function effectiveAstMode(policy, operationMode = 'auto') {
  if (!['auto', 'off'].includes(operationMode)) throw new SingularityFlowError('AST operation mode must be auto or off.');
  const local = await readAstPreference();
  const sources = { repository: policy.mode, local: local.mode, environment: environmentMode(), operation: operationMode };
  return { mode: Object.values(sources).includes('off') ? 'off' : 'auto', sources };
}
