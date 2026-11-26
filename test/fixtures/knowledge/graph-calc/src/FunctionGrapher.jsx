import React, { useState } from 'react';
import * as math from 'mathjs';

export const FunctionGrapher = ({ soundEnabled }) => {
  const [equation, setEquation] = useState('sin(x)');
  const [points, setPoints] = useState([]);

  return (
    <div data-sound={soundEnabled}>
      <input value={equation} onChange={(event) => setEquation(event.target.value)} />
      <button onClick={() => setPoints([-1, 0, 1].map((x) => math.evaluate(equation, { x })))}>Plot</button>
      <svg>{points.map((y, index) => <circle key={index} cx={index * 10} cy={y * 10} r={2} />)}</svg>
    </div>
  );
};
