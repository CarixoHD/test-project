# 3D scene assets

Models for the 3D construction view (ADR 8). Both packs are by Kenney (www.kenney.nl) under
**CC0 1.0** (public domain); each folder keeps its pack's `License.txt` unchanged. The owner
downloaded the packs and supplied them on **2026-11-20**; nothing was downloaded by an agent.
Only the models the scene uses are committed (originals, not recompressed), together with the
`Textures/colormap.png` every GLB of a pack references.

| Folder | Pack | Source |
|---|---|---|
| `mini-characters/` | Mini Characters (2.0) | https://kenney.nl/assets/mini-characters |
| `city-kit-industrial/` | City Kit (Industrial) | https://kenney.nl/assets/city-kit-industrial |

## File → role / piece

Wired up in `../figures.ts` (`CHARACTER_URLS`, `PIECE_URLS`).

| File | Used for |
|---|---|
| `mini-characters/character-male-c.glb` | foreman (orchestrator) |
| `mini-characters/character-worker.glb` | builder (implementer) |
| `mini-characters/character-female-c.glb` | inspector (reviewer) |
| `mini-characters/character-male-e.glb` | drafter (sparring) |
| `mini-characters/Textures/colormap.png` | texture of all characters |
| `city-kit-industrial/building-e.glb` | `wall` piece |
| `city-kit-industrial/building-m.glb` | `window` piece |
| `city-kit-industrial/solar-panel-landscape-group.glb` | `roof` piece (stretched over the footprint) |
| `city-kit-industrial/Textures/colormap.png` | texture of all industrial pieces |

The `floor` piece stays a primitive slab: the kit has no floor tile. Characters play the
pack's `walk`, `idle`, `sit` and `interact-right` (work) clips. While the GLBs load, if they
fail, and in jsdom tests, the scene draws the primitive figures and pieces from `figures.ts`.
