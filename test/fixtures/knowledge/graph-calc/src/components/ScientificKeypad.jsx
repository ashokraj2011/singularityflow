import React from 'react';
import { playSound } from '../utils/audio.js';

export default function ScientificKeypad({ soundEnabled }) {
  function handleScientificKeypadClick() {
    playSound('click', soundEnabled);
  }
  return <div><button onClick={handleScientificKeypadClick}>ScientificKeypad</button></div>;
}
