/** Read-only, versioned projection from Singularity Flow to Event Horizon. */
export const FLOW_CONTEXT_VERSION = 1 as const

export interface FlowDocumentLink {
  id: string
  label: string
  phase?: string | null
  path: string
  status?: string | null
}

export interface FlowWorkspaceContext {
  version: typeof FLOW_CONTEXT_VERSION
  generatedAt: string
  workspace: { id: string | null; name: string; path: string | null }
  repository: {
    id: string | null
    name: string
    root: string
    branch: string
    role: 'lead' | 'participant' | 'standalone'
  }
  work: {
    kind: 'epic' | 'story' | 'repository'
    id: string | null
    title: string
    phase: string | null
    status: string | null
    progress: number | null
    parentId: string | null
  }
  persona: string | null
  documents: FlowDocumentLink[]
  nextActions: Array<{ label: string; command?: string | null }>
  revision: string | null
}

export function isFlowWorkspaceContext(value: unknown): value is FlowWorkspaceContext {
  if (!value || typeof value !== 'object') return false
  const context = value as Partial<FlowWorkspaceContext>
  return context.version === FLOW_CONTEXT_VERSION
    && typeof context.generatedAt === 'string'
    && !!context.workspace && typeof context.workspace.name === 'string'
    && !!context.repository && typeof context.repository.root === 'string'
    && !!context.work && ['epic', 'story', 'repository'].includes(context.work.kind ?? '')
    && Array.isArray(context.documents) && Array.isArray(context.nextActions)
}
