import React from 'react'
import { createRoot } from 'react-dom/client'

import { EventHorizon, electronApi } from 'event-horizon/renderer'
import 'event-horizon/renderer/style.css'
import 'highlight.js/styles/github-dark.css'

import { flowTopBar } from './FlowChrome'

/**
 * Flow's renderer entry. It supplies the same preload-backed API upstream's own
 * entry uses, plus Flow's chrome through a slot — no upstream file is modified.
 */
const api = electronApi()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {api ? (
      <EventHorizon api={api} slots={{ topBarLeading: flowTopBar }} />
    ) : (
      <div style={{ padding: 40, fontFamily: 'system-ui', color: '#d16a63' }}>
        No host API found on the preload bridge — the preload script did not load.
      </div>
    )}
  </React.StrictMode>
)
