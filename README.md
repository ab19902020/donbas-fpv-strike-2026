# DONBAS FPV • 2026

A first-person-view drone strike simulator that runs entirely in the browser.
WebGL, no build step, no external assets — every texture, model, sound and
visual effect is generated procedurally at runtime.

> Fictional simulation. Not a depiction of real people, units or events.

**Play:** open `index.html`, or serve the folder and visit it.

## The mission

You fly for an FPV team on a defensive line. A mechanised push is rolling in:
armour, dug-in air defence, a command post, a supply dump and EW trucks jamming
your video link. You have 24 airframes. Each one is a single strike — fly it
into the target.

| Objective | Count |
|---|---|
| Suppress air defence (ZU-23) | 3 |
| Break the armour column | 4 |
| Destroy the command post | 1 |
| Destroy the ammo depot | 1 |
| Kill an EW jammer | 1 |
| Repel the infantry assault | 6 |

## Controls

**Desktop** — mouse steers, `WASD` / arrows also work, `Shift` or `Space` for
dive boost, `M` mutes.

**Touch** — three flight profiles, selectable on the menu:
- **Direct FPV** — drag anywhere to steer, release to settle
- **Split axis** — left thumb pitches, right thumb yaws
- **V-joystick** — virtual thumbstick on the left half

## What's under the hood

- **Custom render pipeline.** Scene renders into an HDR buffer, a three-octave
  bloom chain runs over it, and a single composite pass does ACES tone mapping
  plus the analog-downlink look: barrel distortion, chromatic aberration,
  scanlines, rolling sync bar, sensor noise, and — as your link degrades —
  horizontal tearing and blocky digital dropout.
- **Deformable terrain.** A 300×300 heightfield with live crater deformation:
  every detonation punches a bowl with an ejecta lip, rewrites the normals and
  burn-scars the vertex colours in place. The battlefield accumulates damage.
- **Link budget as a mechanic.** Range and enemy jammers eat your picture. Lose
  the link for long enough and the airframe is gone.
- **GPU-instanced FX.** Smoke, fire, sparks, dust, tumbling debris and tracers
  are one draw call each, with pooled fireballs, shockwaves and flash lights.
- **Procedural audio.** Motor whine tracks throttle; explosions are filtered
  noise plus a sub thump. No audio files.

## Layout

```
index.html        markup, styling, HUD panels
js/lib.js         math, seeded simplex noise, every procedural texture
js/fx.js          post-processing stack + particle / debris / tracer systems
js/world.js       sky, terrain, set dressing, models, hostile entities
js/hud.js         canvas goggle OSD
js/game.js        flight model, combat, missions, audio, main loop
js/vendor/        three.js r128 (vendored so it runs offline)
```

Debug handles are exposed on `window.G` (`G.drone`, `G.world`, `G.fx`,
`G.post`, `G.terrain`) if you want to poke at it from the console.
