import { describe, expect, it } from 'vitest';
import { couponDiscount, shipping, total } from '../src/rules/pricing';

const cart = (cents: number) => ({ lines: [{ sku: 'a', name: 'A', priceCents: cents, quantity: 1 }] });

describe('pricing', () => {
  it('ships free at the threshold', () => { expect(shipping(cart(5000))).toBe(0); });
  it('charges shipping below the threshold', () => { expect(shipping(cart(4999))).toBe(499); });
  it('SAVE10 needs more than $30', () => { expect(couponDiscount(cart(3000), 'SAVE10', false)).toBe(0); });
  it('VIP20 refuses non-members', () => { expect(() => couponDiscount(cart(1000), 'VIP20', false)).toThrow(); });
  it('totals with coupon and shipping', () => { expect(total(cart(4000), 'SAVE10', false)).toBe(4000 - 400 + 499); });
});
