import type { ProductState } from '../../../shared/state.ts';
import { ApplyChangesPanel } from './ApplyChangesPanel.tsx';
import { HandoffPanel } from './HandoffPanel.tsx';
import { PrdPanel } from './PrdPanel.tsx';
import { SparringChat } from './SparringChat.tsx';

/**
 * Spec tab of a product: the sparring chat next to the live PRD draft. Before handoff it offers
 * the handoff; afterwards sparring stays available and changes to the draft can be applied.
 */
export function SpecTab({ product }: { product: ProductState }) {
  return (
    <div className="spec-tab">
      {product.phase === 'sparring' ? (
        <HandoffPanel productId={product.id} />
      ) : (
        <ApplyChangesPanel productId={product.id} />
      )}
      <SparringChat productId={product.id} />
      <PrdPanel productId={product.id} />
    </div>
  );
}
