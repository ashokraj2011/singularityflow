import * as math from 'mathjs';

export const MAX_DIGITS = 10;

export function formatNumber(value) {
  if (!Number.isFinite(value)) return 'Error';
  return String(Number(value.toPrecision(MAX_DIGITS)));
}

export function evaluateExpression(expression) {
  if (!expression.trim()) return '';
  const result = math.evaluate(expression);
  return formatNumber(result);
}

export function calculateTip(amount, percent) {
  if (amount <= 0) return 0;
  return amount * percent / 100;
}
