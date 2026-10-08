import { MAX_QUANTITY_PER_LINE } from '../rules/pricing';

export interface CartLine { sku: string; name: string; priceCents: number; quantity: number }
export interface Cart { lines: CartLine[] }

export type CartAction =
  | { type: 'add'; line: Omit<CartLine, 'quantity'> }
  | { type: 'setQuantity'; sku: string; quantity: number }
  | { type: 'remove'; sku: string }
  | { type: 'clear' };

export const emptyCart: Cart = { lines: [] };

export function cartReducer(cart: Cart, action: CartAction): Cart {
  switch (action.type) {
    case 'add': {
      const existing = cart.lines.find((line) => line.sku === action.line.sku);
      if (existing) {
        return cartReducer(cart, { type: 'setQuantity', sku: existing.sku, quantity: existing.quantity + 1 });
      }
      return { lines: [...cart.lines, { ...action.line, quantity: 1 }] };
    }
    case 'setQuantity': {
      const quantity = Math.min(Math.max(action.quantity, 0), MAX_QUANTITY_PER_LINE);
      if (quantity === 0) return cartReducer(cart, { type: 'remove', sku: action.sku });
      return { lines: cart.lines.map((line) => (line.sku === action.sku ? { ...line, quantity } : line)) };
    }
    case 'remove':
      return { lines: cart.lines.filter((line) => line.sku !== action.sku) };
    case 'clear':
      return emptyCart;
  }
}
