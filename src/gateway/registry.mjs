/**
 * The operation registry v2 compiler. `[INT:IFC-030]` `[INT:CON-050]`
 *
 * The registry is the only catalog the gateway can resolve from, which makes it the only place a
 * host model's words can turn into something the kernel will do. Everything that decides whether
 * that is safe — reachability, goals, aliases, argument schema, confirmation class — is declared
 * here as data and checked here as a rule, rather than being implied by a handler somewhere.
 *
 * Reachability is opt-in and fails closed. An operation that exists in the kernel and says nothing
 * about the gateway is unreachable, so adding a command can never quietly widen what a model can
 * invoke; widening is a declaration someone writes and a reviewer reads.
 *
 * Two fields are held apart on purpose `[INT:CON-051]`:
 *
 *   - `modelPolicy` is about the *kernel*: may this operation invoke a model on its own behalf?
 *   - `gateway.reachable` is about the *host*: may a host model route to this operation at all?
 *
 * They answer different questions and neither implies the other. A deterministic read that never
 * touches a model is one of the most useful things to expose (`never` + reachable), and a
 * model-driven build is one of the last things to expose (`required` + unreachable). Deriving
 * either from the other collapses the distinction that keeps the second case closed.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../specifications.mjs';
import { SingularityFlowError } from '../util.mjs';
import { hasArgumentSchema } from './argument-schemas.mjs';
import { isBroadGoal } from './goals.mjs';
import { CONFIRMATION_CLASSES, SFLOW_RESULT_SCHEMA_VERSION } from './result.mjs';

export const OPERATION_REGISTRY_VERSION = 2;

/**
 * `authorization` is the classification v1 does not have, and the reason v2 needs its own word.
 *
 * v1 had two kinds of operation: ones that read and ones that write. An approval writes, so it was
 * a mutation — indistinguishable from creating a branch. But an approval is a *human decision being
 * recorded*, and the whole safety story depends on it never being something an ambient tool can
 * perform. Naming it separately is what lets the rules below refuse to make it executable.
 */
export const GATEWAY_CLASSIFICATIONS = Object.freeze(['read', 'mutation', 'authorization']);

/** What an operation can be *about*. A subject the registry cannot name is a subject it cannot scope. */
export const GATEWAY_SUBJECT_KINDS = Object.freeze([
  'workspace', 'initiative', 'epic', 'story', 'goal', 'repository', 'document', 'investigation', 'session'
]);

export const KERNEL_MODEL_POLICIES = Object.freeze(['never', 'optional', 'required']);

export const RESULT_CONTRACT = `sflow-result-v${SFLOW_RESULT_SCHEMA_VERSION}`;

/** A locale tag as registry data: reviewed, versioned, and never assembled at resolution time `[INT:CON-052]`. */
const LOCALE_TAG = /^[a-z]{2}(?:-[A-Z]{2})?$/;

function invalid(detail, details = {}) {
  throw new SingularityFlowError(`Invalid operation registry: ${detail}`, {
    code: 'OPERATION_REGISTRY_INVALID', details
  });
}

/**
 * Reduce a phrase to what two spellings of it have in common.
 *
 * Matching is exact against this normalized form `[INT:REQ-032]`, so normalization is the entire
 * tolerance the resolver has. It absorbs case, punctuation and spacing — the things a person varies
 * without meaning anything by it — and nothing else. Stemming or synonyms here would be fuzzy
 * matching wearing a different hat, and fuzzy matching must not pick an operation `[INT:CON-036]`.
 */
