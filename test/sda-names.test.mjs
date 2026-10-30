/**
 * SDA-AC-023: no SDA command, refusal code, setting or path reuses a name with another meaning.
 *
 * Each name SDA introduced is listed with the modules that own it. The test fails when another module
 * uses the name (one meaning per name), when a listed name is no longer used by its owners, when the
 * command registry gives `index` another module or an alias, or when an SDA name becomes a machine
 * location or a configuration key (Phase A adds none, SDA §8).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_REGISTRY, REMOVED_COMMANDS, canonicalCommand, commandDefinition } from '../src/command-registry.mjs';
import { MACHINE_STATE_LOCATIONS } from '../scripts/test-machine-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Name → the modules (under src/ or scripts/) that may use it.
export const SDA_NAMES = Object.freeze({
  // M1 refusal codes and outcome classes
  LEDGER_EVENT_PAYLOAD_CONFLICT: ['src/ledger.mjs', 'src/outcome-classes.mjs'],
  TRANSPORT_OPERATION_ID_REUSED: ['src/outcome-classes.mjs', 'src/transport-intents.mjs'],
  TRANSPORT_OPERATION_ID_INVALID: ['src/transport-intents.mjs'],
  PUSH_EXPECTED_REVISION_REQUIRED: ['src/git.mjs', 'src/publication-unit-of-work.mjs'],
  LEDGER_PAGE_LIMIT_INVALID: ['src/ledger-pages.mjs', 'src/sda/shared-state-contract.mjs'],
  LEDGER_CONTINUATION_INVALID: ['src/ledger-pages.mjs', 'src/sda/shared-state-contract.mjs'],
  LEDGER_CONTINUATION_UNAVAILABLE: ['src/ledger-pages.mjs', 'src/sda/shared-state-contract.mjs'],
  SDA_OPERATION_CANCELLED: ['src/sda/shared-state-contract.mjs'],
  SDA_ADAPTER_NOT_PRODUCTION: ['src/sda/shared-state-contract.mjs'],
  SDA_ADAPTER_CONTRACT_MISMATCH: ['src/sda/shared-state-contract.mjs'],
  SDA_ADAPTER_CAPABILITY_UNSUPPORTED: ['src/sda/shared-state-contract.mjs'],
  // M2: the read index
  INDEX_COMMAND_INVALID: ['src/commands/read-index.mjs'],
  SINGULARITY_FLOW_INDEX_REFRESH: ['src/index-refresh-launcher.mjs', 'src/projection-refresh.mjs', 'src/repository-check-cache.mjs', 'scripts/test-machine-state.mjs'],
  'sflow-index-': ['src/commands/read-index.mjs', 'src/help-pages.mjs', 'src/narration/migration-status.mjs'],
  'refresh.json': ['src/repository-check-cache.mjs'],
  // M2: identity (SDA §5)
  STORY_BRANCH_BINDING_MISMATCH: ['src/session-remote-url-discovery.mjs'],
  'local-repository-id': ['src/repository-local-id.mjs'],
  INITIATIVE_IDENTITY_UNRECORDED: ['src/subject-identity-records.mjs'],
  INITIATIVE_IDENTITY_AMBIGUOUS: ['src/subject-identity-records.mjs'],
  'branch-scan-ledger-off': ['src/subject-identity-records.mjs'],
  LOCAL_EPIC_RESERVATION_AMBIGUOUS: ['src/local-identity.mjs'],
  AUTO_STORY_BRANCH_UNSUPPORTED: ['src/change-flight-plan.mjs'],
  // M2: canonical finding IDs
  'FND-[': ['src/finding-identity.mjs', 'src/phase-finding-dispute.mjs'],
  'code.delivery.generation-unchanged': ['src/delivery-evidence.mjs'],
  // M2: configuration inspection without a clone
  INSPECTION_READ: ['src/approved-configuration-reader.mjs', 'src/cli.mjs', 'src/editor.mjs', 'src/commands/workflow-list.mjs'],
  'configuration.exact-object-transfer': ['src/configuration-branch.mjs']
});

async function sources(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await sources(absolute, output);
    else if (entry.name.endsWith('.mjs')) output.push(absolute);
  }
  return output;
}

test('each SDA name is used only by the modules that own it, and every owner still uses it (SDA-AC-023)', async () => {
  const files = [...await sources(path.join(root, 'src')), ...await sources(path.join(root, 'scripts'))];
  const texts = new Map(await Promise.all(files.map(async (file) => [path.relative(root, file).split(path.sep).join('/'), await readFile(file, 'utf8')])));
  for (const [name, owners] of Object.entries(SDA_NAMES)) {
    const users = [...texts].filter(([, text]) => text.includes(name)).map(([file]) => file).sort();
    assert.deepEqual(users, [...owners].sort(), `${name}: one meaning, used by its owners only`);
  }
});

test('index is one command with its own module, no alias and no removed meaning', () => {
  const entries = COMMAND_REGISTRY.filter((entry) => entry.name === 'index' || entry.aliases.includes('index'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'index');
  assert.deepEqual(entries[0].aliases, []);
  assert.equal(canonicalCommand('index'), 'index');
  assert.equal(commandDefinition('index').modulePath, './commands/read-index.mjs');
  assert.equal(commandDefinition('index').classification, 'read');
  assert.ok(!Object.hasOwn(REMOVED_COMMANDS, 'index'));
});

test('SDA adds no machine location and no configuration key in Phase A', async () => {
  // The refresh flag switches behaviour and never names a place; the index's records live where the
  // repository-check preferences and each checkout's private cache already are.
  for (const name of Object.keys(SDA_NAMES)) assert.ok(!Object.hasOwn(MACHINE_STATE_LOCATIONS, name), name);
  const config = await readFile(path.join(root, 'src/config.mjs'), 'utf8');
  assert.doesNotMatch(config, /definition\??\.(?:index|readIndex|lifecycleStorage)\b/u,
    'a governed storage key is Phase B, introduced with a minimumBuild raise (SDA §8)');
});
