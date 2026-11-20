import type { ProductState } from '../../../shared/state.ts';

/** Settings tab of a product. Stub: the product settings form replaces it (own file on purpose). */
export function ProductSettingsTab({ product }: { product: ProductState }) {
  return <p>Settings for {product.name} will appear here.</p>;
}
