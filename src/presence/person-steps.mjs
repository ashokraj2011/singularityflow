/**
 * SF Guard M3 (SPEC-PSS-v1 §3, AC-010): a Story's other person-only steps, signed where they are written.
 *
 * Approve and reject (M2) sign their own records. Every other decision a person records on a Story
 * (a risk acceptance, a test command acceptance, a scope disposition, a witness review and the rest
 * in FAMILIES) lands in the Story's aggregate, and every legitimate write of that aggregate goes through
 * `saveWorkflow`. So that one place signs: on a Story whose pin requires SF Guard, the person records
 * the command added (those not on disk before it ran) are signed together, after the card, with one
 * Touch ID touch, before anything is written. Declining, or any refusal, writes nothing, and every
 * refusal names a route the person can take today. Under an active per-person exception they are
 * written unsigned, labelled as a bypass.
 *
 * Each family's readers count a record through `countedRecords` (counted.mjs): only one whose
 * signature verifies against the approver's pinned key, or one an exception covers. So a record an
 * agent writes with plain Git, or by editing the state file, counts for nothing; a record already on
 * disk before the command ran is never offered for signing.
 */
import { readFileSync } from 'node:fs';

import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { activeException } from './chain.mjs';
import {
  actorApproverId, loadPresenceContext, personBatchStatement, personRecordDigest, personTerminal, PRESENCE_RECORD_SCHEMA
} from './person-records.mjs';
import { presenceNonce } from './statement.mjs';

const always = () => true;
/**
 * The Story's person-decision families: where their records live and which entries are a person's
 * decision. Entries that are not (a test command request, which anyone may make) are never signed and
 * always count. A record's `id`, else what it revokes or accepts, names it on the card.
 */
export const PERSON_STEP_FAMILIES = Object.freeze([
  { id: 'risk', list: 'riskDecisions', action: 'decision.risk', label: 'Risk decision', isPerson: always },
  { id: 'test-command', list: 'testCommandDecisions', action: 'decision.test-command', label: 'Test command decision',
    isPerson: (entry) => Boolean(entry?.accepts || entry?.revokes) },
  { id: 'test-narrowing', list: 'testNarrowings', action: 'decision.test-narrowing', label: 'Test narrowing decision', isPerson: always },
  { id: 'test-run-risk', list: 'testRunRisks', action: 'decision.test-risk', label: 'Test-run risk decision', isPerson: always },
  { id: 'evidence-reuse', list: 'evidenceReuses', action: 'decision.evidence-reuse', label: 'Evidence reuse decision', isPerson: always },
  { id: 'visual-profile', list: 'visualProfileDecisions', action: 'decision.visual-profile', label: 'Visual profile decision', isPerson: always },
  { id: 'witness', list: 'witnessRecords', action: 'decision.witness', label: 'Witness review', isPerson: always },
  { id: 'witness-exception', list: 'witnessExceptionRenewals', action: 'decision.witness-exception', label: 'Witness exception renewal', isPerson: always },
  { id: 'scope', list: 'scopeDispositions', action: 'decision.scope', label: 'Scope disposition', isPerson: always },
  { id: 'completeness', list: 'completenessReviews', action: 'decision.completeness', label: 'Completeness review', isPerson: always },
  { id: 'applicability', list: 'applicability', action: 'decision.applicability', label: 'Applicability decision', isPerson: always },
  { id: 'upstream-issue', list: 'upstreamIssueDecisions', action: 'decision.upstream-issue', label: 'Upstream issue decision', isPerson: always },
  { id: 'forward-amendment', list: 'forwardAmendmentDecisions', action: 'decision.forward-amendment', label: 'Forward amendment decision', isPerson: always },
  { id: 'plan-amendment', list: 'planAmendments', action: 'decision.plan', label: 'Plan amendment', isPerson: always }
]);

const familyByList = new Map(PERSON_STEP_FAMILIES.map((family) => [family.list, family]));

/** Whether `record` in `list` is a person's decision SF Guard signs and counts. */
export function isPersonStepRecord(list, record) {
  const family = familyByList.get(list);
  return Boolean(family && record && typeof record === 'object' && family.isPerson(record));
}

const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

let dependencies = {};
/**
 * Replace the signer's readers in this process (tests pass software stand-ins for the Secure Enclave
 * this way). It changes nothing a verifier reads: a record still counts only when its signature
 * verifies against the approver's pinned key.
 */
export function setPersonStepPresenceDependencies(next = {}) {
  dependencies = { ...next };
}

/**
 * The person records the command added: in `workflow`, not signed, and not in the state file before it
 * ran. A record the command only extended (a new disposition withdraws the one before it by adding
 * `withdrawnAt`) is the record that was on disk, never a new one.
 */
export function newPersonRecords(workflow, prior) {
  const added = [];
  for (const family of PERSON_STEP_FAMILIES) {
    const before = (Array.isArray(prior?.[family.list]) ? prior[family.list] : [])
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({ fields: Object.keys(entry), text: canonicalJson(entry) }));
    const onDisk = (record) => before.some(({ fields, text }) => canonicalJson(
      Object.fromEntries(fields.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]))) === text);
    for (const record of workflow?.[family.list] ?? []) {
      if (!record || typeof record !== 'object' || record.presence || !family.isPerson(record)) continue;
      if (!onDisk(record)) added.push({ family, record });
    }
  }
  return added;
}

