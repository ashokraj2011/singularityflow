/** Pure read model for the governed design and visual-verification surface. */
import type {
  RepositorySnapshot, VisualAssuranceSnapshot, VisualComparison, VisualEvidenceRecord
} from '../cli/snapshot.ts';

export interface VisualProfileView {
  id: string; label: string; dimensions: string; status: 'covered' | 'missing' | 'stale' | 'not-applicable';
  recordId: string | null;
  /** A person's decision that this screen size does not apply to the Story: who, through which group, and why. */
  notApplicable?: { decisionId: string; reason: string; decidedBy: string; at: string | null } | null;
}

export interface VisualAssuranceView {
  available: boolean; configured: boolean; workId: string | null; phase: string | null;
  itemDirectory: string | null; status: string; statusLabel: string;
  errors: string[]; warnings: string[]; passes: string[];
  approvedSet: VisualAssuranceSnapshot['designSources']['approvedSet'];
  candidates: VisualAssuranceSnapshot['designSources']['candidates'];
  designSources: VisualEvidenceRecord[]; visualArtifacts: VisualEvidenceRecord[];
  otherEvidence: VisualEvidenceRecord[]; profiles: VisualProfileView[];
  comparisons: VisualComparison[]; inventory: VisualAssuranceSnapshot['inventory'];
  servers: Array<{
    id: string; label: string; readiness: string; reasons: string[]; configured: boolean; tools: string[];
  }>;
  summary: { designSources: number; profilesCovered: number; profilesNotApplicable: number; profilesTotal: number; comparisonsPassed: number; evidence: number };
}

function profileViews(visual: VisualAssuranceSnapshot): VisualProfileView[] {
  const coverage = visual.coverage;
  if (!coverage) return [];
  const covered = new Map(coverage.covered.map((entry) => [entry.profileId, entry]));
  const stale = new Set(coverage.stale);
  const decided = new Map((coverage.notApplicable ?? []).map((entry) => [entry.profileId, entry]));
  return coverage.profiles.map((profile) => {
    const evidence = covered.get(profile.id);
    const decision = evidence ? null : decided.get(profile.id) ?? null;
    return {
      id: profile.id,
      label: profile.label ?? profile.id,
      dimensions: profile.width && profile.height
        ? `${profile.width} × ${profile.height}${profile.deviceScaleFactor ? ` @${profile.deviceScaleFactor}x` : ''}`
        : 'dimensions not declared',
      status: decision ? 'not-applicable' : stale.has(profile.id) ? 'stale' : evidence ? 'covered' : 'missing',
      recordId: evidence?.recordId ?? null,
      ...(decision ? { notApplicable: {
        decisionId: decision.decisionId, reason: decision.reason,
        decidedBy: [decision.actor, decision.authorityGroup ? `through ${decision.authorityGroup}` : null].filter(Boolean).join(' ') || 'a person who approves the step',
        at: decision.at ?? null
      } } : {})
    };
  });
}

export function buildVisualAssuranceView(snapshot: RepositorySnapshot | null): VisualAssuranceView {
  const visual = snapshot?.visualAssurance ?? null;
  const records = visual?.evidence.records ?? [];
  const profiles = visual ? profileViews(visual) : [];
  const comparisons = visual?.comparisons ?? [];
  const status = visual?.readiness.status ?? 'unavailable';
  const statusLabels: Record<string, string> = {
    ready: 'Ready for review', attention: 'Needs attention', blocked: 'Blocked',
    'not-configured': 'Not configured', unavailable: 'No active Story'
  };
  return {
    available: Boolean(visual), configured: visual?.configured ?? false,
    workId: visual?.workId ?? null, phase: visual?.phase ?? null,
    itemDirectory: visual?.itemDirectory ?? null, status, statusLabel: statusLabels[status] ?? status,
    errors: visual?.readiness.errors ?? [], warnings: visual?.readiness.warnings ?? [],
    passes: visual?.readiness.passes ?? [], approvedSet: visual?.designSources.approvedSet ?? null,
    candidates: visual?.designSources.candidates ?? [],
    designSources: records.filter((entry) => entry.kind === 'design-source'),
    visualArtifacts: records.filter((entry) => entry.kind === 'visual-artifact'),
    otherEvidence: records.filter((entry) => !['design-source', 'visual-artifact'].includes(entry.kind)),
    profiles, comparisons, inventory: visual?.inventory ?? null,
    servers: (snapshot?.mcp?.servers ?? []).map((server) => ({
      id: server.id, label: server.label,
      readiness: String(server.readiness ?? (server.configured ? 'needs-attestation' : 'needs-host-setup')),
      reasons: server.readinessReasons ?? [],
      configured: server.configured, tools: server.tools
    })),
    summary: {
      designSources: records.filter((entry) => entry.kind === 'design-source').length,
      profilesCovered: profiles.filter((entry) => entry.status === 'covered').length,
      profilesNotApplicable: profiles.filter((entry) => entry.status === 'not-applicable').length,
      profilesTotal: profiles.length,
      comparisonsPassed: comparisons.filter((entry) => entry.status === 'pass').length,
      evidence: records.length
    }
  };
}
