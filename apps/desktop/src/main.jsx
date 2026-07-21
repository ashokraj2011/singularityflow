import React from 'react';
import { createRoot } from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import App from './App.jsx';
import './styles.css';

loader.config({ monaco });
createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
