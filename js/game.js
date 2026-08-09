/* =========================================================================
   DONBAS FPV 2026 — game.js
   Renderer bootstrap, flight model, combat resolution, mission logic,
   procedural audio and the main loop.
   ========================================================================= */
(function () {
  'use strict';
  const G = window.G;
  const M = G.M;
  const V3 = THREE.Vector3;

  /* =====================================================================
     CONFIG
     ===================================================================== */
  const CFG = {
    worldSize: 2600,
    worldSeg: 300,
    swarm: 24,
    cruise: 92,          // m/s
    boostSpeed: 168,
    strikeDamage: 100,
    blastRadius: 16,
    batteryTime: 105,    // seconds per airframe
    launch: new V3(0, 0, 980),
    launchAlt: 120,
  };

  const state = {
    mode: 'menu',
    ctrl: 'arcade',
    invertY: false,
    turbulence: true,
    strikes: 0,
    launched: 0,
    lost: 0,
    score: 0,
    hits: 0,
    time: 0,
    quality: 1,
  };
  G.state = state;

  /* =====================================================================
     PROCEDURAL AUDIO — no assets, all synthesised
     ===================================================================== */
  const Audio = {
    ready: false,
    init() {
      if (this.ready) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(ctx.destination);

      // pink-ish noise buffer reused by every one-shot
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.074; b2 = 0.95 * b2 + w * 0.155;
        d[i] = (b0 + b1 + b2 + w * 0.06) * 0.4;
      }
      this.noise = buf;

      // motor: two detuned saws through a bandpass, driven by throttle
      this.motorGain = ctx.createGain();
      this.motorGain.gain.value = 0;
      const filt = ctx.createBiquadFilter();
      filt.type = 'bandpass'; filt.frequency.value = 900; filt.Q.value = 1.4;
      this.motorFilter = filt;
      this.motorOsc = [];
      for (let i = 0; i < 3; i++) {
        const o = ctx.createOscillator();
        o.type = i === 2 ? 'square' : 'sawtooth';
        o.frequency.value = 180 + i * 7;
        const g = ctx.createGain();
        g.gain.value = i === 2 ? 0.12 : 0.3;
        o.connect(g); g.connect(filt);
        o.start();
        this.motorOsc.push(o);
      }
      filt.connect(this.motorGain);
      this.motorGain.connect(this.master);

      // wind noise layer
      const wsrc = ctx.createBufferSource();
      wsrc.buffer = buf; wsrc.loop = true;
      const wf = ctx.createBiquadFilter();
      wf.type = 'lowpass'; wf.frequency.value = 700;
      this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
      wsrc.connect(wf); wf.connect(this.windGain); this.windGain.connect(this.master);
      wsrc.start();
      this.ready = true;
    },
    resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
    motor(throttle, on) {
      if (!this.ready) return;
      const t = this.ctx.currentTime;
      this.motorGain.gain.setTargetAtTime(on ? 0.16 : 0, t, 0.08);
      this.windGain.gain.setTargetAtTime(on ? 0.05 + throttle * 0.16 : 0, t, 0.1);
      const f = 150 + throttle * 420;
      for (let i = 0; i < this.motorOsc.length; i++) {
        this.motorOsc[i].frequency.setTargetAtTime(f * (1 + i * 0.037), t, 0.06);
      }
      this.motorFilter.frequency.setTargetAtTime(700 + throttle * 1500, t, 0.1);
    },
    boom(power, dist) {
      if (!this.ready) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const att = M.clamp(1 - dist / 1400, 0.04, 1);
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.35 + Math.random() * 0.25;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1800 - Math.min(power, 30) * 30, t);
      lp.frequency.exponentialRampToValueAtTime(90, t + 0.9);
      const g = ctx.createGain();
      const vol = M.clamp(power / 16, 0.15, 1.2) * att;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1 + power * 0.02);
      // sub thump
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(90, t);
      o.frequency.exponentialRampToValueAtTime(26, t + 0.55);
      const og = ctx.createGain();
      og.gain.setValueAtTime(vol * 0.85, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      src.connect(lp); lp.connect(g); g.connect(this.master);
      o.connect(og); og.connect(this.master);
      src.start(t); src.stop(t + 2);
      o.start(t); o.stop(t + 0.8);
    },
    crack(dist) {
      if (!this.ready) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 1.6 + Math.random() * 0.6;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 900;
      const g = ctx.createGain();
      const vol = M.clamp(1 - dist / 400, 0, 1) * 0.22;
      if (vol <= 0.002) return;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      src.connect(hp); hp.connect(g); g.connect(this.master);
      src.start(t); src.stop(t + 0.15);
    },
    beep(freq, dur, vol) {
      if (!this.ready) return;
      const ctx = this.ctx, t = ctx.currentTime;
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.07, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.1));
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + (dur || 0.1) + 0.05);
    },
  };
  G.Audio = Audio;

  /* =====================================================================
     INPUT
     ===================================================================== */
  const input = {
    x: 0, y: 0,           // -1..1 stick
    boost: false,
    active: false,
    keys: {},
    mouse: { x: 0, y: 0, inside: false },
    pointers: {},
  };

  function setupInput() {
    const area = document.getElementById('touch-area');
    const joyBase = document.getElementById('joy-base');
    const joyStick = document.getElementById('joy-stick');
    const lTrack = document.getElementById('split-left-track');
    const lKnob = document.getElementById('split-left-knob');
    const rTrack = document.getElementById('split-right-track');
    const rKnob = document.getElementById('split-right-knob');
    const cross = document.getElementById('arcade-crosshair');

    let origin = null;
    let splitL = null, splitR = null;

    function show(el, x, y) {
      el.style.display = 'block';
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    }
    function hideAll() {
      [joyBase, lTrack, rTrack, cross].forEach((e) => (e.style.display = 'none'));
    }
    G.hideControls = hideAll;

    area.addEventListener('pointerdown', (e) => {
      if (state.mode !== 'fly') return;
      area.setPointerCapture(e.pointerId);
      const x = e.clientX, y = e.clientY;
      if (state.ctrl === 'arcade') {
        origin = { id: e.pointerId, x, y };
        input.active = true;
        show(cross, x, y);
      } else if (state.ctrl === 'joystick') {
        if (x < window.innerWidth * 0.62) {
          origin = { id: e.pointerId, x, y };
          input.active = true;
          show(joyBase, x, y);
          joyStick.style.left = '50%'; joyStick.style.top = '50%';
        }
      } else {
        if (x < window.innerWidth * 0.5) {
          splitL = { id: e.pointerId, y };
          show(lTrack, x, y);
          lKnob.style.left = '50%'; lKnob.style.top = '50%';
        } else {
          splitR = { id: e.pointerId, x };
          show(rTrack, x, y);
          rKnob.style.left = '50%'; rKnob.style.top = '50%';
        }
        input.active = true;
      }
      e.preventDefault();
    }, { passive: false });

    area.addEventListener('pointermove', (e) => {
      if (state.mode !== 'fly') return;
      const x = e.clientX, y = e.clientY;
      if (state.ctrl === 'arcade' && origin && origin.id === e.pointerId) {
        const R = Math.min(window.innerWidth, window.innerHeight) * 0.24;
        input.x = M.clamp((x - origin.x) / R, -1, 1);
        input.y = M.clamp((y - origin.y) / R, -1, 1);
        show(cross, origin.x + input.x * R, origin.y + input.y * R);
      } else if (state.ctrl === 'joystick' && origin && origin.id === e.pointerId) {
        const R = 78;
        let dx = x - origin.x, dy = y - origin.y;
        const d = Math.hypot(dx, dy);
        if (d > R) { dx *= R / d; dy *= R / d; }
        input.x = dx / R; input.y = dy / R;
        joyStick.style.left = 50 + (dx / R) * 42 + '%';
        joyStick.style.top = 50 + (dy / R) * 42 + '%';
      } else if (state.ctrl === 'split') {
        if (splitL && splitL.id === e.pointerId) {
          const R = 92;
          input.y = M.clamp((y - splitL.y) / R, -1, 1);
          lKnob.style.top = 50 + input.y * 42 + '%';
        } else if (splitR && splitR.id === e.pointerId) {
          const R = 92;
          input.x = M.clamp((x - splitR.x) / R, -1, 1);
          rKnob.style.left = 50 + input.x * 42 + '%';
        }
      }
      e.preventDefault();
    }, { passive: false });

    function release(e) {
      if (origin && origin.id === e.pointerId) {
        origin = null; input.x = 0; input.y = 0; input.active = false;
        cross.style.display = 'none'; joyBase.style.display = 'none';
      }
      if (splitL && splitL.id === e.pointerId) { splitL = null; input.y = 0; lTrack.style.display = 'none'; }
      if (splitR && splitR.id === e.pointerId) { splitR = null; input.x = 0; rTrack.style.display = 'none'; }
      if (!origin && !splitL && !splitR) input.active = false;
    }
    area.addEventListener('pointerup', release);
    area.addEventListener('pointercancel', release);

    // desktop: mouse steers from screen centre, keys as backup
    window.addEventListener('mousemove', (e) => {
      input.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      input.mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
      input.mouse.inside = true;
    });
    window.addEventListener('keydown', (e) => {
      input.keys[e.code] = true;
      if (e.code === 'Space') e.preventDefault();
      if (e.code === 'KeyM') { Audio.master.gain.value = Audio.master.gain.value > 0 ? 0 : 0.6; }
    });
    window.addEventListener('keyup', (e) => { input.keys[e.code] = false; });

    const bb = document.getElementById('boost-btn');
    const down = (v) => (e) => { input.boost = v; e.preventDefault(); };
    bb.addEventListener('pointerdown', down(true));
    bb.addEventListener('pointerup', down(false));
    bb.addEventListener('pointerleave', down(false));
  }

  function readStick() {
    let x = input.x, y = input.y;
    const k = input.keys;
    if (k.KeyA || k.ArrowLeft) x -= 1;
    if (k.KeyD || k.ArrowRight) x += 1;
    if (k.KeyW || k.ArrowUp) y -= 1;
    if (k.KeyS || k.ArrowDown) y += 1;
    // mouse steering on desktop when no touch input is active
    if (!input.active && !G.isTouch && input.mouse.inside) {
      x += input.mouse.x * 0.95;
      y += input.mouse.y * 0.95;
    }
    x = M.clamp(x, -1, 1); y = M.clamp(y, -1, 1);
    if (state.invertY) y = -y;
    return { x, y, boost: input.boost || !!k.Space || !!k.ShiftLeft };
  }

  /* =====================================================================
     DRONE
     ===================================================================== */
  class Drone {
    constructor() { this.reset(); }
    reset() {
      this.pos = CFG.launch.clone();
      this.pos.y = G.terrain.heightAt(this.pos.x, this.pos.z) + CFG.launchAlt;
      this.vel = new V3(0, 0, -CFG.cruise);
      this.yaw = 0;            // nose on the enemy line (-Z)
      this.pitch = -0.05;
      this.roll = 0;
      this.alive = true;
      this.battery = 1;
      this.signal = 1;
      this.hp = 100;
      this.boostHeat = 0;
      this.linkLostT = 0;
      this.age = 0;
      this.q = new THREE.Quaternion();
      this.fwd = new V3(0, 0, -1);
    }
    update(dt, stick) {
      this.age += dt;
      const boost = stick.boost && this.boostHeat < 1;
      const targetSpeed = boost ? CFG.boostSpeed : CFG.cruise;
      this.boostHeat = M.clamp(this.boostHeat + (boost ? dt * 0.26 : -dt * 0.42), 0, 1);
      this.boostAmt = M.damp(this.boostAmt || 0, boost ? 1 : 0, 6, dt);

      // rate control — FPV quads are rate machines, not attitude machines
      const authority = 1 - 0.25 * this.boostAmt;
      const yawRate = -stick.x * 1.95 * authority;
      const pitchRate = -stick.y * 1.75 * authority;

      this.yaw += yawRate * dt;
      this.pitch = M.clamp(this.pitch + pitchRate * dt, -1.45, 1.25);

      // coordinated bank: roll follows yaw input, self-levels on release
      const rollTarget = M.clamp(stick.x, -1, 1) * 0.92;
      this.roll = M.damp(this.roll, rollTarget, 5.0, dt);

      // gentle pitch self-centring so the horizon is recoverable
      if (Math.abs(stick.y) < 0.05) this.pitch = M.damp(this.pitch, -0.03, 0.7, dt);

      // turbulence: low-frequency gusts + prop wash
      if (state.turbulence) {
        const t = state.time;
        const n = G.gustNoise;
        this.pitch += n.fbm(t * 0.31, 3.1, 2) * 0.010;
        this.yaw += n.fbm(t * 0.27, 8.4, 2) * 0.013;
        this.roll += n.fbm(t * 0.44, 1.7, 2) * 0.020;
      }

      const e = new THREE.Euler(this.pitch, this.yaw, this.roll, 'YXZ');
      this.q.setFromEuler(e);
      this.fwd.set(0, 0, -1).applyQuaternion(this.q);

      // velocity chases the nose; a little gravity sag keeps it honest
      const want = this.fwd.clone().multiplyScalar(targetSpeed);
      want.y -= 11;
      this.vel.lerp(want, 1 - Math.exp(-3.4 * dt));
      this.pos.addScaledVector(this.vel, dt);

      this.speed = this.vel.length();
      this.battery -= dt / CFG.batteryTime * (boost ? 2.1 : 1);
      if (this.battery < 0) this.battery = 0;
    }
  }

  /* =====================================================================
     GAME
     ===================================================================== */
  let renderer, scene, camera, post, hud, fx, terrain, world, drone, sun;
  let clock, raf = 0, lastT = 0, fpsAvg = 60, qualityT = 3;
  const missions = [];

  function init() {
    const container = document.getElementById('game-container');
    G.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

    renderer = new THREE.WebGLRenderer({
      antialias: false, powerPreference: 'high-performance', stencil: false,
    });
    const lowPower = G.isTouch || window.innerWidth * window.innerHeight > 3.2e6;
    state.quality = lowPower ? 0.85 : 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowPower ? 1.4 : 2) * state.quality);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NoToneMapping;   // handled in the composite pass
    renderer.outputEncoding = THREE.LinearEncoding;
    renderer.setClearColor(0x000000, 1);
    container.appendChild(renderer.domElement);
    G.maxAniso = renderer.capabilities.getMaxAnisotropy();

    scene = new THREE.Scene();
    const fogColor = new THREE.Color(0x7c7768).convertSRGBToLinear();
    scene.fog = new THREE.FogExp2(fogColor, 0.00038);
    scene.background = null;

    camera = new THREE.PerspectiveCamera(88, window.innerWidth / window.innerHeight, 0.4, 20000);
    camera.rotation.order = 'YXZ';

    // --- lighting: low winter sun, cold sky fill, warm bounce
    const sunDir = new V3(-0.42, 0.42, -0.86).normalize();
    sun = new THREE.DirectionalLight(0xffd7a8, 2.35);
    sun.position.copy(sunDir).multiplyScalar(900);
    sun.castShadow = true;
    const SH = lowPower ? 1024 : 2048;
    sun.shadow.mapSize.set(SH, SH);
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 1400;
    const SC = 340;
    sun.shadow.camera.left = -SC; sun.shadow.camera.right = SC;
    sun.shadow.camera.top = SC; sun.shadow.camera.bottom = -SC;
    sun.shadow.bias = -0.0009;
    sun.shadow.normalBias = 0.9;
    scene.add(sun);
    scene.add(sun.target);

    const hemi = new THREE.HemisphereLight(0x8ba4c4, 0x3d372c, 0.78);
    scene.add(hemi);
    const fill = new THREE.DirectionalLight(0x6f86a8, 0.28);
    fill.position.set(0.6, 0.4, 0.7);
    scene.add(fill);

    G.sky = G.buildSky(scene, sunDir);
    G.gustNoise = G.makeNoise(4242);

    terrain = G.terrain = new G.Terrain(scene, { size: CFG.worldSize, seg: CFG.worldSeg, seed: 20260525 });
    const groundAt = (x, z) => terrain.heightAt(x, z);

    fx = G.fx = new G.FXDirector(scene, { groundAt, fogColor: fogColor, fogDensity: scene.fog.density });
    fx.initScorch(120, terrain);
    fx.on((type, p, power) => {
      if (type === 'explode') {
        const d = camera.position.distanceTo(p);
        Audio.boom(power, d);
        fx.addShake(M.clamp(power / 10, 0.1, 1.2) * M.clamp(1 - d / 700, 0, 1) * 1.4);
        post.composite.uniforms.uFlash.value = Math.min(0.5,
          post.composite.uniforms.uFlash.value + M.clamp(power / 40, 0, 0.5) * M.clamp(1 - d / 190, 0, 1));
      }
    });

    world = G.world = G.buildWorld(scene, terrain, fx, 20260525);

    // permanent horizon smoke columns — the war is bigger than your sector
    world.horizonFires.forEach((p) => {
      p.y = groundAt(M.clamp(p.x, -1200, 1200), M.clamp(p.z, -1200, 1200));
    });

    post = new G.PostFX(renderer, window.innerWidth * renderer.getPixelRatio(), window.innerHeight * renderer.getPixelRatio());
    hud = G.hud = new G.HUD(document.getElementById('hud-canvas'));
    drone = new Drone();
    clock = new THREE.Clock();

    // exposed for debugging / tuning from the console
    G.renderer = renderer; G.scene = scene; G.camera = camera; G.post = post; G.drone = drone;

    setupInput();
    window.addEventListener('resize', onResize);
    onResize();
    buildMissions();
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
  }

  function onResize() {
    if (!renderer) return;
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    const pr = renderer.getPixelRatio();
    post.setSize(w * pr, h * pr);
    hud.resize();
  }

  /* ------------------------------------------------------------ missions */
  function buildMissions() {
    missions.length = 0;
    missions.push(
      { id: 'aa', title: 'SUPPRESS AIR DEFENCE', need: 3, done: 0, desc: 'ZU-23 emplacements' },
      { id: 'armour', title: 'BREAK THE ARMOUR COLUMN', need: 4, done: 0, desc: 'T-72 / BMP-3' },
      { id: 'cp', title: 'DESTROY COMMAND POST', need: 1, done: 0, desc: 'Bunker, grid 24-17' },
      { id: 'depot', title: 'DESTROY AMMO DEPOT', need: 1, done: 0, desc: 'Forward supply point' },
      { id: 'ew', title: 'KILL THE JAMMER', need: 1, done: 0, desc: 'EW truck degrading our link' },
      { id: 'inf', title: 'REPEL THE ASSAULT', need: 6, done: 0, desc: 'Dismounted infantry' }
    );
    renderMissions();
  }

  function renderMissions() {
    const el = document.getElementById('mission-list');
    let html = '';
    for (const m of missions) {
      const complete = m.done >= m.need;
      html += `<div class="mission${complete ? ' complete' : ''}">
        <div class="mission-title">${complete ? '&#10003;' : '&#9679;'} ${m.title}</div>
        <div class="mission-status">${m.desc} — <span class="mission-count">${Math.min(m.done, m.need)}/${m.need}</span></div>
      </div>`;
    }
    el.innerHTML = html;
  }

  function creditKill(t) {
    const m = missions.find((x) => x.id === t.type);
    if (m && m.done < m.need) {
      m.done++;
      renderMissions();
      if (m.done >= m.need) {
        hud.msg('OBJECTIVE COMPLETE: ' + m.title, '#79ffab', 3.2);
        Audio.beep(880, 0.12, 0.09);
        setTimeout(() => Audio.beep(1320, 0.16, 0.09), 130);
      }
    }
    state.score += t.score || 100;
    state.hits++;
    if (missions.every((x) => x.done >= x.need)) endGame(true);
  }

  /* --------------------------------------------------------- combat ---- */
  function applyBlast(center, radius, dmg) {
    for (const t of world.targets) {
      if (!t.alive) continue;
      const d = t.pos.distanceTo(center);
      if (d > radius + t.radius) continue;
      const f = 1 - M.clamp((d - t.radius) / radius, 0, 1);
      if (t.damage(dmg * f, fx)) {
        creditKill(t);
        hud.msg('TARGET DESTROYED — ' + t.label, '#ffc14d', 2.6);
      }
    }
  }

  let respawnT = 0;
  function loseDrone(reason) {
    if (!drone.alive) return;
    drone.alive = false;
    state.lost++;
    fx.explode(drone.pos.clone(), 9);
    terrain.crater(drone.pos.x, drone.pos.z, 9, 2.4);
    hud.msg(reason, '#ff5a4a', 2.8);
    post.composite.uniforms.uDesat.value = 1;
    respawnT = 2.0;
    Audio.motor(0, false);
    if (state.launched >= CFG.swarm) {
      setTimeout(() => { if (state.mode === 'fly') endGame(false); }, 1800);
    }
  }

  function strike(hitPos, target) {
    state.strikes++;
    fx.explode(hitPos.clone(), 14);
    terrain.crater(hitPos.x, hitPos.z, 13, 3.4);
    applyBlast(hitPos, CFG.blastRadius, CFG.strikeDamage);
    if (target && target.alive) {
      if (target.damage(CFG.strikeDamage, fx)) {
        creditKill(target);
        hud.msg('TARGET DESTROYED — ' + target.label, '#ffc14d', 2.6);
      }
    }
    drone.alive = false;
    post.composite.uniforms.uDesat.value = 0.85;
    respawnT = 1.7;
    Audio.motor(0, false);
    if (state.launched >= CFG.swarm) {
      setTimeout(() => { if (state.mode === 'fly') endGame(missions.every((x) => x.done >= x.need)); }, 1800);
    }
  }

  function respawn() {
    if (state.launched >= CFG.swarm) { endGame(false); return; }
    state.launched++;
    drone.reset();
    post.composite.uniforms.uDesat.value = 0;
    hud.msg('AIRFRAME ' + state.launched + '/' + CFG.swarm + ' LAUNCHED', '#79ffab', 2.0);
    Audio.beep(660, 0.09, 0.06);
  }

  function onPlayerHit(dmg, pos) {
    if (!drone.alive) return;
    drone.hp -= dmg;
    post.composite.uniforms.uHit.value = Math.min(1, post.composite.uniforms.uHit.value + 0.55);
    post.composite.uniforms.uGlitch.value = Math.min(1, post.composite.uniforms.uGlitch.value + 0.5);
    fx.addShake(0.5);
    fx.sparkBurst(pos, 10, 0.7);
    Audio.crack(0);
    if (drone.hp <= 0) loseDrone('AIRFRAME DOWN — AA FIRE');
  }

  /* ----------------------------------------------------------- targeting */
  const _v = new V3(), _v2 = new V3();
  function collectTargets() {
    const screenTargets = [], offscreen = [], radar = [];
    let lock = null, lockDist = 1e9;
    const w = window.innerWidth, h = window.innerHeight;
    for (const t of world.targets) {
      if (t.type === 'wreck' || t.type === 'fire') {
        radar.push({ x: t.pos.x, z: t.pos.z, dead: true });
        continue;
      }
      const d = drone.pos.distanceTo(t.pos);
      radar.push({
        x: t.pos.x, z: t.pos.z, dead: !t.alive,
        hostileAA: t.type === 'aa' && t.alive,
        objective: t.alive && ['cp', 'depot', 'ew', 'armour'].indexOf(t.type) >= 0,
      });
      if (!t.alive || d > 1400) continue;
      _v.copy(t.pos); _v.y += t.radius * 0.4;
      _v2.copy(_v).project(camera);
      const inFront = _v2.z < 1;
      const sx = (_v2.x * 0.5 + 0.5) * w, sy = (-_v2.y * 0.5 + 0.5) * h;
      if (inFront && sx > -60 && sx < w + 60 && sy > -60 && sy < h + 60) {
        // strike cone: near screen centre & close enough to commit
        const off = Math.hypot(sx - w / 2, sy - h / 2);
        if (off < Math.min(w, h) * 0.16 && d < lockDist && d < 700) { lockDist = d; lock = t; }
        screenTargets.push({
          x: sx, y: sy, dist: d, label: t.label || t.type.toUpperCase(),
          hp: t.hp / t.maxHp, priority: t.type === 'aa', t,
        });
      } else if (t.type === 'aa' && d < 800) {
        const ang = Math.atan2(sy - h / 2, sx - w / 2) + (inFront ? 0 : Math.PI);
        const r = Math.min(w, h) * 0.38;
        offscreen.push({
          x: w / 2 + Math.cos(ang) * r, y: h / 2 + Math.sin(ang) * r,
          angle: ang, hostile: true,
        });
      }
    }
    if (lock) for (const st of screenTargets) if (st.t === lock) st.locked = true;
    return { screenTargets, offscreen, radar, lock };
  }

  /* ------------------------------------------------------------- loop --- */
  const camShake = new V3();
  function loop(now) {
    raf = requestAnimationFrame(loop);
    let dt = (now - lastT) / 1000;
    lastT = now;
    if (dt > 0.1) dt = 0.1;
    if (dt <= 0) dt = 1 / 60;
    fpsAvg = fpsAvg * 0.94 + (1 / dt) * 0.06;
    state.time += dt;

    const flying = state.mode === 'fly';
    const stick = flying ? readStick() : { x: 0, y: 0, boost: false };

    if (flying) {
      if (drone.alive) {
        drone.update(dt, stick);

        // ---- link budget: range + electronic warfare
        const rangeKm = drone.pos.distanceTo(CFG.launch) / 1000;
        let sig = 1 - M.smoothstep(1.5, 3.1, rangeKm) * 0.8;
        for (const j of world.jammers) {
          if (!j.alive) continue;
          const d = drone.pos.distanceTo(j.pos);
          sig -= (1 - M.smoothstep(0, j.jamRadius, d)) * 0.85;
        }
        sig -= (1 - drone.battery) * 0.18;
        sig = M.clamp(sig, 0, 1);
        drone.signal = M.damp(drone.signal, sig, 5, dt);
        if (Math.random() < (1 - drone.signal) * dt * 3.2) {
          post.composite.uniforms.uGlitch.value = Math.min(1, post.composite.uniforms.uGlitch.value + 0.4);
        }
        if (drone.signal < 0.14) {
          drone.linkLostT += dt;
          if (drone.linkLostT > 2.6) loseDrone('LINK LOST — AIRFRAME UNRECOVERABLE');
        } else drone.linkLostT = Math.max(0, drone.linkLostT - dt);

        if (drone.battery <= 0) loseDrone('BATTERY DEPLETED');

        // ---- collisions
        const gy = terrain.heightAt(drone.pos.x, drone.pos.z);
        if (drone.pos.y < gy + 1.4) {
          // did we hit something worth hitting?
          let best = null, bd = 1e9;
          for (const t of world.targets) {
            if (!t.alive) continue;
            const d = t.pos.distanceTo(drone.pos);
            if (d < t.radius + 6 && d < bd) { bd = d; best = t; }
          }
          drone.pos.y = gy + 1.0;
          if (best) strike(drone.pos, best);
          else {
            state.strikes++;
            fx.explode(drone.pos.clone(), 11);
            terrain.crater(drone.pos.x, drone.pos.z, 11, 3);
            applyBlast(drone.pos, CFG.blastRadius, CFG.strikeDamage);
            hud.msg('IMPACT — NO TARGET', '#ff5a4a', 2.2);
            drone.alive = false;
            post.composite.uniforms.uDesat.value = 0.85;
            respawnT = 1.7;
            if (state.launched >= CFG.swarm) {
              setTimeout(() => { if (state.mode === 'fly') endGame(missions.every((x) => x.done >= x.need)); }, 1800);
            }
          }
        } else {
          for (const t of world.targets) {
            if (!t.alive) continue;
            if (t.pos.distanceToSquared(drone.pos) < (t.radius + 2.2) * (t.radius + 2.2)) {
              strike(drone.pos, t);
              break;
            }
          }
        }
        // out-of-bounds
        const lim = CFG.worldSize * 0.5 - 40;
        if (Math.abs(drone.pos.x) > lim || Math.abs(drone.pos.z) > lim || drone.pos.y > 900) {
          loseDrone('OUT OF SECTOR — SIGNAL LOST');
        }
      } else {
        respawnT -= dt;
        if (respawnT <= 0 && state.mode === 'fly') respawn();
      }
    }

    // ---- world tick
    const ctx = { player: drone.alive ? drone : null, fx, camera, groundAt: (x, z) => terrain.heightAt(x, z) };
    for (const t of world.targets) t.update(dt, ctx);

    // ambient: distant artillery + horizon smoke
    ambient(dt);

    fx.update(dt, drone.alive ? drone.pos : null, onPlayerHit);

    // ---- camera
    if (drone.alive || state.mode !== 'fly') {
      camera.position.copy(drone.pos);
      camera.quaternion.copy(drone.q);
    } else {
      // tumbling wreck view for a beat after the hit
      camera.position.copy(drone.pos);
      camera.rotateZ(dt * 1.4);
    }
    const sh = fx.shake;
    if (sh > 0.001) {
      camShake.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(sh * 0.55);
      camera.position.add(camShake);
      camera.rotateZ((Math.random() - 0.5) * sh * 0.035);
    }
    // motor vibration
    if (flying && drone.alive) {
      const v = 0.014 + drone.boostAmt * 0.02;
      camera.rotateZ(Math.sin(state.time * 61) * v * 0.35);
      camera.rotateX(Math.sin(state.time * 74) * v * 0.25);
      const fovTarget = 88 + drone.boostAmt * 18;
      if (Math.abs(camera.fov - fovTarget) > 0.05) {
        camera.fov = M.damp(camera.fov, fovTarget, 5, dt);
        camera.updateProjectionMatrix();
      }
      Audio.motor(M.clamp((drone.speed - 60) / 130, 0, 1), true);
    }

    // shadow frustum follows the drone
    sun.target.position.set(camera.position.x, 0, camera.position.z);
    sun.position.set(camera.position.x - 380, 300, camera.position.z - 700);
    sun.target.updateMatrixWorld();

    // sky animation
    G.sky.material.uniforms.uTime.value = state.time;

    // ---- post uniforms
    const u = post.composite.uniforms;
    u.uSignal.value = M.damp(u.uSignal.value, flying ? drone.signal : 1, 8, dt);
    u.uBoost.value = M.damp(u.uBoost.value, drone.boostAmt || 0, 6, dt);

    post.render(scene, camera, dt);

    // ---- HUD
    const tg = flying ? collectTargets() : { screenTargets: [], offscreen: [], radar: [], lock: null };
    const alt = drone.pos.y - terrain.heightAt(drone.pos.x, drone.pos.z);
    hud.draw({
      pitch: drone.pitch, roll: drone.roll, heading: -drone.yaw,
      alt: Math.max(0, alt), speed: drone.speed * 3.6,
      signal: drone.signal, battery: drone.battery,
      volts: 14.8 * (0.72 + drone.battery * 0.28),
      screenTargets: tg.screenTargets, offscreen: tg.offscreen, radar: tg.radar,
      lock: !!tg.lock, px: drone.pos.x, pz: drone.pos.z,
      clock: clockStr(),
      droneTag: 'FPV-' + String(state.launched).padStart(2, '0'),
      warn: warnText(alt),
    }, dt);

    updateDOM();

    // adaptive quality — re-sizing reallocates every render target, so only
    // ever step it once a second and never oscillate back up mid-mission
    qualityT -= dt;
    if (qualityT <= 0) {
      qualityT = 1.0;
      if (fpsAvg < 34 && state.quality > 0.6) {
        state.quality = Math.max(0.6, state.quality - 0.12);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * state.quality);
        onResize();
      }
    }
  }

  function warnText(alt) {
    if (!drone.alive) return null;
    if (drone.signal < 0.3) return 'SIGNAL CRITICAL';
    if (drone.battery < 0.15) return 'BATTERY LOW';
    if (alt < 22 && drone.pitch < -0.1) return 'PULL UP';
    if (drone.hp < 45) return 'AIRFRAME DAMAGED';
    return null;
  }

  function clockStr() {
    const t = state.time;
    const mm = String(Math.floor(t / 60) % 60).padStart(2, '0');
    const ss = String(Math.floor(t) % 60).padStart(2, '0');
    const ff = String(Math.floor((t % 1) * 100)).padStart(2, '0');
    return `04:${mm}:${ss}.${ff}`;
  }

  let ambT = 0, horizonT = 0;
  function ambient(dt) {
    ambT -= dt;
    if (ambT <= 0) {
      ambT = 3.5 + Math.random() * 7;
      // distant artillery impact somewhere along the line
      const a = Math.random() * 6.283;
      const d = 900 + Math.random() * 900;
      const p = new V3(drone.pos.x + Math.cos(a) * d, 0, drone.pos.z + Math.sin(a) * d);
      const lim = CFG.worldSize * 0.48;
      p.x = M.clamp(p.x, -lim, lim); p.z = M.clamp(p.z, -lim, lim);
      p.y = terrain.heightAt(p.x, p.z) + 1;
      fx.explode(p, 10 + Math.random() * 8);
    }
    horizonT -= dt;
    if (horizonT <= 0) {
      horizonT = 0.18;
      for (const p of world.horizonFires) {
        fx.smoke.spawn({
          x: p.x + (Math.random() - 0.5) * 60, y: p.y + Math.random() * 40, z: p.z + (Math.random() - 0.5) * 60,
          vx: 4, vy: 12 + Math.random() * 10, vz: -2,
          life: 14 + Math.random() * 10, size0: 40, size1: 220,
          rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 0.1,
          grav: -1.2, drag: 0.2, alpha: 0.34,
          r: 0.075, g: 0.070, b: 0.066, r1: 0.19, g1: 0.19, b1: 0.20,
        });
      }
    }
  }

  let domT = 0;
  function updateDOM() {
    domT -= 1;
    if (domT > 0) return;
    domT = 6;
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('ui-swarm', (CFG.swarm - state.launched) + '/' + CFG.swarm);
    set('ui-strikes', state.hits);
    set('ui-accuracy', state.strikes ? Math.round((state.hits / state.strikes) * 100) + '%' : '100%');
    set('ui-alt', Math.round(Math.max(0, drone.pos.y - terrain.heightAt(drone.pos.x, drone.pos.z))));
    set('ui-speed', Math.round(drone.speed * 3.6));
    set('ui-threats', world.aaGuns.filter((t) => t.alive).length);
    set('ui-battery', Math.round(drone.battery * 100) + '%');
    set('ui-signal', Math.round(drone.signal * 100) + '%');
    set('ui-score', state.score.toLocaleString());
  }

  /* ------------------------------------------------------- game flow ---- */
  function startGame() {
    state.mode = 'fly';
    state.strikes = 0; state.hits = 0; state.lost = 0; state.launched = 0; state.score = 0;
    for (const m of missions) m.done = 0;
    renderMissions();
    document.getElementById('start-screen').style.display = 'none';
    document.getElementById('end-screen').style.display = 'none';
    document.body.classList.add('flying');
    Audio.init(); Audio.resume();
    respawn();
    hud.msg('WEAPONS FREE — GOOD HUNTING', '#79ffab', 3.4);
  }

  function endGame(win) {
    if (state.mode !== 'fly') return;
    state.mode = 'end';
    Audio.motor(0, false);
    document.body.classList.remove('flying');
    if (G.hideControls) G.hideControls();
    const acc = state.strikes ? Math.round((state.hits / state.strikes) * 100) : 0;
    const done = missions.filter((m) => m.done >= m.need).length;
    const title = document.getElementById('end-title');
    title.textContent = win ? 'SECTOR CLEARED' : 'SWARM EXPENDED';
    title.style.color = win ? '#79ffab' : '#ff6a5a';
    const rank = win ? (acc > 70 ? 'ACE OPERATOR' : acc > 45 ? 'CONFIRMED OPERATOR' : 'OPERATOR')
      : (done >= 4 ? 'PARTIAL SUCCESS' : 'MISSION FAILED');
    document.getElementById('end-debrief').innerHTML = `
      <div class="debrief-rank">${rank}</div>
      <div class="debrief-stat"><span>OBJECTIVES</span><span>${done} / ${missions.length}</span></div>
      <div class="debrief-stat"><span>CONFIRMED KILLS</span><span>${state.hits}</span></div>
      <div class="debrief-stat"><span>AIRFRAMES EXPENDED</span><span>${state.launched} / ${CFG.swarm}</span></div>
      <div class="debrief-stat"><span>STRIKE ACCURACY</span><span>${acc}%</span></div>
      <div class="debrief-stat"><span>SCORE</span><span>${state.score.toLocaleString()}</span></div>
      <div class="debrief-note">${win
        ? 'Enemy assault broken. The line holds tonight.'
        : 'Swarm expended before the objectives fell. Rearm and go again.'}</div>
    `;
    document.getElementById('end-screen').style.display = 'flex';
  }

  window.restartGame = function () {
    document.getElementById('end-screen').style.display = 'none';
    // fresh terrain scars stay — the battlefield remembers
    startGame();
  };

  window.selectControlMode = function (mode) {
    state.ctrl = mode;
    ['arcade', 'split', 'joystick'].forEach((m) => {
      const b = document.getElementById('btn-' + (m === 'joystick' ? 'joy' : m));
      if (b) b.classList.toggle('active', m === mode);
    });
    const desc = {
      arcade: 'Drag anywhere to steer. Release to settle. Best for diving attacks.',
      split: 'Left thumb pitches, right thumb yaws. Twin-stick precision.',
      joystick: 'Virtual thumbstick on the left half of the screen.',
    };
    const el = document.getElementById('ctrl-desc');
    if (el) el.textContent = desc[mode];
  };

  /* ------------------------------------------------------------- boot --- */
  function boot() {
    const startBtn = document.getElementById('btn-play');
    const inv = document.getElementById('invert-y');
    const turb = document.getElementById('turbulence');
    inv.addEventListener('change', () => (state.invertY = inv.checked));
    turb.addEventListener('change', () => (state.turbulence = turb.checked));

    document.getElementById('fullscreen-btn').addEventListener('click', () => {
      const d = document.documentElement;
      if (!document.fullscreenElement) (d.requestFullscreen || d.webkitRequestFullscreen || function () {}).call(d);
      else document.exitFullscreen();
    });

    try {
      init();
    } catch (err) {
      console.error(err);
      showFatal(err);
      return;
    }
    startBtn.disabled = false;
    startBtn.textContent = 'DEPLOY TO FRONT';
    startBtn.addEventListener('click', startGame);
    document.getElementById('boot-status').textContent = 'AO LOADED — ' + world.targets.length + ' CONTACTS MAPPED';
  }

  function showFatal(err) {
    const el = document.getElementById('boot-status');
    if (el) {
      el.style.color = '#ff5a4a';
      el.textContent = 'RENDERER FAULT: ' + (err && err.message ? err.message : err);
    }
  }

  if (!window.THREE) {
    document.addEventListener('DOMContentLoaded', () => {
      const el = document.getElementById('boot-status');
      if (el) {
        el.style.color = '#ff5a4a';
        el.textContent = 'THREE.JS FAILED TO LOAD — CHECK YOUR CONNECTION';
      }
    });
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
