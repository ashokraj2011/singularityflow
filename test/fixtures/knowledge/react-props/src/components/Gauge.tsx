import React from 'react';
import { formatReading } from '../utils/format.js';

interface GaugeProps { value: number | null; unit: string }

export const Gauge: React.FC<GaugeProps> = ({
  value,
  unit,
}: GaugeProps) => (
  <meter value={value ?? 0}>
    {formatReading(value, unit)}
  </meter>
);
