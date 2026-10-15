/** Synthetic local qualification only: no model, real Story, approval or remote publication. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { discoverAgents } from './agents.mjs';
import { runCopilotHookBenchmark } from './copilot-hook-benchmark.mjs';
import { summarizeSamples } from './dx-performance.mjs';
import { withCommandTiming } from './dx-timing-context.mjs';
import { instructionText, loadInstructionLibrary } from './instruction-library.mjs';
import { canonicalJson } from './records.mjs';
import { withReadScope, withoutReadScope } from './read-scope.mjs';
import { librarySkillText, loadSkillLibrary } from './skill-library.mjs';

export function qualificationSamples(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300) throw new Error('Qualification samples must be an integer from 1 to 300.');
  return value;
}

const digest = text => createHash('sha256').update(text).digest('hex');
const catalogIdentity = ([agents, skills, instructions]) => ({
  agents: agents.map(({ id, sha256 }) => ({ id, sha256 })),
  skills: [...skills.skills.values()].map(({ id, sha256 }) => ({ id, sha256 })),
  instructions: [...instructions.instructions.values()].map(({ id, sha256 }) => ({ id, sha256 })),
  problems: [...skills.problems, ...instructions.problems]
});

async function catalogProbe(directory, samples) {
  const root = path.join(directory, 'catalog');
  for (let index = 0; index < 10; index++) {
    for (const [relative, text] of [
      [`singularity/skill-library/probe-${index}/SKILL.md`, librarySkillText({ id: `probe-${index}`, description: 'Inspect synthetic code.', instructions: 'Inspect the synthetic fixture only.' })],
      [`singularity/instruction-library/probe-${index}/INSTRUCTIONS.md`, instructionText({ id: `probe-${index}`, description: 'Synthetic standards.', instructions: 'Use clear fixture names.' })]
    ]) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text);
    }
  }
  const read = () => Promise.all([discoverAgents(root), loadSkillLibrary(root), loadInstructionLibrary(root)]);
  const probe = async scoped => {
    const counters = {};
    const timer = { increment(name, amount) { counters[name] = (counters[name] ?? 0) + amount; } };
    const started = performance.now();
    const results = await withCommandTiming(timer, () => (scoped ? withReadScope : withoutReadScope)(async () => {
      const first = await read(); const second = await read();
      return [first, second];
    }));
    const durationMs = performance.now() - started;
    const identities = results.map(value => digest(canonicalJson(catalogIdentity(value))));
    if (identities[0] !== identities[1]) throw new Error('Catalog reuse changed the observed catalog.');
    return { durationMs, counters, identity: identities[0] };
  };
  const baseline = [], reused = [];
  let previous, current;
  for (let index = 0; index < samples + 5; index++) {
    if (index % 2) { current = await probe(true); previous = await probe(false); }
    else { previous = await probe(false); current = await probe(true); }
    if (previous.identity !== current.identity) throw new Error('Scoped and fresh catalog identities differ.');
    if (index >= 5) { baseline.push(previous.durationMs); reused.push(current.durationMs); }
  }
  return { scope: 'in-process repeated read-only catalogs, OS-warm', fixtureSha256: current.identity,
    baseline: { ...summarizeSamples(baseline), counters: previous.counters },
    reused: { ...summarizeSamples(reused), counters: current.counters }, identityPreserved: true };
}

function serializationProbe(samples) {
  const record = { kind: 'synthetic-claim-map', workId: 'QUALIFICATION', generation: 1,
    claims: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`QUAL:REQ-${index}`, {
      verdict: 'matched', expectedPaths: [`src/module-${index}.js`], observedPaths: [`src/module-${index}.js`],
      evidence: { sha256: digest(String(index)), bytes: index + 1 }, tests: [`test/module-${index}.test.js`]
    }])) };
  const canonical = canonicalJson(record);
  const expected = digest(canonical);
  if (canonicalJson(JSON.parse(canonical)) !== canonical) throw new Error('Canonical serialization did not reproduce its exact bytes.');
  const times = [], hashTimes = [];
  for (let index = 0; index < samples + 5; index++) {
    let started = performance.now(); const text = canonicalJson(record); const elapsed = performance.now() - started;
    started = performance.now(); const hash = digest(text); const hashElapsed = performance.now() - started;
    if (hash !== expected) throw new Error('Canonical record identity changed during the probe.');
    if (index >= 5) { times.push(elapsed); hashTimes.push(hashElapsed); }
  }
  return { scope: 'in-process synthetic 1000-clause record, not production attribution', bytes: Buffer.byteLength(canonical),
    sha256: expected, byteEquivalent: true, serialization: summarizeSamples(times), hashing: summarizeSamples(hashTimes),
    decision: 'Keep the durable canonical format unchanged. Optimize a serializer only after a real command profile attributes a material bottleneck to it.' };
}

export async function qualifyNativeEfficiency({ samples = 30, hooks = true } = {}) {
  qualificationSamples(samples);
  if (typeof hooks !== 'boolean') throw new Error('hooks must be a boolean.');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-qualification-'));
  try {
    const catalogs = await catalogProbe(directory, samples);
    const serialization = serializationProbe(samples);
    const hookReport = hooks ? await runCopilotHookBenchmark({ samples }) : null;
    return { schemaVersion: 1, resultType: 'native-efficiency-local-qualification', // schema-transient: benchmark observation, never retained lifecycle authority
      platform: process.platform, arch: process.arch, node: process.version, sampleCount: samples,
      recommendedSampleCountMet: samples >= 30, catalogs, serialization, hooks: hookReport,
      decisions: {
        warmService: { enabled: false, qualification: 'native-host-evidence-required',
          reason: 'Synthetic source startup is not enough to justify a privileged warm service. Measure installed native-host residual startup separately.' },
        parallelQualityChecks: { enabled: false, qualification: 'explicit-independence-policy-required',
          reason: 'No independent/resource contract was approved; preserve sequential tests. Different working directories alone do not prove independence.' }
      },
      externalQualification: { complete: false, required: ['complete native Copilot Story before/after traces',
        'native Windows installed-build measurements', 'native macOS installed-build measurements'], billedSavings: null },
      limitations: ['Synthetic local measurements are not complete Story, native host, Windows or billed-token evidence.',
        'This command invokes no model, real Story lifecycle or remote publication. Conditional mechanisms remain disabled rather than weakening gates.'] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
