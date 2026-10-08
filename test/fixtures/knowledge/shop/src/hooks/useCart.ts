import { useReducer, useCallback } from 'react';
import { cartReducer, emptyCart, type CartLine } from '../state/cart';

export function useCart() {
  const [cart, dispatch] = useReducer(cartReducer, emptyCart);
  const add = useCallback((line: Omit<CartLine, 'quantity'>) => dispatch({ type: 'add', line }), []);
  const setQuantity = useCallback((sku: string, quantity: number) => dispatch({ type: 'setQuantity', sku, quantity }), []);
  const clear = useCallback(() => dispatch({ type: 'clear' }), []);
  return { cart, add, setQuantity, clear };
}
