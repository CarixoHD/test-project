import { Link } from 'react-router';
import { useApp } from '../../state/store.ts';
import { NewProductForm } from './NewProductForm.tsx';
import { PHASE_LABELS } from './phase.ts';

/** `/`: every product, kept live by the store, and the form to create a new one. */
export function ProductsPage() {
  const products = useApp((s) => s.state.products);
  const list = Object.values(products).sort((a, b) => a.createdAt - b.createdAt);
  return (
    <>
      <h1>Products</h1>
      <section aria-labelledby="products-list-heading">
        <h2 id="products-list-heading">Your products</h2>
        {list.length === 0 ? (
          <p>No products yet.</p>
        ) : (
          <ul aria-label="Products">
            {list.map((p) => (
              <li key={p.id}>
                <Link to={`/products/${p.id}`}>{p.name}</Link> <span>{PHASE_LABELS[p.phase]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <NewProductForm />
    </>
  );
}
