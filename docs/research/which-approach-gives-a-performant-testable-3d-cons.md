# Which approach gives a performant, testable 3D construction view in the browser: three.js with react-three-fiber/drei, low-poly animated character assets (with licensing, e.g. Kenney or Quaternius), instanced building pieces, and a pure event → scene-state reducer? The target is 60 fps on an integrated GPU with about 10 workers and 100 pieces, with the scene collapsible to stop rendering.

Date: 2026-11-19 · Confidence: high

## Recommendation

Adopt three.js + @react-three/fiber ^9.8.2 (React 19) + drei. Pin versions and lazy-load the 3D view.
- **State:** a pure event → SceneState reducer is the single source of truth and the main test surface (Vitest, no WebGL).
- **Building pieces:** one InstancedMesh per piece type, driven by the reducer state.
- **Workers:** CC0 low-poly characters on a shared rig (Quaternius Universal Base Characters + Universal Animation Library, or Kenney Mini Characters), converted to meshopt-compressed GLB. Clone per worker with SkeletonUtils.clone, each with its own mixer (drei useAnimations).
- **Budget:** under 60 draw calls, DPR capped at 1.5, one shadow or ContactShadows, no postprocessing, PerformanceMonitor for automatic quality downgrade.
- **Collapse:** keep the Canvas mounted and set frameloop="never" when collapsed or off-screen; unmount only when the user leaves the route.
- **Licensing:** vendor the assets with license files and download dates, since Quaternius's QAL (Aug 2026) applies to new releases.
- **Tests:** scene-graph assertions with @react-three/test-renderer; a Playwright check that asserts draw calls and frame time.

## Findings

Verdict: the proposed stack works for this scene size. 10 skinned characters and 100 pieces is a small load. The main risks are how the Canvas is set up and how assets are licensed, not three.js itself. I did not run a benchmark; the performance points below come from documentation and known budgets.

**1. Rendering stack (current versions)**
- @react-three/fiber v9 pairs with React 19; v8 pairs with React 18.
  - 9.7.0 needs React >=19 <19.3 and three >=0.156.
  - 9.8.0 adds React 19.3 compatibility.
  - Pin **>=9.8.2**. Issue #3980: in 9.8.1, removing an object under frameloop="demand" did not trigger a new frame, so it stayed on screen. The fix shipped in 9.8.2.
  - v10 is still alpha (WebGPU by default). Avoid it.
- Fiber's full import is about 238 KB gzipped (third-party measurement), so lazy-load the 3D view.
- Official R3F performance guidance:
  - Keep draw calls to a few hundred at most.
  - Use instancedMesh and share geometries and materials (useLoader/useGLTF cache automatically).
  - Use frameloop="demand" with invalidate(), PerformanceMonitor (onDecline/onIncline, flipflops), and regress()/performance.current for adaptive DPR.
  - Use startTransition for heavy work.

**2. Estimated budget at the target size**
- Building pieces: about 5–15 piece types. Use one InstancedMesh per type (raw instancedMesh or drei Instances/Merged), giving about 10–20 draw calls.
- Workers: about 10 skinned meshes, around 10–30 draw calls depending on how many materials each model has.
- Total: under about 60 draw calls. An integrated GPU handles this easily at 60 fps if the remaining costs stay controlled:
  - DPR capped at [1, 1.5]
  - one directional light with a single small (1024) shadow map, or drei ContactShadows/baked shadows
  - no postprocessing
  - meshopt/Draco-compressed GLB (via gltf-transform)
  - textures shared through one atlas

**3. Animated characters**
- Each worker needs its own skeleton. Load the GLB once with useGLTF, then clone it per worker with SkeletonUtils.clone (three/examples/jsm/utils/SkeletonUtils). A plain .clone() shares the skeleton and breaks animation.
- Give each clone its own AnimationMixer (drei useAnimations). All clones share the same clip objects.
- 10 mixers cost almost nothing. GPU-instancing skinned meshes (vertex animation textures) is only worth it for hundreds of characters.

