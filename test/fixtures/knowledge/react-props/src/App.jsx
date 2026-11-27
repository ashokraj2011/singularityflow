import React, { useState } from 'react';
import { Display } from './components/Display.jsx';
import { Gauge } from './components/Gauge.tsx';

export default function App() {
  const [value, setValue] = useState(null);
  return (
    <main>
      <Display value={value} unit="kPa" onClear={() => setValue(null)} />
      <Gauge value={value} unit="kPa" />
    </main>
  );
}
