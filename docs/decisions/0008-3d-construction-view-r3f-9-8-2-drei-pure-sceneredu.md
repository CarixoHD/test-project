# 0008. 3D construction view: R3F 9.8.2 + drei, pure sceneReduce, vendored CC0 Kenney assets

Date: 2026-11-19 · Status: Accepted

## Context

The PRD asks for a fun, collapsible 3D view of workers and a growing building. It should hold 60 fps on an integrated GPU with about 10 workers and 100 pieces, and be tested at the event-mapping level.

## Options considered

- **three + @react-three/fiber 9.8.2 + drei, lazy-loaded**: Declarative, integrates with React state; test-renderer is available.
- **Vanilla three.js**: Same performance; imperative glue to React state.
- **Babylon.js / PlayCanvas**: Heavier or editor-centric.

## Decision

src/shared/scene.ts holds the pure `sceneReduce(SceneState, Event)` and `layoutPiece(index, totalIssues)`. Event mapping:
- issue.completed adds a piece.
- agent.spawned and agent.exited add and remove a worker figure; the figure depends on the role.
- question.asked shows a "?" bubble.
- backend.limited sends the worker to the bench.
- issue.failed adds debris, which is removed when the issue is retried or cancelled.
src/web/scene is lazy-loaded (React.lazy) and renders state only:
- one InstancedMesh per piece type
- one SkeletonUtils.clone and mixer per worker
- DPR capped at [1, 1.5], one shadow or ContactShadows, no postprocessing
- frameloop="never" while collapsed or off-screen, with the Canvas kept mounted
- reduced motion respected
Clicking a worker opens the same AgentPanel as the accessible agent list. Assets are CC0 Kenney Mini Characters and building-kit GLBs, compressed with meshopt and vendored with LICENSE.md (source URL and date). Tests are Vitest replays of sceneReduce and a single Playwright render smoke test that checks draw calls are under 60.

## Rationale

This follows the research's high-confidence recommendation. The load (about 60 draw calls) is small. The real risks are remounting the Canvas and asset licensing; the Quaternius license changed in Aug 2026, so we use Kenney CC0. Putting the reducer in shared makes the PRD's event-mapping tests pure unit tests.

## Sources

- [Research: 3D construction view](docs/research/which-approach-gives-a-performant-testable-3d-cons.md)
- [R3F performance pitfalls](https://r3f.docs.pmnd.rs/advanced/pitfalls)
- [Kenney Mini Characters (CC0)](https://kenney.nl/assets/mini-characters)
