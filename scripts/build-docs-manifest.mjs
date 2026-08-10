#!/usr/bin/env node
/**
 * Stamp the docs manifest `[DOC:REQ-004]`.
 *
 * The manifest is committed rather than generated at install time, for two reasons. A global
 * install has no git and no build step, so a manifest computed on the fly could only ever agree
 * with itself — it would say the documentation is fine no matter what shipped. And committing it
 * turns an unannounced edit to a topic into a visible diff plus a failing gate, which is what
 * `[DOC:REQ-001]`'s "versions bump with content" needs in order to mean anything.
 *
 * Run this after editing any topic:  node scripts/build-docs-manifest.mjs
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildManifest, loadTopics } from '../src/docs-topics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceCommit() {
  // A tarball has no git. That is a fact about the build, not a failure of it, so it is recorded as
  // null rather than guessed at.
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const topics = await loadTopics();
const manifest = buildManifest(topics, { sourceCommit: sourceCommit() });
const destination = path.join(root, 'src', 'docs-manifest.json');
await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, destination)}: ${manifest.topicCount} topics, content ${manifest.contentSha256.slice(0, 12)}.`);
