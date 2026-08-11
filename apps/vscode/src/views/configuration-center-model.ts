/** Pure models and governed YAML edits for the Configuration Center. */
import YAML from 'yaml';
import type { RepositorySnapshot } from '../cli/snapshot.ts';

export type ConfigurationTab = 'overview' | 'world-model' | 'people' | 'mcp';
export type AuthorityScope = 'story' | 'initiative';

export interface ProfileView { name: string; role: string; }
export interface AuthorityMemberView { name: string; email: string; githubLogin: string; }
export interface AuthorityView {
  id: string; label: string; scope: AuthorityScope; allowAnyGitIdentity: boolean;
  members: AuthorityMemberView[];
}
export interface McpServerView {
  id: string; label: string; hostReference: string; agents: string[]; phases: string[];
  tools: string[]; required: boolean; approval: 'confirm' | 'host'; configured: boolean;
  sources: string[]; captureToolCalls: boolean; captureResults: boolean;
  readiness?: 'ready' | 'needs-host-setup' | 'misconfigured'; readinessReasons?: string[];
}
export interface WorldModelSettingsView {
  views: string[];
  outputDir: string;
  promptSource: string;
  stateFetchTimeoutMs: number;
  generation: { parallel: boolean; maxWorkers: number; strategy: 'view' };
  materialization: {
    mode: 'explicit' | 'on-demand' | 'disabled'; publish: 'governed' | 'local';
    lookahead: 'none' | 'next-phase'; depth: 'light' | 'phase';
    confirmation: 'prompt' | 'automatic';
  };
  grounding: 'off' | 'warn' | 'enforce';
  staleness: 'warn' | 'fail' | 'ignore';
  injection: { placeholder: string; mode: 'replace' | 'append' | 'off'; maxBytes: number; rulesCount: number };
}
export interface ConfigurationCenterView {
  profile: ProfileView;
  authorities: AuthorityView[];
  mcpServers: McpServerView[];
  agents: Array<{ id: string; label: string }>;
  phases: Array<{ id: string; label: string }>;
  mcpErrors: string[];
  mcpWarnings: string[];
  worldModel: WorldModelSettingsView;
}

export interface McpDraft extends Omit<McpServerView, 'configured' | 'sources'> { previousId?: string; }
export interface AuthorityDraft extends AuthorityView { previousId?: string; }
export type WorldModelDraft = Omit<WorldModelSettingsView, 'injection'> & {
  injection: Omit<WorldModelSettingsView['injection'], 'rulesCount'>;
};

export interface ConfigurationTextRevision {
  definitionText: string;
  portfolioText: string;
}

export function configurationRefreshDecision(
  dirty: boolean,
  rendered: ConfigurationTextRevision,
  current: ConfigurationTextRevision
): 'render' | 'hold' | 'conflict' {
  if (!dirty) return 'render';
  return rendered.definitionText === current.definitionText && rendered.portfolioText === current.portfolioText
    ? 'hold'
    : 'conflict';
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const email = /^[^@\s]+@[^@\s]+$/;

function member(value: unknown): AuthorityMemberView {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    name: String(row.name ?? ''), email: String(row.email ?? ''),
    githubLogin: String(row.githubLogin ?? row.login ?? '')
  };
}

function authorityRows(source: unknown, scope: AuthorityScope): AuthorityView[] {
  const rows = source && typeof source === 'object' && !Array.isArray(source)
    ? source as Record<string, Record<string, unknown>> : {};
  return Object.entries(rows).map(([id, value]) => ({
    id, scope, label: String(value.label ?? id),
    allowAnyGitIdentity: value.allowAnyGitIdentity === true,
    members: Array.isArray(value.members) ? value.members.map(member) : []
  }));
}

