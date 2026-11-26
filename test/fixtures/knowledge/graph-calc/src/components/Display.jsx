import React from 'react';
import { playSound } from '../utils/audio.js';

export default function Display({ soundEnabled }) {
  function handleDisplayClick() {
    playSound('click', soundEnabled);
  }
  return <div><button onClick={handleDisplayClick}>Display</button></div>;
}
