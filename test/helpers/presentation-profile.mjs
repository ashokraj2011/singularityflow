/**
 * A presentation profile of the test file's own, empty, so the Git identity decides the greeting.
 *
 * The local presentation profile outranks the Git name (src/personalization.mjs, 311c5b5a). VS Code
 * mirrors its profile name into ~/.singularity-flow/presentation-profile.json, so under a plain
 * `node --test` a developer's own name reached results that the test expected to carry its fixture
 * identity, while the suite runner, which gives the run a home of its own, passed. This points the
 * profile at an empty folder for the whole file, in this process and every child given process.env,
 * and drops an exported SINGULARITY_FLOW_REPLY_NAME, which outranks the file.
 *
 *   isolatePresentationProfile();
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

export function isolatePresentationProfile() {
  const directory = mkdtempSync(path.join(tmpdir(), 'sflow-presentation-profile-'));
  after(() => rmSync(directory, { recursive: true, force: true }));
  process.env.SINGULARITY_FLOW_PRESENTATION_PROFILE_FILE = path.join(directory, 'presentation-profile.json');
  delete process.env.SINGULARITY_FLOW_REPLY_NAME;
}