export function configurationCenterView(snapshot: RepositorySnapshot, profile: ProfileView): ConfigurationCenterView {
  const definition = snapshot.definition ?? {};
  const worldModel = definition.worldModel ?? {};
  const generation = worldModel.generation ?? {};
  const materialization = worldModel.materialization ?? {};
  const injection = worldModel.injection ?? {};
  const phaseRows = definition.phases ?? {};
  const agentLabels = new Map((snapshot.agents ?? []).map((entry) => [entry.id, entry.id]));
  return {
    profile,
    authorities: [
      ...authorityRows(definition.approvalAuthorities, 'story'),
      ...authorityRows(snapshot.portfolio?.approvalAuthorities, 'initiative')
    ].sort((left, right) => left.scope.localeCompare(right.scope) || left.label.localeCompare(right.label)),
    mcpServers: (snapshot.mcp?.servers ?? []).map((server) => ({
      ...server,
      approval: server.approval === 'host' ? 'host' : 'confirm',
      captureToolCalls: server.evidence?.captureToolCalls !== false,
      captureResults: server.evidence?.captureResults === true
    })),
    agents: [...agentLabels].map(([id, label]) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id)),
    phases: Object.entries(phaseRows).map(([id, phase]) => ({ id, label: phase.label ?? id })),
    mcpErrors: snapshot.mcp?.errors ?? [], mcpWarnings: snapshot.mcp?.warnings ?? [],
    worldModel: {
      views: worldModel.views ?? ['business', 'architecture', 'development', 'testing', 'release', 'operations', 'security'],
      outputDir: worldModel.outputDir ?? 'singularity/world-model',
      promptSource: worldModel.promptSource ?? 'singularity/prompts/worldmodel-builder.md',
      stateFetchTimeoutMs: worldModel.stateFetchTimeoutMs ?? 10_000,
      generation: {
        parallel: generation.parallel !== false,
        maxWorkers: generation.maxWorkers ?? 4,
        strategy: generation.strategy ?? 'view'
      },
      materialization: {
        mode: materialization.mode ?? 'explicit', publish: materialization.publish ?? 'governed',
        lookahead: materialization.lookahead ?? 'none', depth: materialization.depth ?? 'phase',
        confirmation: materialization.confirmation ?? 'prompt'
      },
      grounding: worldModel.grounding ?? 'off',
      staleness: worldModel.staleness ?? 'warn',
      injection: {
        placeholder: injection.placeholder ?? '{{WORLD_MODEL}}',
        mode: injection.mode ?? 'append', maxBytes: injection.maxBytes ?? 32_768,
        rulesCount: injection.rules?.length ?? 0
      }
    }
  };
}

function unsafeRelative(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/])/.test(value) || value.split(/[\\/]+/).includes('..');
}

export function validateWorldModelDraft(draft: WorldModelDraft): string[] {
  const errors: string[] = [];
  if (!draft.views.length) errors.push('Declare at least one world-model view.');
  if (new Set(draft.views).size !== draft.views.length) errors.push('World-model views must not contain duplicates.');
  draft.views.forEach((view) => { if (!ID.test(view)) errors.push(`World-model view '${view}' must be lower-case kebab-case.`); });
  if (!draft.outputDir.trim() || unsafeRelative(draft.outputDir.trim())) errors.push('Output directory must be a repository-relative path.');
  if (!draft.promptSource.trim() || (draft.promptSource.trim() !== 'builtin' && unsafeRelative(draft.promptSource.trim()))) errors.push("Prompt source must be 'builtin' or a repository-relative path.");
  if (!Number.isInteger(draft.stateFetchTimeoutMs) || draft.stateFetchTimeoutMs < 250 || draft.stateFetchTimeoutMs > 60_000) errors.push('State fetch timeout must be from 250 through 60000 milliseconds.');
  if (!Number.isInteger(draft.generation.maxWorkers) || draft.generation.maxWorkers < 1 || draft.generation.maxWorkers > 16) errors.push('Parallel workers must be from 1 through 16.');
  if (draft.materialization.confirmation === 'automatic' && draft.materialization.depth !== 'light') errors.push('Automatic materialization requires deterministic light depth. Model-driven phase generation must be confirmed.');
  if (!draft.injection.placeholder) errors.push('Injection placeholder must not be empty.');
  if (!Number.isInteger(draft.injection.maxBytes) || draft.injection.maxBytes < 1) errors.push('Injection budget must be a positive whole number of bytes.');
  return errors;
}

export function validateMcpDraft(draft: McpDraft): string[] {
  const errors: string[] = [];
  if (!ID.test(draft.id)) errors.push('Server ID must be lower-case kebab-case.');
  if (!draft.label.trim()) errors.push('Give the server a display label.');
  if (!ID.test(draft.hostReference)) errors.push('Host reference must be lower-case kebab-case.');
  if (new Set(draft.tools).size !== draft.tools.length) errors.push('Tool names must not contain duplicates.');
  if (draft.tools.some((tool) => !/^[A-Za-z0-9_.-]+$/.test(tool))) errors.push('Tools must be unqualified MCP tool names.');
  return errors;
}

export function validateAuthorityDraft(draft: AuthorityDraft): string[] {
  const errors: string[] = [];
  if (!ID.test(draft.id)) errors.push('Authority ID must be lower-case kebab-case.');
  if (!draft.label.trim()) errors.push('Give the authority a display label.');
  if (!draft.members.length && (draft.scope === 'initiative' || !draft.allowAnyGitIdentity)) {
    errors.push(draft.scope === 'initiative'
      ? 'Initiative authorities require at least one named Git identity.'
      : 'Add a member or allow any configured Git identity.');
  }
  const identities = new Set<string>();
  draft.members.forEach((entry, index) => {
    if (!entry.name.trim()) errors.push(`Member ${index + 1} needs a display name.`);
    const normalizedEmail = entry.email.trim().toLowerCase();
    const normalizedLogin = entry.githubLogin.trim().toLowerCase();
    if (draft.scope === 'initiative' && !email.test(normalizedEmail)) {
      errors.push(`Member ${index + 1} needs a valid Git email for Initiative approval.`);
    } else if (draft.scope === 'story' && !email.test(normalizedEmail) && !normalizedLogin) {
      errors.push(`Member ${index + 1} needs a valid Git email or GitHub login.`);
    }
    const identity = normalizedEmail ? `email:${normalizedEmail}` : `github:${normalizedLogin}`;
    if (identities.has(identity)) errors.push(`Member ${index + 1} duplicates ${normalizedEmail || normalizedLogin}.`);
    identities.add(identity);
  });
  return errors;
}

