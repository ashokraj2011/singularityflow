/**
 * Supported SGOS mutation facade.
 *
 * The interpreter keeps clocks, raw adapters, authority resolvers, and other test seams in
 * runtime.mjs. Package consumers receive only these closed-vocabulary wrappers, so a caller cannot
 * backdate durable state or smuggle an internal option through a permissive object destructure.
 */
import { SingularityFlowError } from '../util.mjs';
import {
  pauseSgosProcess as pauseSgosProcessInternal,
  recoverInterruptedSgosExecution as recoverInterruptedSgosExecutionInternal,
  respondToSgosHumanRequest as respondToSgosHumanRequestInternal,
  resumeSgosProcess as resumeSgosProcessInternal,
  runSgosProcess as runSgosProcessInternal,
  startSgosProcess as startSgosProcessInternal,
  stepSgosProcess as stepSgosProcessInternal,
  stopSgosProcess as stopSgosProcessInternal
} from './runtime.mjs';

const OPTION_VOCABULARIES = Object.freeze({
  startSgosProcess: Object.freeze([
    'program', 'compilerRequest', 'taskContract', 'taskContractSha256', 'processId', 'subject',
    'processBinding'
  ]),
  stepSgosProcess: Object.freeze(['program', 'expectedRevision']),
  runSgosProcess: Object.freeze(['program', 'expectedRevision', 'maximumParallel']),
  respondToSgosHumanRequest: Object.freeze([
    'requestId', 'requestSha256', 'expectedRevision', 'actor', 'decision', 'input', 'program'
  ]),
  recoverInterruptedSgosExecution: Object.freeze([
    'attemptId', 'resolution', 'confirmationSha256', 'expectedRevision'
  ]),
  pauseSgosProcess: Object.freeze(['expectedRevision']),
  stopSgosProcess: Object.freeze(['expectedRevision']),
  resumeSgosProcess: Object.freeze(['checkpointSha256', 'expectedRevision', 'program'])
});

function invalidOptions(operation, message, details = {}) {
  throw new SingularityFlowError(`Public SGOS ${operation} options ${message}.`, {
    code: 'SGOS_PUBLIC_OPTIONS_INVALID',
    details: {
      operation,
      allowed: OPTION_VOCABULARIES[operation],
      ...details
    }
  });
}

function publicOptions(operation, supplied) {
  if (supplied === undefined) return Object.freeze({});
  if (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)) {
    invalidOptions(operation, 'must be a plain object');
  }
  const prototype = Object.getPrototypeOf(supplied);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidOptions(operation, 'must be a plain object');
  }

  const allowed = new Set(OPTION_VOCABULARIES[operation]);
  const keys = Reflect.ownKeys(supplied);
  const unexpected = keys.filter((key) => typeof key !== 'string' || !allowed.has(key));
  if (unexpected.length) {
    const names = unexpected.map(String).sort();
    if (names.includes('clock')) {
      invalidOptions(operation,
        "cannot include 'clock'; durable timestamps always use operational runtime time",
        { unexpected: names });
    }
    invalidOptions(operation, `contain unsupported key(s): ${names.join(', ')}`, {
      unexpected: names
    });
  }

  const normalized = {};
  for (const key of OPTION_VOCABULARIES[operation]) {
    if (Object.hasOwn(supplied, key)) normalized[key] = supplied[key];
  }
  return Object.freeze(normalized);
}

export async function startSgosProcess(root, options = {}) {
  return startSgosProcessInternal(root, publicOptions('startSgosProcess', options));
}

export async function stepSgosProcess(root, processId, options = {}) {
  return stepSgosProcessInternal(root, processId, publicOptions('stepSgosProcess', options));
}

export async function runSgosProcess(root, processId, options = {}) {
  return runSgosProcessInternal(root, processId, publicOptions('runSgosProcess', options));
}

export async function respondToSgosHumanRequest(root, processId, options = {}) {
  return respondToSgosHumanRequestInternal(
    root, processId, publicOptions('respondToSgosHumanRequest', options)
  );
}

export const respondToHumanRequest = respondToSgosHumanRequest;

export async function recoverInterruptedSgosExecution(root, processId, options = {}) {
  return recoverInterruptedSgosExecutionInternal(
    root, processId, publicOptions('recoverInterruptedSgosExecution', options)
  );
}

export async function pauseSgosProcess(root, processId, options = {}) {
  return pauseSgosProcessInternal(root, processId, publicOptions('pauseSgosProcess', options));
}

export async function stopSgosProcess(root, processId, options = {}) {
  return stopSgosProcessInternal(root, processId, publicOptions('stopSgosProcess', options));
}

export async function resumeSgosProcess(root, processId, options = {}) {
  return resumeSgosProcessInternal(root, processId, publicOptions('resumeSgosProcess', options));
}
