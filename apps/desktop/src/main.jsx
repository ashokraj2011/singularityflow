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
