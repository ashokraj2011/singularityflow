/**
 * The one way the CLI runs src/story-invariants.mjs: only while a test run collects what they find
 * (SINGULARITY_FLOW_INVARIANTS names its log, scripts/test-machine-state.mjs), and only from the sources. Every hook tests
 * the bundles' markers (globalThis.__SFLOW_CLI_BUNDLE__, __SFLOW_EXTENSION_HOST__) before it imports this, so a bundler
 * drops the hook and nothing of it ships. A check never changes what a command does, prints or returns, and one that
 * cannot run says nothing.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from './package-root.mjs';

export async function withStoryInvariants(check) {
  if (!process.env.SINGULARITY_FLOW_INVARIANTS) return;
  try { await check(await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'story-invariants.mjs')).href)); } catch { /* never the command's concern */ }
}