**4. Asset licensing**
- Kenney: Mini Characters (v2.0, 40 assets, animated), Blocky Characters, and Animated Characters 1/2/3 / Protagonists / Survivors are all CC0, no attribution required. Some older rigged packs appear to be FBX-only, so they would need conversion to GLB in Blender. Kenney's building kits are also CC0 and suit the construction pieces.
- Quaternius: Ultimate Animated Character Pack (52 models, FBX/OBJ/Blend, each with its own rig), Universal Base Characters (Aug 2025, humanoid rig, glTF), and Universal Animation Library 1/2 (120+ clips, retargetable) are CC0. The FAQ still said "All models are under CC0" as of Oct 2026.
- **Risk:** Quaternius published the Quaternius Asset License (QAL v1.0) on 2026-08-28. It governs future releases and is not retroactive. Packs released after Aug 2026 may not be CC0.
  - Mitigation: vendor the specific CC0 pack versions into the repo with a LICENSE/README recording the source URL and download date.
  - Prefer one shared rig, e.g. Quaternius Universal Base Characters + Universal Animation Library, or Kenney Mini Characters, so idle/walk/work clips work on every worker.

**5. Testable architecture**
- A pure reducer `(SceneState, Event) => SceneState` holds:
  - workers: id, position/target, current activity/clip
  - pieces: id, type, slot, progress/state
- Rendering only reads this state:
  - Pieces → one InstancedMesh per type, with matrices written in useLayoutEffect/useFrame and instanceMatrix.needsUpdate set.
  - Workers → a cloned GLB that blends between clips.
  - Tweening and interpolation live in the view (useFrame); targets come from the reducer.
- Tests:
  - (a) Plain Vitest unit and property tests on the reducer and on event-sequence replays. No WebGL needed; this is where the PRD's behaviour gets tested.
  - (b) @react-three/test-renderer (latest stable 9.1.1) asserts the scene graph without WebGL, e.g. instance count equals the number of pieces and there is one mesh per worker. There have been older Vitest quirks (vitest#4207, constructor equality), so keep these tests few.
  - (c) A Playwright smoke/perf test in a real browser that reads gl.info.render.calls/triangles plus a frame-time sample (r3f-perf or a custom useFrame sampler), with a CI threshold on draw calls rather than raw fps.

**6. Collapsing the scene**
- Don't unmount and remount the Canvas on every toggle. That rebuilds the WebGL context and reloads assets, browsers cap the number of live contexts (about 16), and context loss can occur.
- Instead, keep it mounted and switch frameloop: "always" while expanded and animating, "never" (or "demand" when idle) while collapsed. Also hide it with CSS.
- Also pause when the canvas is off-screen (IntersectionObserver); hidden tabs already stop requestAnimationFrame.
- Unmount completely only when the user leaves the route, so the GPU memory is freed.
- Note: frameloop="demand" saves battery but does not help while workers are animating. Use it only for idle states.

**Alternatives considered**
- Vanilla three.js gives the same performance but loses declarative React integration and test-renderer scene assertions.
- Babylon.js is heavier and fits the React app less well.
- PlayCanvas is editor-centric.
- None beats R3F for a React product at this scale.

## Sources

- [R3F Scaling performance docs](https://r3f.docs.pmnd.rs/advanced/scaling-performance)
- [R3F issue #3980 demand unmount regression (fixed 9.8.2)](https://github.com/pmndrs/react-three-fiber/issues/3980)
- [react-three-fiber review (version pairing, bundle size)](https://hysenlabs.com/en/projects/pmndrs-react-three-fiber)
- [R3F Testing docs](https://r3f.docs.pmnd.rs/api/testing)
- [@react-three/test-renderer npm](https://www.npmjs.com/package/@react-three/test-renderer)
- [Vitest issue #4207 test-renderer](https://github.com/vitest-dev/vitest/issues/4207)
- [Kenney Mini Characters](https://kenney.nl/assets/mini-characters)
- [Kenney Animated Characters Protagonists](https://kenney.nl/assets/animated-characters-protagonists)
- [Kenney Animated Characters 3 (itch.io, CC0)](https://kenney-assets.itch.io/animated-characters-3)
- [Quaternius Universal Base Characters](https://quaternius.com/packs/universalbasecharacters.html)
- [Quaternius Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html)
- [Quaternius Ultimate Animated Character Pack catalog entry (CC0, QAL note)](https://tmhsdigital.github.io/Free-Game-Dev-Assets/entry/quaternius-ultimate-animated-character-pack/)
