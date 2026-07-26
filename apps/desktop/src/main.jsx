import React from 'react';
import { createRoot } from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import App from './App.jsx';
import './styles.css';

loader.config({ monaco });

class DesktopErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, details) {
    console.error('Singularity Desktop renderer failed safely.', error, details);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="desktop-crash">
      <span className="desktop-crash-mark">S</span>
      <p className="eyebrow">Singularity Desktop</p>
      <h1>This screen could not finish loading</h1>
      <p>Your Git repository and Jira state were not changed. Reload the desktop to retry; if the problem continues, copy the diagnostic below.</p>
      <pre>{this.state.error?.stack ?? this.state.error?.message ?? String(this.state.error)}</pre>
      <button className="primary" onClick={() => window.location.reload()}>Reload desktop</button>
    </main>;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DesktopErrorBoundary><App /></DesktopErrorBoundary>
  </React.StrictMode>
);

// Dropping a file anywhere outside a drop target makes the Electron renderer navigate to it,
// replacing the app with the file's contents and losing all in-memory state. Nothing prevented
// that, and adding a drop zone makes a near-miss far more likely.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (event) => {
    if (event.target instanceof Element && event.target.closest('[data-accepts-drop]')) return;
    event.preventDefault();
    if (type === 'drop') event.dataTransfer.dropEffect = 'none';
  });
}
