import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type RefObject,
} from 'react';
import { sceneFromState, type SceneState } from '../../shared/scene.ts';
import type { ProductState } from '../../shared/state.ts';
import { useApp, type AppSnapshot } from '../state/store.ts';
import { sceneFrameloop, type Scene3DProps } from './scene-model.ts';

/** Whether the owner collapsed the 3D view; one choice for every product. */
export const COLLAPSED_STORAGE_KEY = 'vibecode.scene.collapsed';

/** The WebGL scene in its own chunk (ADR 8): three.js loads only when the view is shown. */
export const LazyScene3D = lazy(() => import('./Scene3D.tsx'));

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Storage may be unavailable (private mode); the choice then lasts for this page only.
  }
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const mql = window.matchMedia(REDUCED_MOTION);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches;

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
}

/** True while the element is (partly) in the viewport; true where IntersectionObserver is missing. */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last !== undefined) setOnScreen(last.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}

const selectState = (s: AppSnapshot) => s.state;

/**
 * This product's scene from the live state (sceneFromState ≡ replaying sceneReduce, tested in
 * shared). Most events (log lines, usage) leave the scene unchanged; the memo key then stays
 * the same and the 3D view does not re-render.
 */
function useScene(productId: ProductState['id']): SceneState {
  const state = useApp(selectState);
  const key = JSON.stringify(sceneFromState(state, productId));
  return useMemo(() => JSON.parse(key) as SceneState, [key]);
}

/** Collapsible 3D construction-site view (ARCHITECTURE §4.12, ADR 8). */
export function ScenePanel({
  product,
  Scene = LazyScene3D,
}: {
  product: ProductState;
  /** The WebGL scene; tests pass a stand-in because jsdom has no WebGL. */
  Scene?: ComponentType<Scene3DProps>;
}) {
  const [expanded, setExpanded] = useState(() => !readCollapsed());
  // Load the scene on first expand, then keep it mounted: remounting a Canvas is expensive.
  const [loaded, setLoaded] = useState(expanded);
  const viewport = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(viewport);
  const reducedMotion = usePrefersReducedMotion();
  const scene = useScene(product.id);
  const bodyId = useId();

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) setLoaded(true);
    writeCollapsed(!next);
  };

  return (
    <section className="build-tab__slot scene-panel" aria-label="3D view">
      <h2 className="scene-panel__title">
        <button
          type="button"
          className="scene-panel__toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <span aria-hidden="true" className="scene-panel__chevron">
            {expanded ? '▾' : '▸'}
          </span>
          3D view
        </button>
      </h2>
      <div id={bodyId} className="scene-panel__body" hidden={!expanded}>
        <p className="scene-panel__note">
          A picture of the work in progress. The board and the agent list show the same information
          as text.
        </p>
        <div ref={viewport} className="scene-panel__viewport" aria-hidden="true">
          {loaded && (
            <Suspense fallback={<p className="scene-panel__loading">Loading the 3D view…</p>}>
              <MemoScene
                Scene={Scene}
                scene={scene}
                frameloop={sceneFrameloop({ expanded, onScreen, reducedMotion })}
                reducedMotion={reducedMotion}
              />
            </Suspense>
          )}
        </div>
      </div>
    </section>
  );
}

/** Re-renders the scene only when its props change, not on every panel render. */
const MemoScene = memo(function MemoScene({
  Scene,
  ...props
}: Scene3DProps & { Scene: ComponentType<Scene3DProps> }) {
  return <Scene {...props} />;
});