export function normalizeAlias(phrase) {
  return String(phrase ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function frozenAliases(id, aliases) {
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) {
    invalid(`'${id}' must declare an aliases object keyed by locale.`, { operation: id });
  }
  const locales = Object.keys(aliases);
  if (!locales.includes('en')) invalid(`'${id}' has no English aliases; English ships first.`, { operation: id });

  const compiled = {};
  for (const [locale, block] of Object.entries(aliases)) {
    if (!LOCALE_TAG.test(locale)) invalid(`'${id}' declares alias locale '${locale}', which is not a locale tag.`, { operation: id, locale });
    // An unversioned locale block is rejected outright `[INT:REQ-050]`. Without a version there is
    // nothing to review against and nothing to pin: a phrase list that can change silently is a
    // routing table that can change silently.
    if (!Number.isInteger(block?.version) || block.version < 1) {
      invalid(`'${id}' alias locale '${locale}' has no integer version.`, { operation: id, locale });
    }
    if (!Array.isArray(block.phrases) || !block.phrases.length) {
      invalid(`'${id}' alias locale '${locale}' has no phrases.`, { operation: id, locale });
    }
    const normalized = block.phrases.map((phrase) => {
      const value = normalizeAlias(phrase);
      if (!value) invalid(`'${id}' alias locale '${locale}' has a phrase that normalizes to nothing.`, { operation: id, locale, phrase });
      return value;
    });
    compiled[locale] = Object.freeze({
      version: block.version,
      phrases: Object.freeze([...block.phrases]),
      normalized: Object.freeze(normalized)
    });
  }
  return Object.freeze(compiled);
}

function compileDeclaration(declaration, { kernelOperations, plannerNames }) {
  const id = declaration?.id;
  if (typeof id !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) {
    invalid(`'${id}' is not a well-formed operation ID.`, { operation: id });
  }
  if (!GATEWAY_CLASSIFICATIONS.includes(declaration.classification)) {
    invalid(`'${id}' has classification '${declaration.classification}'; expected one of ${GATEWAY_CLASSIFICATIONS.join(', ')}.`, { operation: id });
  }

  const kernel = declaration.kernelOperation ?? null;
  let modelPolicy = declaration.modelPolicy ?? null;
  let externalDependencies = declaration.externalDependencies ?? [];

  if (kernel) {
    const inherited = kernelOperations.get(kernel);
    if (!inherited) invalid(`'${id}' routes to kernel operation '${kernel}', which is not in the kernel catalog.`, { operation: id, kernelOperation: kernel });
    /**
     * A routed operation inherits its model policy and never restates it `[INT:CON-051]`.
     *
     * Restating is how the two would drift: the kernel operation stops calling a model, the
     * gateway copy still says it does, and the disclosure the user reads is the stale one.
     */
    if (declaration.modelPolicy != null) {
      invalid(`'${id}' routes to '${kernel}' and must not restate modelPolicy; it is inherited.`, { operation: id, kernelOperation: kernel });
    }
    modelPolicy = inherited.modelPolicy;
    externalDependencies = declaration.externalDependencies ?? inherited.externalDependencies;
    /**
     * Classification may be tightened on the way out, never loosened. A kernel mutation may be
     * exposed as an authorization — a stronger gate — but a kernel mutation exposed as a read
     * would be a lie the gateway tells about the blast radius.
     */
    const tightened = inherited.classification === 'mutation' && declaration.classification === 'authorization';
    if (declaration.classification !== inherited.classification && !tightened) {
      invalid(`'${id}' is declared '${declaration.classification}' but kernel operation '${kernel}' is '${inherited.classification}'.`, { operation: id, kernelOperation: kernel });
    }
  } else if (!KERNEL_MODEL_POLICIES.includes(modelPolicy)) {
    invalid(`'${id}' is gateway-native and must declare a model policy of ${KERNEL_MODEL_POLICIES.join(', ')}.`, { operation: id });
  }

  const goals = declaration.goals ?? [];
  if (!Array.isArray(goals) || !goals.length) invalid(`'${id}' declares no broad goal.`, { operation: id });
  for (const goal of goals) if (!isBroadGoal(goal)) invalid(`'${id}' declares goal '${goal}', which is not a broad goal.`, { operation: id, goal });

  const subjects = declaration.subjects ?? [];
  if (!Array.isArray(subjects)) invalid(`'${id}' must declare a subjects array.`, { operation: id });
  for (const subject of subjects) {
    if (!GATEWAY_SUBJECT_KINDS.includes(subject)) invalid(`'${id}' declares subject kind '${subject}', which is not a known subject.`, { operation: id, subject });
  }

  if (!hasArgumentSchema(declaration.argumentSchema)) {
    invalid(`'${id}' names argument schema '${declaration.argumentSchema}', which does not exist.`, { operation: id, argumentSchema: declaration.argumentSchema });
  }
  if (!plannerNames.has(declaration.planner)) {
    invalid(`'${id}' names planner '${declaration.planner}', which no planner provides.`, { operation: id, planner: declaration.planner });
  }
  if (!CONFIRMATION_CLASSES.includes(declaration.confirmation)) {
    invalid(`'${id}' has confirmation class '${declaration.confirmation}'; expected one of ${CONFIRMATION_CLASSES.join(', ')}.`, { operation: id });
  }
  if (declaration.resultContract !== RESULT_CONTRACT) {
    invalid(`'${id}' declares result contract '${declaration.resultContract}'; the gateway speaks ${RESULT_CONTRACT}.`, { operation: id });
  }
  if (typeof declaration.noModelFixture !== 'string' || !declaration.noModelFixture.trim()) {
    invalid(`'${id}' has no deterministic fixture.`, { operation: id });
  }
  if (!Array.isArray(externalDependencies)) invalid(`'${id}' must declare an externalDependencies array.`, { operation: id });

  /**
   * An authorization is a human ceremony and is never executable `[INT:CON-113]` `[INT:REQ-050]`.
   *
   * Both halves are checked because they fail differently: an authorization outside a ceremony is
   * an approval the model can reach, and `executable` left true is an approval a host will offer as
   * a button even inside one.
   */
  if (declaration.classification === 'authorization') {
    if (declaration.confirmation !== 'ceremony') {
      invalid(`'${id}' is an authorization and must use the ceremony confirmation class.`, { operation: id });
    }
    if (declaration.executable === true) invalid(`'${id}' is an authorization and must not be executable.`, { operation: id });
  }
  /** A goal must never be enough to choose a write `[INT:CON-036]`. */
  if (declaration.classification !== 'read' && declaration.confirmation === 'none') {
    invalid(`'${id}' writes and must not be confirmation class 'none'.`, { operation: id });
  }
  if (modelPolicy === 'optional' && !declaration.fallback) {
    invalid(`'${id}' may use a model and declares no deterministic fallback.`, { operation: id });
  }

  return Object.freeze({
    id,
    classification: declaration.classification,
    modelPolicy,
    kernelOperation: kernel,
    gateway: Object.freeze({
      reachable: true,
      goals: Object.freeze([...goals]),
      aliases: frozenAliases(id, declaration.aliases),
      subjects: Object.freeze([...subjects]),
      argumentSchema: declaration.argumentSchema,
      planner: declaration.planner,
      confirmation: declaration.confirmation
    }),
    executable: declaration.classification === 'authorization' ? false : declaration.executable !== false,
    fallback: declaration.fallback ?? null,
    resultContract: declaration.resultContract,
    externalDependencies: Object.freeze([...externalDependencies]),
    noModelFixture: declaration.noModelFixture
  });
}

function assertAliasesAreUnambiguous(operations) {
  const perLocale = new Map();
  const classificationsByPhrase = new Map();

  for (const operation of operations) {
    for (const [locale, block] of Object.entries(operation.gateway.aliases)) {
      const seen = perLocale.get(locale) ?? new Map();
      for (const phrase of block.normalized) {
        // One phrase, one operation, within a locale `[INT:REQ-050]`.
        const owner = seen.get(phrase);
        if (owner) {
          invalid(`alias '${phrase}' (${locale}) is claimed by both '${owner}' and '${operation.id}'.`, { locale, phrase, operations: [owner, operation.id] });
        }
        seen.set(phrase, operation.id);

        /**
         * And across locales, a shared phrase may not straddle classifications `[INT:REQ-050]`.
         *
         * English phrases turn up verbatim inside other locales' alias lists — technical vocabulary
         * usually does. Per-locale uniqueness cannot see that, so this is the rule that catches the
         * case that matters: the same words a user types meaning a read, landing on an approval.
         */
        const classes = classificationsByPhrase.get(phrase) ?? new Map();
        const conflicting = [...classes.entries()].find(([classification]) => classification !== operation.classification);
        if (conflicting) {
          invalid(`alias '${phrase}' is shared by '${conflicting[1]}' (${conflicting[0]}) and '${operation.id}' (${operation.classification}).`, { phrase, operations: [conflicting[1], operation.id] });
        }
        classes.set(operation.classification, operation.id);
        classificationsByPhrase.set(phrase, classes);
      }
      perLocale.set(locale, seen);
    }
  }
}

/**
 * A goal that only ever lands on a write is a goal that chooses a write.
 *
 * `[INT:CON-035]` says a goal hint names no executable operation, and `[INT:CON-036]` says a
 * proposed goal must not silently choose a mutation. Together they mean a hint has to have
 * somewhere safe to land: at least one read per goal, so the model's contribution is a direction
 * and the write is a next action the user is offered rather than one the hint selected.
 */
function assertGoalsLandOnReads(operations) {
  const byGoal = new Map();
  for (const operation of operations) {
    for (const goal of operation.gateway.goals) {
      byGoal.set(goal, [...(byGoal.get(goal) ?? []), operation]);
    }
  }
  for (const [goal, members] of byGoal) {
    if (!members.some((operation) => operation.classification === 'read')) {
      invalid(`goal '${goal}' reaches only writes (${members.map((entry) => entry.id).join(', ')}); a hint must land on a read.`, { goal });
    }
  }
}

/**
 * Compile declarations into the catalog the gateway resolves from.
 *
 * Pure: the kernel catalog, planners and declarations all arrive as arguments, so the rules can be
 * tested against a bad registry without one existing on disk — and so the shipped registry is
 * compiled by exactly the code the tests exercise.
 */
export function compileOperationRegistry({ declarations = [], planners = [], kernelCatalog = [] } = {}) {
  const kernelOperations = new Map(kernelCatalog.map((entry) => [entry.id, entry]));
  const plannerNames = new Set(planners.map((entry) => entry.name));

  const operations = [];
  const ids = new Set();
  const fixtures = new Map();
  for (const declaration of declarations) {
    const compiled = compileDeclaration(declaration, { kernelOperations, plannerNames });
    if (ids.has(compiled.id)) invalid(`duplicate operation ID '${compiled.id}'.`, { operation: compiled.id });
    const fixtureOwner = fixtures.get(compiled.noModelFixture);
    if (fixtureOwner) {
      invalid(`'${compiled.id}' and '${fixtureOwner}' share fixture '${compiled.noModelFixture}'.`, { operations: [fixtureOwner, compiled.id] });
    }
    ids.add(compiled.id);
    fixtures.set(compiled.noModelFixture, compiled.id);
    operations.push(compiled);
  }

  for (const operation of operations) {
    if (!operation.fallback) continue;
    const fallback = operations.find((entry) => entry.id === operation.fallback);
    if (!fallback) invalid(`'${operation.id}' falls back to '${operation.fallback}', which is not reachable.`, { operation: operation.id });
    if (fallback.modelPolicy !== 'never') {
      invalid(`'${operation.id}' falls back to '${fallback.id}', which may itself use a model.`, { operation: operation.id });
    }
  }

  assertAliasesAreUnambiguous(operations);
  assertGoalsLandOnReads(operations);

  operations.sort((a, b) => a.id.localeCompare(b.id));
  const contract = Object.freeze({
    registryVersion: OPERATION_REGISTRY_VERSION,
    resultContract: RESULT_CONTRACT,
    operations: Object.freeze(operations)
  });

  /**
   * The content hash resolutions, plans, receipts and audit events bind to `[INT:REQ-051]`.
   *
   * Over the compiled contract and nothing else. A reordered declaration file or a reworded comment
   * does not survive compilation and so cannot invalidate outstanding plans; a changed rule does
   * survive it and invalidates all of them. Which planners happen to be implemented in this build is
   * deliberately outside the hash — that is a fact about the binary, not about what was agreed.
   */
  const contentHash = createHash('sha256').update(canonicalJson(contract)).digest('hex');
  return Object.freeze({
    ...contract,
    contentHash,
    unimplementedPlanners: Object.freeze(planners
      .filter((entry) => typeof entry.run !== 'function')
      .map((entry) => entry.name)
      .sort())
  });
}
