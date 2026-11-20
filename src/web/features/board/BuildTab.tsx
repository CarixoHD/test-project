import type { ProductState } from '../../../shared/state.ts';
import { useApp } from '../../state/store.ts';
import { ScenePanel } from '../../scene/ScenePanel.tsx';
import { AgentList } from '../agents/AgentList.tsx';
import { BackendStatus } from '../products/BackendStatus.tsx';
import { BuildControls } from '../products/BuildControls.tsx';
import { CostBar } from '../products/CostBar.tsx';
import { Board } from './Board.tsx';

/**
 * Build tab of a product. Each slot is its own component file so the issues that fill them
 * (controls, costs, agents, 3D view, backend status) change one file each.
 */
export function BuildTab({ product }: { product: ProductState }) {
  const preview = useApp((s) => s.state.previews[product.id]);
  return (
    <div className="build-tab">
      <div className="build-tab__toolbar">
        <BuildControls product={product} preview={preview} />
        <CostBar product={product} />
        <BackendStatus product={product} />
      </div>
      <div className="build-tab__main">
        <Board product={product} />
        <div className="build-tab__side">
          <AgentList product={product} />
          <ScenePanel product={product} />
        </div>
      </div>
    </div>
  );
}
