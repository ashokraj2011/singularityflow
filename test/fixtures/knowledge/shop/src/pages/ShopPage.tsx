import { useNavigate } from 'react-router-dom';
import { ProductList } from '../components/ProductList';
import { CheckoutForm } from '../components/CheckoutForm';
import { useCart } from '../hooks/useCart';

export function ShopPage({ isMember }: { isMember: boolean }) {
  const { cart, add, clear } = useCart();
  const navigate = useNavigate();
  return (
    <main>
      <ProductList onAdd={add} />
      <CheckoutForm cart={cart} isMember={isMember} onPlaced={(orderId) => { clear(); navigate(`/orders/${orderId}`); }} />
    </main>
  );
}
