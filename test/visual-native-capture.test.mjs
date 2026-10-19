/**
 * `visual record`: a simulator, emulator or device screenshot recorded as a native capture.
 *
 * figma-mobile pins only Playwright and Figma tools, so a capture from `xcrun simctl io booted
 * screenshot` or `adb exec-out screencap -p` had no honest record: `mcp record` needs a pinned
 * server and tool. A native capture names its source and device, never an MCP tool; coverage
 * accepts it for a profile only at the profile's exact pixel size. Fixture PNGs stand in for real
 * captures; no simulator runs here.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { verifyMcpEvidence } from '../src/mcp-evidence.mjs';
import { encodePngRgba8, readPngHeader } from '../src/png-rgba8.mjs';
import { evaluateVisualCoverage } from '../src/visual-coverage.mjs';
import { recordNativeVisualCapture } from '../src/visual-native-capture.mjs';

const PHONE = { id: 'phone-390x844', label: 'Phone 390 × 844', width: 390, height: 844, deviceScaleFactor: 1 };
const RETINA = { id: 'phone-390x844-3x', label: 'Phone 390 × 844 @3x', width: 390, height: 844, deviceScaleFactor: 3 };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const itemDirectory = path.join(root, 'singularity/work-items/MOB-2');
  await mkdir(itemDirectory, { recursive: true });
  const workflow = {
    workItem: { id: 'MOB-2', workType: 'figma-mobile' }, status: 'in_progress', currentPhase: 'visual-verification',
    phaseOrder: ['implementation', 'visual-verification'],
    phases: {
      implementation: { id: 'implementation', status: 'approved', generation: 1 },
      'visual-verification': { id: 'visual-verification', status: 'in_progress', generation: 0, requiredArtifact: { kind: 'visual-test-evidence' } }
    },
    resolution: { workItemRoot: 'singularity/work-items', verification: { coverage: 'enforce', profiles: [PHONE, RETINA], comparison: { mode: 'off' } } },
    history: []
  };
  const png = async (name, width, height) => {
    await writeFile(path.join(root, name), encodePngRgba8({ width, height, data: Buffer.alloc(width * height * 4, 200) }));
    return name;
  };
  const record = (values) => recordNativeVisualCapture(root, workflow, {
    phase: 'visual-verification', screenId: 'checkout', stateId: 'default', source: 'simulator', device: 'iPhone 15',
    osVersion: '17.5', actor: { name: 'QA', email: 'qa@example.invalid' }, agent: 'qa', itemDirectory, ...values
  });
  return { root, itemDirectory, workflow, png, record };
}

test('a native capture at the profile\'s pixel size covers it, and is never labelled an MCP tool result', async (t) => {
  const { root, itemDirectory, workflow, png, record } = await fixture(t);
  const phone = await record({ profileId: PHONE.id, file: await png('phone.png', 390, 844) });
  const retina = await record({ profileId: RETINA.id, file: await png('retina.png', 1170, 2532), source: 'emulator', device: 'Pixel 8', osVersion: null });
  const stored = JSON.parse(await readFile(path.join(root, phone.file), 'utf8'));
  assert.deepEqual(stored, phone.record);
  assert.match(phone.file, /^singularity\/work-items\/MOB-2\/context\/visual\/captures\/records\/vnc-[0-9a-f-]{36}\.json$/u);
  assert.equal(stored.kind, 'visual-native-capture');
  assert.equal(stored.evidenceMethod, 'native-capture');
  assert.equal(stored.captureSource, 'declared-by-recorder');
  for (const key of ['server', 'tool', 'hostReference']) assert.equal(Object.hasOwn(stored, key), false, `a native capture has no ${key}`);
  assert.deepEqual(stored.source, { kind: 'simulator', device: 'iPhone 15', osVersion: '17.5' });
  assert.deepEqual(stored.dimensions, { width: 390, height: 844 });
  assert.equal(stored.targetGeneration, 1);
  assert.equal(stored.actor.email, 'qa@example.invalid');
  assert.match(stored.recordedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(stored.output.sha256, stored.outputSha256);
  assert.deepEqual(await readFile(path.join(root, phone.image)), await readFile(path.join(root, 'phone.png')), 'the image is copied into the Story');
  assert.equal(retina.record.source.osVersion, null);

  workflow.phases['visual-verification'].generation = 1;
  const coverage = await evaluateVisualCoverage(root, workflow, { itemDirectory });
  assert.equal(coverage.status, 'pass', JSON.stringify(coverage.errors));
  assert.deepEqual(coverage.covered, [
    { profileId: PHONE.id, recordId: phone.record.id, outputSha256: phone.record.outputSha256, dimensions: { width: 390, height: 844 },
      method: 'native-capture', source: { kind: 'simulator', device: 'iPhone 15', osVersion: '17.5' } },
    { profileId: RETINA.id, recordId: retina.record.id, outputSha256: retina.record.outputSha256, dimensions: { width: 1170, height: 2532 },
      method: 'native-capture', source: { kind: 'emulator', device: 'Pixel 8', osVersion: null } }
  ]);
  // The MCP evidence reader never sees it: it is not an MCP record of any kind.
  assert.deepEqual((await verifyMcpEvidence(root, workflow, { itemDirectory })).records, []);
});

test('a capture whose pixel size differs from the profile is refused naming expected and actual, and nothing is written', async (t) => {
  const { itemDirectory, png, record } = await fixture(t);
  const refused = await record({ profileId: RETINA.id, file: await png('small.png', 390, 844) }).then(() => null, (error) => error);
  assert.equal(refused?.code, 'VISUAL_CAPTURE_DIMENSIONS_MISMATCH');
  assert.deepEqual(refused.details, { phase: 'visual-verification', profileId: RETINA.id, expected: { width: 1170, height: 2532 }, actual: { width: 390, height: 844 } });
  assert.match(refused.message, /small\.png is 390×844 pixels; verification profile 'phone-390x844-3x' \(Phone 390 × 844 @3x\) expects 1170×2532 \(390×844 at device scale 3\)/u);
  assert.deepEqual(await readdir(path.join(itemDirectory, 'context')).catch(() => []), [], 'no record and no copied image');
});

test('a native capture is refused outside an in-progress visual step, for an unknown profile, or when it is not a whole PNG', async (t) => {
  const { workflow, root, png, record } = await fixture(t);
  const file = await png('phone.png', 390, 844);
  await assert.rejects(record({ profileId: 'tablet-834x1194', file }), (error) => error.code === 'VISUAL_CAPTURE_INVALID' && /checks phone-390x844, phone-390x844-3x/u.test(error.message));
  await assert.rejects(record({ profileId: PHONE.id, file, phase: 'implementation' }), { code: 'VISUAL_CAPTURE_INVALID' });
  await assert.rejects(record({ profileId: PHONE.id, file, source: 'mcp' }), (error) => error.code === 'VISUAL_CAPTURE_INVALID' && /simulator, emulator, device/u.test(error.message));
  await assert.rejects(record({ profileId: PHONE.id, file, device: '' }), { code: 'VISUAL_CAPTURE_INVALID' });
  await assert.rejects(record({ profileId: PHONE.id, file, note: 'password: hunter2' }), { code: 'VISUAL_CAPTURE_INVALID' });
  await writeFile(path.join(root, 'fake.png'), 'not a png');
  await assert.rejects(record({ profileId: PHONE.id, file: 'fake.png' }), (error) => error.code === 'VISUAL_CAPTURE_INVALID' && /cannot be read as a PNG/u.test(error.message));
  const whole = await readFile(path.join(root, file));
  await writeFile(path.join(root, 'truncated.png'), whole.subarray(0, whole.length - 20));
  await assert.rejects(record({ profileId: PHONE.id, file: 'truncated.png' }), (error) => /truncated/u.test(error.message));
  await writeFile(path.join(root, 'phone.jpg'), whole);
  await assert.rejects(record({ profileId: PHONE.id, file: 'phone.jpg' }), (error) => /must be a PNG file/u.test(error.message));
  workflow.phases['visual-verification'].status = 'submitted';
  await assert.rejects(record({ profileId: PHONE.id, file }), { code: 'VISUAL_CAPTURE_PHASE_CLOSED' });
});

test('the PNG header answers for any bit depth without decoding', () => {
  const png = Buffer.from(encodePngRgba8({ width: 3, height: 2, data: Buffer.alloc(24, 1) }));
  png[24] = 16; // IHDR bit depth: a 16-bit device capture is not decodable here, but its size is known.
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  assert.deepEqual(readPngHeader(png), { width: 3, height: 2 });
  const corrupt = Buffer.from(png); corrupt[17] ^= 1;
  assert.throws(() => readPngHeader(corrupt), /IHDR is invalid/u);
});

test('coverage refuses a native capture whose bytes or recorded size changed after recording', async (t) => {
  const { root, itemDirectory, workflow, png, record } = await fixture(t);
  const phone = await record({ profileId: PHONE.id, file: await png('phone.png', 390, 844) });
  const retina = await record({ profileId: RETINA.id, file: await png('retina.png', 1170, 2532) });
  workflow.phases['visual-verification'].generation = 1;
  // The phone's image is replaced; the retina record is edited to claim another size.
  await writeFile(path.join(root, phone.image), encodePngRgba8({ width: 390, height: 844, data: Buffer.alloc(390 * 844 * 4, 0) }));
  const edited = { ...retina.record, dimensions: { width: 390, height: 844 } };
  await writeFile(path.join(root, retina.file), `${JSON.stringify(edited, null, 2)}\n`);
  const coverage = await evaluateVisualCoverage(root, workflow, { itemDirectory });
  assert.equal(coverage.status, 'fail');
  assert.deepEqual(coverage.covered, []);
  assert.deepEqual(coverage.uncovered, [PHONE.id, RETINA.id]);
  assert.ok(coverage.errors.some((entry) => entry.includes(`Native capture '${phone.record.id}' output changed after capture`)), coverage.errors.join('\n'));
  assert.ok(coverage.errors.some((entry) => entry.includes(`Native capture '${retina.record.id}' records 390×844 but its PNG is 1170×2532`)), coverage.errors.join('\n'));
});

test('coverage refuses a native capture at another size with a coded error naming expected and actual', async (t) => {
  const { root, itemDirectory, workflow, png, record } = await fixture(t);
  const phone = await record({ profileId: PHONE.id, file: await png('phone.png', 390, 844) });
  workflow.phases['visual-verification'].generation = 1;
  // The workflow's profile changes after the capture (a refreshed configuration): the capture no longer fits.
  workflow.resolution.verification.profiles = [{ ...PHONE, deviceScaleFactor: 2 }, RETINA];
  const coverage = await evaluateVisualCoverage(root, workflow, { itemDirectory });
  assert.ok(coverage.errors.includes(`[VISUAL_CAPTURE_DIMENSIONS_MISMATCH] Native capture '${phone.record.id}' is 390×844; profile '${PHONE.id}' expects 780×1688.`), coverage.errors.join('\n'));
  assert.ok(coverage.uncovered.includes(PHONE.id));
  assert.ok(!coverage.covered.some((entry) => entry.profileId === PHONE.id));
});
