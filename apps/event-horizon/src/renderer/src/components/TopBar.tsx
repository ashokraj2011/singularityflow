import { useEffect, useRef, useState } from 'react'

import type { SessionSnapshot } from '@shared/ipc'
import { formatTokens } from '@shared/contextInfo'
import { useStore } from '../store'
import { ContextPanel } from './ContextPanel'

export function TopBar({ session }: { session: SessionSnapshot }): React.JSX.Element {
  const setConfigOption = useStore((s) => s.setConfigOption)
  const restartSession = useStore((s) => s.restartSession)
  const runCommand = useStore((s) => s.runCommand)
  const refreshContext = useStore((s) => s.refreshContext)
  const flowContext = useStore((s) => s.flowContexts[session.cwd])

  const [menuOpen, setMenuOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [flowPanelOpen, setFlowPanelOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const allowAllOption = session.configOptions.find((o) => o.id === 'allow_all')
  const allowAllOn = allowAllOption?.currentValue === 'on'
  const ctx = session.context
  const home = session.cwd.replace(/^\/Users\/[^/]+/, '~')
  const busy = session.status === 'busy'

  const act = (fn: () => void): void => {
    setMenuOpen(false)
    fn()
  }

  return (
    <header className="topbar">
      <span className={`dot ${session.status}`} />
      <span className="cwd" title={session.cwd}>
        {home}
      </span>
      {flowContext && (
        <button className="flow-current-work" title="Show current Singularity Flow work" onClick={() => setFlowPanelOpen(true)}>
          <span>{flowContext.workspace.name}</span>
          <strong>{flowContext.work.id ?? flowContext.repository.name}</strong>
          <i>{flowContext.work.phase ?? flowContext.work.status ?? 'repository'}</i>
          {flowContext.work.progress != null && <em>{flowContext.work.progress}%</em>}
        </button>
      )}

      <span className="spacer" />

      {ctx && (
        <button
          className="meter"
          title={`Context: ${formatTokens(ctx.usedTokens)} of ${formatTokens(
            ctx.totalTokens
          )} tokens (${ctx.percent}%). Click for the breakdown.`}
          onClick={() => setPanelOpen(true)}
        >
          <span className="meter-bar">
            <span
              className={`meter-fill ${ctx.percent >= 80 ? 'hot' : ctx.percent >= 60 ? 'warm' : ''}`}
              style={{ width: `${Math.min(100, Math.max(2, ctx.percent))}%` }}
            />
          </span>
          <span className="meter-label">
            {formatTokens(ctx.usedTokens)}/{formatTokens(ctx.totalTokens)}
          </span>
        </button>
      )}

      {allowAllOption && (
        <button
          className={`pill toggle ${allowAllOn ? 'on' : ''}`}
          title={
            allowAllOption.description ??
            'Approve all tool, path, and URL requests without asking'
          }
          onClick={() => void setConfigOption('allow_all', allowAllOn ? 'off' : 'on')}
        >
          {allowAllOn ? 'Allow all: on' : 'Allow all'}
        </button>
      )}

      <div className="menu-wrap" ref={menuRef}>
        <button
          className="icon-btn"
          title="Session actions"
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="drop">
            <div className="drop-label">Context</div>
            <button className="menu-item" onClick={() => act(() => setPanelOpen(true))}>
              Show context breakdown
            </button>
            <button
              className="menu-item"
              disabled={busy}
              onClick={() => act(() => void refreshContext())}
            >
              Refresh usage
            </button>
            <button
              className="menu-item"
              disabled={busy}
              title="Ask the agent to summarize the conversation so far, freeing context"
              onClick={() => act(() => void runCommand('/compact'))}
            >
              Compact conversation
            </button>

            <div className="drop-sep" />
            <div className="drop-label">Agent memory</div>
            <button
              className="menu-item"
              disabled={busy}
              onClick={() => act(() => void runCommand('/memory show'))}
            >
              Show memory status
            </button>
            <button
              className="menu-item"
              disabled={busy}
              onClick={() => act(() => void runCommand('/memory on'))}
            >
              Enable memory
            </button>
            <button
              className="menu-item"
              disabled={busy}
              onClick={() => act(() => void runCommand('/memory off'))}
            >
              Disable memory
            </button>

            <div className="drop-sep" />
            <div className="drop-label">Session</div>
            <button
              className="menu-item"
              title="Close this session and open a new one on the same folder. Clears all agent context."
              onClick={() => act(() => void restartSession())}
            >
              Start fresh session
            </button>
          </div>
        )}
      </div>

      {panelOpen && <ContextPanel session={session} onClose={() => setPanelOpen(false)} />}
      {flowPanelOpen && flowContext && (
        <div className="overlay" onMouseDown={() => setFlowPanelOpen(false)}>
          <div className="sheet flow-work-sheet" onMouseDown={(event) => event.stopPropagation()}>
            <div className="sheet-head"><span>Current Flow work</span><button className="icon-btn" onClick={() => setFlowPanelOpen(false)}>✕</button></div>
            <div className="sheet-body">
              <div className="flow-work-title"><small>{flowContext.work.kind}</small><h2>{flowContext.work.id ?? flowContext.repository.name}</h2><p>{flowContext.work.title}</p></div>
              <dl className="flow-work-details">
                <div><dt>Workspace</dt><dd>{flowContext.workspace.name}</dd></div>
                <div><dt>Repository</dt><dd>{flowContext.repository.name} · {flowContext.repository.branch}</dd></div>
                <div><dt>Phase</dt><dd>{flowContext.work.phase ?? 'Not in a governed phase'}</dd></div>
                <div><dt>Status</dt><dd>{flowContext.work.status ?? 'Repository context'}</dd></div>
                {flowContext.work.parentId && <div><dt>Parent</dt><dd>{flowContext.work.parentId}</dd></div>}
                <div><dt>Persona</dt><dd>{flowContext.persona ?? 'Not selected'}</dd></div>
                <div><dt>Progress</dt><dd>{flowContext.work.progress == null ? 'Unavailable' : `${flowContext.work.progress}%`}</dd></div>
                <div><dt>Revision</dt><dd>{flowContext.revision?.slice(0, 12) ?? 'Unavailable'}</dd></div>
              </dl>
              <div className="sheet-sep" />
              <div className="sheet-row-head"><span>Governed documents · {flowContext.documents.length}</span></div>
              <div className="flow-work-list">{flowContext.documents.length ? flowContext.documents.map((document) => <div key={document.id}><strong>{document.label}</strong><span>{document.phase ?? 'supporting'} · {document.status ?? 'recorded'}</span><code>{document.path}</code></div>) : <p>No governed documents in this projection.</p>}</div>
              <div className="sheet-sep" />
              <div className="sheet-row-head"><span>Next valid actions</span></div>
              <div className="flow-work-list">{flowContext.nextActions.length ? flowContext.nextActions.map((item, index) => <div key={`${item.label}:${index}`}><strong>{item.label}</strong>{item.command && <code>{item.command}</code>}</div>) : <p>No next action reported.</p>}</div>
              <small className="flow-work-captured">Read-only snapshot captured {new Date(flowContext.generatedAt).toLocaleString()}.</small>
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
