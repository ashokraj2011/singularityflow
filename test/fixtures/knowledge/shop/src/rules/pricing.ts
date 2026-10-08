import type { Cart } from '../state/cart';

/** Orders at or above this subtotal ship free. */
export const FREE_SHIPPING_THRESHOLD_CENTS = 5000;
export const SHIPPING_CENTS = 499;
export const MAX_QUANTITY_PER_LINE = 10;

export function subtotal(cart: Cart): number {
  return cart.lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
}

export function shipping(cart: Cart): number {
  return subtotal(cart) >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : SHIPPING_CENTS;
}

/** SAVE10 takes 10% off orders over $30; VIP20 takes 20% off for members only. */
export function couponDiscount(cart: Cart, code: string | null, isMember: boolean): number {
  if (!code) return 0;
  const base = subtotal(cart);
  if (code === 'SAVE10' && base >= 3000) return Math.round(base * 0.1);
  if (code === 'VIP20') {
    if (!isMember) throw new Error('VIP20 is for members only');
    return Math.round(base * 0.2);
  }
  return 0;
}

export function total(cart: Cart, code: string | null, isMember: boolean): number {
  return subtotal(cart) - couponDiscount(cart, code, isMember) + shipping(cart);
}
