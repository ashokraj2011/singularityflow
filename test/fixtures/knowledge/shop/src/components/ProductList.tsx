import { useEffect, useState } from 'react';
import { fetchProducts } from '../api/orders';

interface Props { onAdd: (product: { sku: string; name: string; priceCents: number }) => void }

export function ProductList({ onAdd }: Props) {
  const [products, setProducts] = useState<Array<{ sku: string; name: string; priceCents: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchProducts().then(setProducts).catch(() => setError('Products could not be loaded.'));
  }, []);
  if (error) return <p role="alert">{error}</p>;
  return (
    <ul>
      <li>Don't miss today's deals.</li>
      {products.map((product) => (
        <li key={product.sku}>
          {product.name} <button onClick={() => onAdd(product)}>Add</button>
        </li>
      ))}
    </ul>
  );
}
