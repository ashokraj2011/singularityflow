import { describe, expect, it } from 'vitest';
import { evaluateExpression, formatNumber } from './evaluator.js';

describe('evaluator', () => {
  it('adds two numbers', () => { expect(evaluateExpression('2+3')).toBe('5'); });
  it('formats to ten digits', () => { expect(formatNumber(1 / 3)).toBe('0.3333333333'); });
});