function document(text: string, label: string): YAML.Document.Parsed {
  const parsed = YAML.parseDocument(text);
  if (parsed.errors.length) throw new Error(`${label} is not valid YAML: ${parsed.errors[0]?.message}`);
  return parsed;
}

export function updateMcpYaml(text: string, draft: McpDraft | null, deleteId: string | null = null): string {
  const parsed = document(text, 'workflow.yml');
  if (deleteId) parsed.deleteIn(['mcpServers', deleteId]);
  if (draft) {
    const errors = validateMcpDraft(draft);
    if (errors.length) throw new Error(errors.join(' '));
    if (draft.previousId && draft.previousId !== draft.id) parsed.deleteIn(['mcpServers', draft.previousId]);
    parsed.setIn(['mcpServers', draft.id], {
      label: draft.label.trim(), hostReference: draft.hostReference.trim(),
      agents: draft.agents, phases: draft.phases, tools: draft.tools,
      required: draft.required, approval: draft.approval,
      evidence: { captureToolCalls: draft.captureToolCalls, captureResults: draft.captureResults }
    });
  }
  return String(parsed);
}

export function updateAuthorityYaml(text: string, draft: AuthorityDraft | null, deleteId: string | null = null): string {
  const parsed = document(text, 'governed configuration');
  if (deleteId) parsed.deleteIn(['approvalAuthorities', deleteId]);
  if (draft) {
    const errors = validateAuthorityDraft(draft);
    if (errors.length) throw new Error(errors.join(' '));
    const source = parsed.toJS() as { approvalAuthorities?: Record<string, Record<string, unknown>> } | null;
    const previous = source?.approvalAuthorities?.[draft.previousId || draft.id] ?? {};
    if (draft.previousId && draft.previousId !== draft.id) parsed.deleteIn(['approvalAuthorities', draft.previousId]);
    parsed.setIn(['approvalAuthorities', draft.id], {
      ...previous,
      label: draft.label.trim(),
      ...(draft.scope === 'story' ? { allowAnyGitIdentity: draft.allowAnyGitIdentity } : {}),
      members: draft.members.map((entry) => ({
        name: entry.name.trim(), email: entry.email.trim().toLowerCase(),
        ...(draft.scope === 'story' && entry.githubLogin.trim() ? { githubLogin: entry.githubLogin.trim() } : {})
      }))
    });
  }
  return String(parsed);
}

/** Update only guided world-model fields. Advanced context and injection rules remain untouched. */
export function updateWorldModelYaml(text: string, draft: WorldModelDraft): string {
  const parsed = document(text, 'workflow.yml');
  const errors = validateWorldModelDraft(draft);
  if (errors.length) throw new Error(errors.join(' '));
  parsed.setIn(['worldModel', 'views'], draft.views);
  parsed.setIn(['worldModel', 'outputDir'], draft.outputDir.trim());
  parsed.setIn(['worldModel', 'promptSource'], draft.promptSource.trim());
  parsed.setIn(['worldModel', 'stateFetchTimeoutMs'], draft.stateFetchTimeoutMs);
  parsed.setIn(['worldModel', 'generation', 'parallel'], draft.generation.parallel);
  parsed.setIn(['worldModel', 'generation', 'maxWorkers'], draft.generation.maxWorkers);
  parsed.setIn(['worldModel', 'generation', 'strategy'], 'view');
  parsed.setIn(['worldModel', 'materialization', 'mode'], draft.materialization.mode);
  parsed.setIn(['worldModel', 'materialization', 'publish'], draft.materialization.publish);
  parsed.setIn(['worldModel', 'materialization', 'lookahead'], draft.materialization.lookahead);
  parsed.setIn(['worldModel', 'materialization', 'depth'], draft.materialization.depth);
  parsed.setIn(['worldModel', 'materialization', 'confirmation'], draft.materialization.confirmation);
  parsed.setIn(['worldModel', 'grounding'], draft.grounding);
  parsed.setIn(['worldModel', 'staleness'], draft.staleness);
  parsed.setIn(['worldModel', 'injection', 'placeholder'], draft.injection.placeholder);
  parsed.setIn(['worldModel', 'injection', 'mode'], draft.injection.mode);
  parsed.setIn(['worldModel', 'injection', 'maxBytes'], draft.injection.maxBytes);
  return String(parsed);
}
