import { useState, type FormEvent } from 'react';
import { submitOrder } from '../api/orders';
import { total, couponDiscount } from '../rules/pricing';
import type { Cart } from '../state/cart';

interface Props { cart: Cart; isMember: boolean; onPlaced: (orderId: string) => void }

export function CheckoutForm({ cart, isMember, onPlaced }: Props) {
  const [coupon, setCoupon] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (cart.lines.length === 0) {
      setError('Your cart is empty.');
      return;
    }
    try {
      couponDiscount(cart, coupon || null, isMember);
    } catch (problem) {
      setError((problem as Error).message);
      return;
    }
    setSubmitting(true);
    try {
      const receipt = await submitOrder(cart, coupon || null);
      onPlaced(receipt.orderId);
    } catch {
      setError('The order could not be placed. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input value={coupon} onChange={(event) => setCoupon(event.target.value)} placeholder="Coupon" />
      <p>Total: {(total(cart, coupon || null, isMember) / 100).toFixed(2)}</p>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>Place order</button>
    </form>
  );
}
