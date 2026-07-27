import type { SlotContext } from 'event-horizon/renderer'

import { isFlowWorkspaceContext, type FlowWorkspaceContext } from '@flow/flowContext'

/**
 * Flow's chrome inside Event Horizon's top bar.
 *
 * This used to be a patch to upstream's TopBar.tsx — 26 references to Flow's
 * model in a file we did not own, which is what turned the whole app into a
 * fork. It is now a render function passed through a slot: upstream calls it
 * with the session and whatever opaque context we published for that directory,
 * and knows nothing about what comes back.
 *
 * The type guard runs again here rather than trusting the value across the
 * process boundary. It arrived as `unknown` by design, and a malformed context
 * should render nothing rather than throw inside upstream's render tree.
 */
export function flowTopBar({ hostContext }: SlotContext): React.ReactNode {
  if (!isFlowWorkspaceContext(hostContext)) return null
  const flow: FlowWorkspaceContext = hostContext

  const label = flow.work.id ?? flow.repository.name
  const state = flow.work.phase ?? flow.work.status ?? 'repository'

  return (
    <span
      className="pill"
      title={[
        `Workspace: ${flow.workspace.name}`,
        `Repository: ${flow.repository.name} (${flow.repository.role})`,
        flow.work.title ? `Work: ${flow.work.title}` : null,
        flow.persona ? `Persona: ${flow.persona}` : null,
        flow.documents.length ? `${flow.documents.length} documents` : null
      ]
        .filter(Boolean)
        .join('\n')}
    >
      <span style={{ opacity: 0.65 }}>{flow.workspace.name}</span>
      <strong style={{ fontWeight: 600 }}>{label}</strong>
      <span style={{ opacity: 0.65, fontStyle: 'italic' }}>{state}</span>
      {typeof flow.work.progress === 'number' && (
        <span style={{ opacity: 0.65 }}>{Math.round(flow.work.progress * 100)}%</span>
      )}
    </span>
  )
}
