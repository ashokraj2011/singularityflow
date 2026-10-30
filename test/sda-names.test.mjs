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
  SDA_OPERATION_CANCELLED: ['src/sda/lifecycle-authority-contract.mjs', 'src/sda/shared-state-contract.mjs'],
  SDA_ADAPTER_NOT_PRODUCTION: ['src/sda/shared-state-contract.mjs'],
  SDA_ADAPTER_CONTRACT_MISMATCH: ['src/sda/shared-state-contract.mjs'],
  SDA_ADAPTER_CAPABILITY_UNSUPPORTED: ['src/sda/lifecycle-authority-contract.mjs', 'src/sda/shared-state-contract.mjs'],
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
  'configuration.exact-object-transfer': ['src/configuration-branch.mjs'],
  // M3: configuration editing without a clone, with its typed intent
  CONFIGURATION_PROJECTION_BASE_UNAVAILABLE: ['src/configuration-projection.mjs'],
  'configuration-projection/base': ['src/configuration-projection.mjs'],
  CONFIGURATION_PROPOSAL_INTENT_INVALID: ['src/configuration-proposal.mjs'],
  'Sflow-Intent-Kind': ['src/configuration-people.mjs', 'src/configuration-proposal.mjs'],
  'configuration.proposal-projection': ['src/configuration-proposal.mjs'],
  // M3: transactional drafts
  CONFIGURATION_DRAFT_OPERATION_REUSED: ['src/configuration-drafts.mjs', 'src/outcome-classes.mjs'],
  CONFIGURATION_DRAFTS_CHANGED: ['src/configuration-drafts.mjs', 'src/outcome-classes.mjs'],
  CONFIGURATION_DRAFT_OPERATION_INVALID: ['src/configuration-drafts.mjs'],
  SINGULARITY_FLOW_TEST_CRASH_AT: ['src/configuration-drafts.mjs'],
  'sflow-configuration-draft@2': ['src/configuration-drafts.mjs'],
  // M3: lease-proven lock recovery
  SINGULARITY_FLOW_MACHINE_ID_FILE: ['scripts/test-machine-state.mjs', 'src/lease-liveness.mjs'],
  SUBJECT_LOCK_RELEASE_: ['src/subject-lock.mjs'],
  WORKSPACE_REGISTRY_RELEASE_: ['src/file-lease.mjs'],
  SGOS_AUTHORITY_LOCK_RELEASE_: ['src/sgos/platform/authority-store.mjs'],
  'released-leases.jsonl': ['src/subject-lock.mjs'],
  LOCK_COMMAND_INVALID: ['src/commands/lock.mjs'],
  'sflow-lock-': ['src/commands/lock.mjs', 'src/help-pages.mjs', 'src/narration/migration-status.mjs'],
  "'lock-release'": ['src/command-skills.mjs'],
  // M3: capability activation and edits with no textual merge
  CAPABILITY_PROPOSAL_VALUE_CONFLICT: ['src/capability-value-replay.mjs'],
  CAPABILITY_CONFIGURATION_OBJECTS_UNAVAILABLE: ['src/git-configuration-objects.mjs'],
  // M3: lazy workspace cloning
  ACTIVE_WORKSPACE_REPOSITORY_DEFERRED: ['src/workspace-story-checkout.mjs'],
  GOAL_REPOSITORY_DEFERRED: ['src/commands/goal.mjs'],
  ENV_FILES_REPOSITORY_DEFERRED: ['src/environment-files.mjs'],
  // M4: the subject branch behind the lifecycle authority adapter
  'sda-lifecycle-authority/': ['src/sda/lifecycle-authority-contract.mjs'],
  'exact-observation': ['src/sda/lifecycle-authority-contract.mjs'],
  'conditional-transition': ['src/sda/lifecycle-authority-contract.mjs'],
  "'pending-recovery'": ['src/sda/lifecycle-authority-contract.mjs'],
  "'retained-locally'": ['src/sda/lifecycle-authority-contract.mjs'],
  "'subject-branch'": ['src/sda/story-branch-authority.mjs'],
  // An existing code, now also thrown by the unit of work, with its one meaning: a retained transition.
  "'PUBLICATION_PENDING'": ['src/publication-unit-of-work.mjs', 'src/state-planes.mjs']
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

test('lock is one command with its own module, no alias and no removed meaning', () => {
  const entries = COMMAND_REGISTRY.filter((entry) => entry.name === 'lock' || entry.aliases.includes('lock'));
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].aliases, []);
  assert.equal(commandDefinition('lock').modulePath, './commands/lock.mjs');
  assert.ok(!Object.hasOwn(REMOVED_COMMANDS, 'lock'));
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

// The machine locations SDA added, each registered so a test never touches the developer's own.
const SDA_MACHINE_LOCATIONS = Object.freeze(['SINGULARITY_FLOW_MACHINE_ID_FILE']);

test('SDA adds only its listed machine locations and no configuration key', async () => {
  // The refresh flag switches behaviour and never names a place; the index's records live where the
  // repository-check preferences and each checkout's private cache already are. M3's lease identity
  // (src/lease-liveness.mjs) is the one new place, and the test environment redirects it.
  for (const name of Object.keys(SDA_NAMES)) {
    assert.equal(Object.hasOwn(MACHINE_STATE_LOCATIONS, name), SDA_MACHINE_LOCATIONS.includes(name), name);
  }
  const config = await readFile(path.join(root, 'src/config.mjs'), 'utf8');
  assert.doesNotMatch(config, /definition\??\.(?:index|readIndex|lifecycleStorage)\b/u,
    'a governed storage key is Phase B, introduced with a minimumBuild raise (SDA §8)');
});
