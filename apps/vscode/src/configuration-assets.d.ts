declare module '*/configuration-assets.mjs' {
  /** Copilot's own agents folder: SFlow's agents on the legacy layout, the team's on the agents home (SPEC-AGH). */
  export const LEGACY_AGENTS_ROOT: '.github/agents';
  /** Where SFlow's step agents live on the agents home (SPEC-AGH). */
  export const AGENTS_HOME: 'singularity/agents';
  export function agentsRootOf(workflow: unknown): '.github/agents' | 'singularity/agents';
  export function isAgentFilePath(relative: unknown): boolean;
  export function agentPathIn(root: string, relative: string): string;
  export function agentFileIn(id: string, root?: string): string;
}
