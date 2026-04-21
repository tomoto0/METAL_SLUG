# CLAUDE.md

## Run

Use a local HTTP server (ES modules require http/https):

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`.

No build/lint/test pipeline. Runtime is browser + Three.js via `index.html` importmap.

## Architecture (current)

- `js/main.js`: composition root (scene/camera/renderer/game loop).
- `js/World.js`: scrolling desert world + chunked prop generation.
- `js/GameManager.js`: waves, spawn, collisions, score, cleanup.
- `js/Player.js`: SV-001 tank player (aim/shoot/movement/effects).
- `js/Marco.js`: on-foot mode (toggle with `Q` in main loop).
- `js/Enemy*.js`, `js/Boss.js`: enemy/boss behavior and models.
- `js/UIManager.js`: HUD, combo, kill feed, overlays.

## Gameplay model

- Forward auto-scroll on `+Z` (`scrollZ` driven in `main.js`).
- Camera is 3/4 chase view from behind/above.
- Player moves mainly on `X`, with limited local `Z` offset around `scrollZ`.
- Enemies spawn mostly ahead (`+Z`), some behind (`-Z`).

## Core update contract

- `player.update(dt, input, elapsedTime)` (or `marco.update(dt, input, scrollZ)` in foot mode)
- `gameManager.update(dt, activeEntity, elapsedTime)`
- `world.update(dt, scrollZ)`
- `uiManager.update(dt, gameManager, activeEntity)`

## Background rendering

- `World` supports `backgroundPhotoUrl` option.
- Same photo texture can be used for sky + foreground walls (full-screen desert look).
- If image loading fails, procedural sky remains as fallback.

## Memory/cleanup rules

- Objects that allocate meshes/materials should implement `destroy()` and dispose resources.
- `GameManager` runs periodic cleanup (`cleanupTimer`) for enemies, projectiles, effects, items, POW.
- Non-active character projectiles/effects are purged in `main.js` to prevent accumulation.
- `Explosion` uses shared geometry cache (`_geoCache`): do not dispose cached shared geometries.

## Coordinate/orientation notes

- World forward is `+Z`, lateral is `X`, height is `Y`.
- Player visual baseline uses `visualGroup.rotation.y = -Math.PI / 2` so local `+X` faces world `+Z`.
- Enemy aiming/rotation logic assumes local `+X` is model forward.

## Practical edit guidance

- Keep changes local and surgical; this is plain ES module code (no framework).
- Prefer reusing existing helper patterns (`destroy`, cleanup loops, hit-sphere helpers).
- When adding visual objects, ensure they are removed/disposed in reset or cleanup paths.
