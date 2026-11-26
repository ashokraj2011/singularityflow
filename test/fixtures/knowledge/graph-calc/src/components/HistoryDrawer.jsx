import React from 'react';
import { playSound } from '../utils/audio.js';

export default function HistoryDrawer({ soundEnabled }) {
  function handleHistoryDrawerClick() {
    playSound('click', soundEnabled);
  }
  return <div><button onClick={handleHistoryDrawerClick}>HistoryDrawer</button></div>;
}