function readPrior(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function quoted(value) {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command line the person runs again in their own terminal. */
function thisCommand(argv = process.argv) {
  return ['singularity-flow', ...argv.slice(2).map((value) => quoted(String(value)))].join(' ');
}

function summary(family, record) {
  const name = record.id ?? (record.revokes ? `revokes ${record.revokes}` : record.accepts ? `accepts ${record.accepts}` : record.item ?? record.issue
    ?? record.amendment ?? record.responsibility ?? null);
  const reason = typeof record.reason === 'string' ? record.reason.replace(/\s+/gu, ' ').slice(0, 80) : '';
  return `${family.label}${name ? ` ${name}` : ''}${reason ? `: ${reason}` : ''}`;
}

async function holdsKey(keyId) {
  const { ctkIdentities, presenceIdentityStanding } = await import('./local-keys.mjs');
  return presenceIdentityStanding(ctkIdentities(), keyId).ok;
}

/**
 * Sign the person records this command added to `workflow`, before `saveWorkflow` writes `file`. Does
 * nothing on a Story SF Guard does not require, or when the command added none.
 */
export async function signNewPersonRecords(root, workflow, file) {
  const context = await loadPresenceContext(root, workflow, { verify: dependencies.verify });
  if (!context.required) return;
  const added = newPersonRecords(workflow, readPrior(file));
  if (!added.length) return;
  const authorities = workflow.resolution?.approvalAuthorities;
  const approvers = new Set(added.map(({ record }) => actorApproverId(authorities, record.actor)));
  const command = thisCommand(dependencies.argv);
  const routes = { command, others: 'another approver can record it in their own terminal' };
  const [approver] = approvers;
  if (approvers.size !== 1 || !approver) {
    fail(`SF Guard: this Story requires presence-signed person steps, and the decision's identity is not an approver in its pinned configuration. Nothing was written; ${routes.others}.`,
      'PSS_NOT_AN_APPROVER', { routes });
  }
  routes.exception = `another approver can record a per-person exception: singularity-flow guard exception add ${approver}`;
  if (!context.chain) {
    fail(`SF Guard: this Story requires presence-signed person steps, and its policy (singularity/presence.json in the approved configuration) cannot be read here${context.unreadable ? `: ${context.unreadable}` : ''}. Nothing was written. Bring the configuration up to date (singularity-flow sync), then run the same command again; or ${routes.others}.`,
      'PSS_POLICY_UNREADABLE', { approver, routes });
  }
  const action = new Set(added.map(({ family }) => family.action)).size === 1 ? added[0].family.action : 'story.person-records';
  const exception = activeException(context.folded, approver);
  if (exception) {
    // Unsigned, and never read as signed: the exception travels with each record and labels it.
    const at = new Date().toISOString();
    for (const { record } of added) {
      record.presence = { schema: PRESENCE_RECORD_SCHEMA, chainId: context.chainId, approver, action, bypass: exception.id, at };
    }
    return;
  }
  const pin = context.folded.pins.get(approver);
  if (!pin) {
    fail(`SF Guard: this Story requires your presence signature, and you have no presence key pinned. Nothing was written. Register one in your own terminal (singularity-flow guard register), or ${routes.others}, or ${routes.exception}.`,
      'PSS_KEY_NOT_REGISTERED', { approver, routes });
  }
  const availability = (dependencies.signerAvailability ?? (await import('./signer.mjs')).signerAvailability)();
  if (!availability.available) {
    fail(`SF Guard cannot sign on this computer: ${availability.reason}. Nothing was written. Run this step on the Mac that holds your presence key (${pin.keyId}), or ${routes.others}, or ${routes.exception}.`,
      'PSS_SIGNER_UNAVAILABLE', { approver, keyId: pin.keyId, routes });
  }
  const terminal = (dependencies.personTerminal ?? personTerminal)();
  if (!terminal.person) {
    fail(`SF Guard: this decision needs your presence signature, taken in your own terminal (${terminal.reason}). Nothing was written. Run it there: ${command}`,
      'PSS_CARD_NOT_SHOWN', { approver, nextAction: { command, label: `Run in your own terminal: ${command}` }, routes });
  }
  if (!await (dependencies.holdsKey ?? holdsKey)(pin.keyId)) {
    fail(`SF Guard: this Mac does not hold your pinned presence key ${pin.keyId}. Nothing was written. Run this step on the Mac that holds it, rotate to a key on this Mac (singularity-flow guard rotate --key <NEW-KEY-ID>), or ${routes.others}. If you never registered ${pin.keyId}, revoke it: singularity-flow guard revoke ${approver} --reason "not my key".`,
      'PSS_SIGNER_UNAVAILABLE', { approver, keyId: pin.keyId, routes });
  }
  const signed = added.map(({ family, record }) => {
    const fields = Object.keys(record).filter((field) => field !== 'presence').sort();
    return { family, record, fields, digest: personRecordDigest(record, fields) };
  });
  const presence = { schema: PRESENCE_RECORD_SCHEMA, chainId: context.chainId, approver, keyId: pin.keyId, action,
    at: new Date().toISOString(), nonce: presenceNonce(), batch: [...new Set(signed.map((entry) => entry.digest))].sort() };
  const statement = personBatchStatement(presence, { chainId: context.chainId, workId: workflow.workItem.id });
  const card = dependencies.card ?? (async (fields) => (await import('./signer.mjs')).presenceCard(fields));
  const sign = dependencies.sign ?? (async (request) => (await import('./signer.mjs')).signWithPresence(request));
  const shown = await card({
    title: `${signed.length === 1 ? 'record a decision' : `record ${signed.length} decisions`} on ${workflow.workItem.id}`,
    lines: [...signed.map(({ family, record }) => summary(family, record)), `Records: ${presence.batch.join(', ')}`],
    keyId: pin.keyId
  });
  const result = await sign({ statement, keyId: pin.keyId, publicKey: pin.key, card: shown });
  for (const { record, fields } of signed) {
    record.presence = { ...presence, fields, signature: result.signature, userVerification: Boolean(result.userVerification) };
  }
}
