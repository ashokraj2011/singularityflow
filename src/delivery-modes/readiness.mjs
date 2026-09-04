/** Honest GDP-M11 readiness projection. Reporting readiness never grants readiness. */
import { provenanceReadiness } from './provenance.mjs';

const IMPLEMENTATION = Object.freeze([
  { milestone: 'GDP-M0', status: 'implemented', scope: 'contract-and-ownership-freeze' },
  { milestone: 'GDP-M1', status: 'implemented', scope: 'compatibility-projections' },
  { milestone: 'GDP-M2', status: 'implemented', scope: 'shadow-change-passport' },
  { milestone: 'GDP-M3', status: 'implemented', scope: 'deterministic-proof-observe' },
  { milestone: 'GDP-M4', status: 'implemented', scope: 'impact-environment-observe' },
  { milestone: 'GDP-M5', status: 'implemented', scope: 'bounded-outcome-pilot' },
  { milestone: 'GDP-M6', status: 'implemented', scope: 'feature-bugfix-workflow-projection' },
  { milestone: 'GDP-M7', status: 'implemented', scope: 'existing-sgos-execution-bridge' },
  { milestone: 'GDP-M8', status: 'implemented', scope: 'outcome-workflow-handoff-and-diagnostics' },
  { milestone: 'GDP-M9', status: 'partial', scope: 'local-observe-no-runner-authority' },
  { milestone: 'GDP-M10', status: 'partial', scope: 'provider-contracts-no-installed-verifier' },
  { milestone: 'GDP-M11', status: 'partial', scope: 'readiness-reporting-no-ga-claim' }
]);

const SUPPORT = Object.freeze({
  deliveryModes: [
    { id: 'workflow', status: 'supported-existing-runtime' },
    { id: 'outcome', status: 'opt-in-bounded-pilot' }
  ],
  workflowMappings: [
    { id: 'feature', status: 'supported-shadow-projection' },
    { id: 'bugfix', status: 'supported-shadow-projection' },
    { id: 'other', status: 'unmapped' }
  ],
  assuranceProfiles: [
    { id: 'deterministic-observe', status: 'available-non-gating' },
    { id: 'local-hermetic-observe', status: 'available-non-gating-no-runner-authentication' },
    { id: 'high-assurance-enforce', status: 'unavailable' }
  ],
  adapters: [
    { id: 'junit5-reviewed-binder', status: 'observe-only' },
    { id: 'unsupported-language-or-runner', status: 'unavailable-non-blocking' }
  ],
  ciProviders: [{ id: 'provider-neutral-contract', status: 'interface-only' }],
  packages: [
    { id: 'npm', status: 'requires-release-receipt' },
    { id: 'vsix', status: 'requires-release-receipt' }
  ]
});

const REQUIRED_BLOCKERS = Object.freeze([
  {
    code: 'GDP_GA_HERMETIC_RUNNER_EVIDENCE_MISSING', owner: 'security-and-platform',
    requirement: 'Authenticate runner isolation, signer, trust root, revocation, containment, and recovery.'
  },
  {
    code: 'GDP_GA_PROVIDER_PILOTS_MISSING', owner: 'release-and-enterprise-provider',
    requirement: 'Complete approved provider outage, replay, rollback, revocation, privacy, and retention pilots.'
  },
  {
    code: 'GDP_GA_PLATFORM_RELEASE_RECEIPTS_MISSING', owner: 'release-engineering',
    requirement: 'Bind clean-checkout macOS, Linux, Windows, Node, npm, and VS Code/VSIX receipts to one candidate.'
  },
  {
    code: 'GDP_GA_MIGRATION_EXERCISES_MISSING', owner: 'migration-owner',
    requirement: 'Complete upgrade, downgrade, fresh clone, old state branch, interruption, and recovery exercises.'
  },
  {
    code: 'GDP_GA_OBSERVATION_WINDOW_INCOMPLETE', owner: 'product-and-reliability',
    requirement: 'Complete the agreed observation window with no unresolved critical mismatches.'
  },
  {
    code: 'GDP_GA_DUPLICATE_PATH_SUNSET_UNPROVEN', owner: 'architecture',
    requirement: 'Prove no supported runtime uses duplicate readers or writers before any sunset.'
  }
]);

function safeRuntime(value, fallback) {
  const result = String(value ?? fallback);
  return /^[A-Za-z0-9._-]{1,80}$/.test(result) ? result : fallback;
}

export function buildGdpReadiness({
  platform = 'unknown', architecture = 'unknown', nodeVersion = 'unknown', providerConfiguration = null
} = {}) {
  const provenance = provenanceReadiness(providerConfiguration);
  const blockers = [
    ...REQUIRED_BLOCKERS,
    ...(provenance.verifierAvailable ? [] : [{
      code: 'GDP_GA_PROVENANCE_VERIFIER_UNAVAILABLE', owner: 'enterprise-provider',
      requirement: 'Install and approve a cryptographic provenance verifier and its trust-root lifecycle.'
    }])
  ];
  return Object.freeze({
    schemaVersion: 1, kind: 'gdp-readiness-report', status: 'not-ready', gaReady: false,
    authority: 'report-only', implementation: IMPLEMENTATION.map((entry) => ({ ...entry })),
    supportMatrix: structuredClone(SUPPORT),
    observedRuntime: {
      platform: safeRuntime(platform, 'unknown'), architecture: safeRuntime(architecture, 'unknown'),
      nodeVersion: safeRuntime(String(nodeVersion ?? 'unknown').replace(/^v/, ''), 'unknown'),
      assurance: 'runtime-label-only-not-a-platform-receipt'
    },
    provenance, blockers: blockers.map((entry) => ({ ...entry })),
    prohibitions: [
      'DO_NOT_ENABLE_HIGH_ASSURANCE_ENFORCEMENT',
      'DO_NOT_ACCEPT_PROVIDER_ATTESTATIONS_WITHOUT_VERIFIER',
      'DO_NOT_SUNSET_LEGACY_READERS_OR_WRITERS',
      'DO_NOT_CLAIM_GA_FROM_LOCAL_TESTS'
    ],
    nextDecision: 'Collect and review the missing external evidence; rerun readiness without changing historical records.'
  });
}
