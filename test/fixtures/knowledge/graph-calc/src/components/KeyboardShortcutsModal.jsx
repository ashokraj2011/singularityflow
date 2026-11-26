import React from 'react';
import { playSound } from '../utils/audio.js';

export default function KeyboardShortcutsModal({ soundEnabled }) {
  function handleKeyboardShortcutsModalClick() {
    playSound('click', soundEnabled);
  }
  return <div><button onClick={handleKeyboardShortcutsModalClick}>KeyboardShortcutsModal</button></div>;
}
