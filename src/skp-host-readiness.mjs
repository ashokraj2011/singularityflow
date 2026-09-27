/**
 * Closed, source-side readiness diagnostics, not an admission or a host attestation. The model
 * provider registry identifies an integration seam; registration does not qualify an installed
 * executable for SKP. No native process, identity lookup, permission ceremony or receipt issuer is
 * invoked here. In particular, caller-written evidence cannot turn this report into permission.
 */
import { registeredModelProviderIds } from './model-runner.mjs';
import { SKP_HOST_DIMENSIONS } from './skp-host-admission.mjs';

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** No inputs: neither model/provider configuration nor evidence-shaped JSON can enable SKP. */
export function diagnoseSkillHostReadiness() {
  const registeredModelProviders = registeredModelProviderIds();
  const copilotRegistered = registeredModelProviders.includes('copilot-cli');
  return freeze({
    schemaVersion: 1,
    resultType: 'sflow-skill-host-readiness',
    status: 'unavailable',
    code: 'SKP_HOST_ENFORCEMENT_UNAVAILABLE',
    observationScope: 'source-capabilities-only',
    registeredModelProviders,
    installedHost: 'not-checked',
    nativeQualification: 'not-performed',
    unavailableDimensions: [...SKP_HOST_DIMENSIONS],
    executable: false,
    launchAuthorized: false,
    mutationRequired: false,
    integrationSeam: copilotRegistered ? {
      modelProviderId: 'copilot-cli',
      transport: 'acp',
      source: 'src/model-providers/copilot-cli.mjs',
      status: 'registered-model-provider-only',
      qualifiedSkillAdapter: false
    } : null,
    sourceOwners: [
      ...(copilotRegistered ? [{
        id: 'acp-file-mutation-permissions',
        source: 'src/model-providers/copilot-cli.mjs',
        status: 'implemented-source-only',
        scope: 'Reviewed file-tool operation and canonical target checks at ACP mutation permission time.',
        limitation: 'Read/search notifications can be post-effect; native process I/O, network, credentials and control-plane access are not confined.'
      }, {
        id: 'prompt-staging-and-process-supervision',
        source: 'src/model-providers/copilot-cli.mjs',
        status: 'implemented-source-only',
        scope: 'Exact staged prompt verification and bounded ACP cancellation/process cleanup.',
        limitation: 'Neither staged bytes nor process exit proves exact host delivery or qualified descendant termination.'
      }] : []),
      {
        id: 'terminal-local-authoring-review',
        source: 'src/action-authorization.mjs',
        status: 'implemented-source-only',
        scope: 'Live direct-terminal presentation and one-use exact-plan/action authorization for authoring.',
        limitation: 'Configured local Git identity and terminal review are not authenticated native-host mediated consent.'
      }, {
        id: 'host-admission-validator',
        source: 'src/skp-host-admission.mjs',
        status: 'implemented-source-only',
        scope: 'Operation/policy-bound launch-evidence and exact-delivery validation.',
        limitation: 'The validator does not supply a trusted live adapter or authenticate caller-written evidence.'
      }
    ],
    missingOwners: [{
      id: 'pre-effect-enforcement',
      status: 'unavailable',
      dimensions: [...SKP_HOST_DIMENSIONS],
      requirement: 'An approved isolated host adapter must enforce each selected operation-bound policy before effect, including native process access, and prove cancellation/descendant cleanup on the actual installed host.',
      candidateSource: copilotRegistered ? 'src/model-providers/copilot-cli.mjs' : null
    }, {
      id: 'authenticated-mediated-confirmation',
      status: 'unavailable',
      requirement: 'A trusted native confirmation owner must authenticate the human and host session, present the exact current subject/action, and consume fresh single-use consent bound to that subject, principal, session and audience.',
      existingLocalOwner: 'src/action-authorization.mjs',
      localOwnerAssurance: 'configured-local-review',
      authenticatedNativeHost: false
    }, {
      id: 'exact-host-delivery',
      status: 'unavailable',
      requirement: 'The trusted live adapter must acknowledge the exact package, projected entry and resource manifest bound to the admitted operation, profile, adapter and installed version.',
      validatorSource: 'src/skp-host-admission.mjs'
    }],
    nextAction: {
      id: 'provide-approved-skp-host',
      kind: 'external-prerequisite',
      owner: 'host-integrator',
      executionAuthorized: false,
      description: 'Obtain approval for an isolated installed host and its authenticated confirmation/delivery owners, then qualify their actual enforcement. No existing command can enable SKP execution.'
    }
  });
}
