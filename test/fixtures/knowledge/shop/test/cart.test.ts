import { expect, it } from 'vitest';
import { cartReducer, emptyCart } from '../src/state/cart';

it('caps quantity at ten', () => {
  const one = cartReducer(emptyCart, { type: 'add', line: { sku: 'a', name: 'A', priceCents: 100 } });
  expect(cartReducer(one, { type: 'setQuantity', sku: 'a', quantity: 50 }).lines[0].quantity).toBe(10);
});
