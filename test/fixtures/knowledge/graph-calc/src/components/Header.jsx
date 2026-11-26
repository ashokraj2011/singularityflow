import React from 'react';
import { playSound } from '../utils/audio.js';

export default function Header({ soundEnabled }) {
  function handleHeaderClick() {
    playSound('click', soundEnabled);
  }
  return <div><button onClick={handleHeaderClick}>Header</button></div>;
}
