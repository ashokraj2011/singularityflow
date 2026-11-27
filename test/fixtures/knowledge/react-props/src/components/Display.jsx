import React from 'react';
import { formatReading } from '../utils/format.js';

export const Display = ({
  value,
  unit,
  onClear,
}) => {
  const shown = formatReading(value, unit);
  if (shown.length > 12) {
    return <p className="display overflow">{shown}</p>;
  }
  return (
    <p className="display">
      {shown}
      <button onClick={onClear}>Clear</button>
    </p>
  );
};
