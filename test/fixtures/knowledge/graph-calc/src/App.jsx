import React, { useState } from 'react';
import Display from './components/Display.jsx';
import Header from './components/Header.jsx';
import StandardKeypad from './components/StandardKeypad.jsx';
import ScientificKeypad from './components/ScientificKeypad.jsx';
import HistoryDrawer from './components/HistoryDrawer.jsx';
import UnitConverter from './components/UnitConverter.jsx';
import FinancialCalculator from './components/FinancialCalculator.jsx';
import KeyboardShortcutsModal from './components/KeyboardShortcutsModal.jsx';
import { FunctionGrapher } from './FunctionGrapher.jsx';
import { evaluateExpression } from './utils/evaluator.js';
import { playSound } from './utils/audio.js';

export default function App() {
  const [mode, setMode] = useState('standard');
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(true);

  function handleKeyDown(event) {
    if (event.key === 'Enter') {
      playSound('equals', soundEnabled);
      setResult(evaluateExpression(expression));
    }
  }

  return (
    <div onKeyDown={handleKeyDown}>
      <Header mode={mode} onMode={setMode} soundEnabled={soundEnabled} onSound={setSoundEnabled} />
      <Display expression={expression} result={result} soundEnabled={soundEnabled} />
      {mode === 'standard' && <StandardKeypad onPress={setExpression} soundEnabled={soundEnabled} />}
      {mode === 'scientific' && <ScientificKeypad onPress={setExpression} soundEnabled={soundEnabled} />}
      {mode === 'graph' && <FunctionGrapher soundEnabled={soundEnabled} />}
      {mode === 'units' && <UnitConverter soundEnabled={soundEnabled} />}
      {mode === 'finance' && <FinancialCalculator soundEnabled={soundEnabled} />}
      <HistoryDrawer soundEnabled={soundEnabled} />
      <KeyboardShortcutsModal soundEnabled={soundEnabled} />
    </div>
  );
}
