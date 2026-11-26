import React from 'react';
import { playSound } from '../utils/audio.js';

export default function StandardKeypad({ soundEnabled }) {
  function handleStandardKeypadClick() {
    playSound('click', soundEnabled);
  }
  return <div><button onClick={handleStandardKeypadClick}>StandardKeypad</button></div>;
}
