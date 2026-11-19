import { Link } from 'react-router';
import { useApp } from '../../state/store.ts';

/** `/`: every product. Placeholder until the products feature lands. */
export function ProductsPage() {
  const products = useApp((s) => s.state.products);
  const list = Object.values(products);
  return (
    <>
      <h1>Products</h1>
      {list.length === 0 ? (
        <p>No products yet.</p>
      ) : (
        <ul>
          {list.map((p) => (
            <li key={p.id}>
              <Link to={`/products/${p.id}`}>{p.name}</Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
