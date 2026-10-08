import { request } from './client';
import type { Cart } from '../state/cart';

export interface OrderReceipt { orderId: string; totalCents: number }

export function submitOrder(cart: Cart, couponCode: string | null): Promise<OrderReceipt> {
  return request<OrderReceipt>('/orders', {
    method: 'POST',
    body: JSON.stringify({ lines: cart.lines, couponCode })
  });
}

export function fetchProducts(): Promise<Array<{ sku: string; name: string; priceCents: number }>> {
  return request('/products');
}
