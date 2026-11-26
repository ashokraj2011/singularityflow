import React from 'react';
import { playSound } from '../utils/audio.js';

export default function UnitConverter({ soundEnabled }) {
  function handleUnitConverterClick() {
    playSound('click', soundEnabled);
  }
  return <div><button onClick={handleUnitConverterClick}>UnitConverter</button></div>;
}
