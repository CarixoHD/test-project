import type { ProductState } from '../../../shared/state.ts';
import { HandoffPanel } from './HandoffPanel.tsx';
import { PrdPanel } from './PrdPanel.tsx';
import { SparringChat } from './SparringChat.tsx';

/** Spec tab of a product: the sparring chat next to the live PRD draft, and the handoff. */
export function SpecTab({ product }: { product: ProductState }) {
  return (
    <div className="spec-tab">
      {product.phase === 'sparring' ? <HandoffPanel productId={product.id} /> : null}
      <SparringChat productId={product.id} />
      <PrdPanel productId={product.id} />
    </div>
  );
}
