import React from 'react';
import { playSound } from '../utils/audio.js';

export default function FinancialCalculator({ soundEnabled }) {
  function handleFinancialCalculatorClick() {
    playSound('click', soundEnabled);
  }
  return <div><button onClick={handleFinancialCalculatorClick}>FinancialCalculator</button></div>;
}
