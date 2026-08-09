/* =========================================================================
   DONBAS FPV 2026 — lib.js
   Math, deterministic noise, and procedurally generated textures.
   No external assets: every texture in the game is drawn here at runtime.
   ========================================================================= */
(function () {
  'use strict';
  const G = (window.G = window.G || {});

  /* ---------------------------------------------------------- math utils */
  const M = (G.M = {
    clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
    lerp: (a, b, t) => a + (b - a) * t,
    smoothstep(e0, e1, x) {
      const t = M.clamp((x - e0) / (e1 - e0), 0, 1);
      return t * t * (3 - 2 * t);
    },
    // frame-rate independent exponential approach
    damp: (a, b, lambda, dt) => M.lerp(a, b, 1 - Math.exp(-lambda * dt)),
    rad: (d) => (d * Math.PI) / 180,
    deg: (r) => (r * 180) / Math.PI,
    wrapPI(a) {
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      return a;
    },
  });

  // mulberry32 — small, fast, seedable
  G.rng = function (seed) {
    let a = seed >>> 0;
    const f = function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.range = (lo, hi) => lo + f() * (hi - lo);
    f.int = (lo, hi) => Math.floor(lo + f() * (hi - lo + 1));
    f.pick = (arr) => arr[Math.floor(f() * arr.length)];
    return f;
  };

  /* ------------------------------------------------- 2D simplex noise ---- */
  const GRAD2 = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ];

  G.makeNoise = function (seed) {
    const rand = G.rng(seed);
    const perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const Gg2 = (3 - Math.sqrt(3)) / 6;

    function noise2(xin, yin) {
      const s = (xin + yin) * F2;
      const i = Math.floor(xin + s), j = Math.floor(yin + s);
      const t = (i + j) * Gg2;
      const x0 = xin - (i - t), y0 = yin - (j - t);
      let i1, j1;
      if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
      const x1 = x0 - i1 + Gg2, y1 = y0 - j1 + Gg2;
      const x2 = x0 - 1 + 2 * Gg2, y2 = y0 - 1 + 2 * Gg2;
      const ii = i & 255, jj = j & 255;
      let n = 0;
      let tt = 0.5 - x0 * x0 - y0 * y0;
      if (tt > 0) {
        const g = GRAD2[perm[ii + perm[jj]] & 7];
        tt *= tt; n += tt * tt * (g[0] * x0 + g[1] * y0);
      }
      tt = 0.5 - x1 * x1 - y1 * y1;
      if (tt > 0) {
        const g = GRAD2[perm[ii + i1 + perm[jj + j1]] & 7];
        tt *= tt; n += tt * tt * (g[0] * x1 + g[1] * y1);
      }
      tt = 0.5 - x2 * x2 - y2 * y2;
      if (tt > 0) {
        const g = GRAD2[perm[ii + 1 + perm[jj + 1]] & 7];
        tt *= tt; n += tt * tt * (g[0] * x2 + g[1] * y2);
      }
      return 70 * n; // ~[-1,1]
    }

    noise2.fbm = function (x, y, oct, lac, gain) {
      oct = oct || 4; lac = lac || 2.03; gain = gain || 0.5;
      let a = 1, f = 1, sum = 0, norm = 0;
      for (let o = 0; o < oct; o++) {
        sum += a * noise2(x * f, y * f);
        norm += a; a *= gain; f *= lac;
      }
      return sum / norm;
    };
    // billowy ridges — good for eroded ground and cloud sheets
    noise2.ridge = function (x, y, oct) {
      let a = 1, f = 1, sum = 0, norm = 0;
      for (let o = 0; o < (oct || 4); o++) {
        const n = 1 - Math.abs(noise2(x * f, y * f));
        sum += a * n * n; norm += a; a *= 0.5; f *= 2.07;
      }
      return sum / norm;
    };
    return noise2;
  };

  /* ------------------------------------------------ texture generation --- */
  function cv(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }

  function finish(canvas, opts) {
    opts = opts || {};
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = opts.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.anisotropy = G.maxAniso || 4;
    if (opts.srgb !== false) t.encoding = THREE.sRGBEncoding;
    t.needsUpdate = true;
    return t;
  }

  // Seamless fbm field rendered into ImageData, tinted by a ramp callback.
  function fieldTexture(size, seed, freq, oct, ramp, extra) {
    const c = cv(size);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const n = G.makeNoise(seed);
    const d = img.data;
    // tile seamlessly by sampling noise on a torus embedded in 4D-ish fashion
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size;
        // 4 corner blend for wrap-around continuity
        const s = freq;
        const a = n.fbm(u * s, v * s, oct);
        const b = n.fbm((u - 1) * s, v * s, oct);
        const cc = n.fbm(u * s, (v - 1) * s, oct);
        const dd = n.fbm((u - 1) * s, (v - 1) * s, oct);
        const val =
          a * (1 - u) * (1 - v) + b * u * (1 - v) + cc * (1 - u) * v + dd * u * v;
        const col = ramp(val * 0.5 + 0.5, x, y, size, n);
        const i = (y * size + x) * 4;
        d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = col.length > 3 ? col[3] : 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    if (extra) extra(ctx, size);
    return c;
  }

  const T = (G.tex = {});

  /* churned mud / shell-torn earth */
  T.mud = function () {
    const c = fieldTexture(256, 7391, 7, 5, (v) => {
      const g = 52 + v * 58;
      return [g * 1.0, g * 0.96, g * 0.87];
    }, (ctx, s) => {
      // scattered gravel + tyre-rut streaks
      const r = G.rng(51);
      ctx.globalAlpha = 0.25;
      for (let i = 0; i < 900; i++) {
        const x = r() * s, y = r() * s, rad = r() * 1.9 + 0.4;
        ctx.fillStyle = r() > 0.5 ? '#2b2620' : '#a09383';
        ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.283); ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
    return finish(c);
  };

  /* dead winter grass / scrub */
  T.grass = function () {
    const c = fieldTexture(256, 913, 9, 5, (v) => {
      const g = 44 + v * 52;
      return [g * 0.94, g * 1.0, g * 0.70];
    }, (ctx, s) => {
      const r = G.rng(77);
      ctx.lineWidth = 1;
      for (let i = 0; i < 2600; i++) {
        const x = r() * s, y = r() * s, len = 2 + r() * 5, ang = r() * 6.283;
        ctx.strokeStyle = r() > 0.45 ? 'rgba(126,124,74,0.5)' : 'rgba(60,58,36,0.5)';
        ctx.beginPath(); ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); ctx.stroke();
      }
    });
    return finish(c);
  };

  /* exposed rock / frozen clay on slopes */
  T.rock = function () {
    const c = fieldTexture(256, 4477, 11, 6, (v) => {
      const g = 58 + v * 72;
      return [g * 0.96, g * 0.94, g * 0.90];
    });
    return finish(c);
  };

  /* scorch / burn decal (alpha) */
  T.scorch = function () {
    const s = 256, c = cv(s), ctx = c.getContext('2d');
    const n = G.makeNoise(1234);
    const img = ctx.createImageData(s, s), d = img.data;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const dx = (x / s - 0.5) * 2, dy = (y / s - 0.5) * 2;
        const rr = Math.sqrt(dx * dx + dy * dy);
        const warp = n.fbm(x / s * 5, y / s * 5, 4) * 0.34;
        let a = 1 - M.smoothstep(0.28, 0.98, rr + warp);
        const speck = n.fbm(x / s * 22, y / s * 22, 3) * 0.5 + 0.5;
        a *= 0.55 + speck * 0.65;
        const ring = M.smoothstep(0.20, 0.42, rr + warp) * (1 - M.smoothstep(0.5, 0.8, rr + warp));
        const g = 14 + ring * 46 + speck * 18;
        const i = (y * s + x) * 4;
        d[i] = g; d[i + 1] = g * 0.92; d[i + 2] = g * 0.84;
        d[i + 3] = M.clamp(a, 0, 1) * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return finish(c, { clamp: true });
  };

  /* soft smoke puff — the workhorse of the FX system */
  T.smoke = function () {
    const s = 128, c = cv(s), ctx = c.getContext('2d');
    const n = G.makeNoise(88);
    const img = ctx.createImageData(s, s), d = img.data;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const dx = x / s - 0.5, dy = y / s - 0.5;
        const rr = Math.sqrt(dx * dx + dy * dy) * 2;
        const turb = n.fbm(x / s * 4.2, y / s * 4.2, 5) * 0.42;
        let a = 1 - M.smoothstep(0.12, 1.0, rr + turb);
        a *= 0.62 + (n.fbm(x / s * 9, y / s * 9, 3) * 0.5 + 0.5) * 0.6;
        // hard-clamp to a disc: turbulence must never leave alpha at the quad
        // border, or every puff shows its billboard silhouette
        a *= 1 - M.smoothstep(0.66, 0.98, rr);
        const i = (y * s + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = M.clamp(a, 0, 1) * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return finish(c, { clamp: true, srgb: false });
  };

  /* radial glow — sparks, muzzle flashes, sun, lens bloom seeds */
  T.glow = function () {
    const s = 64, c = cv(s), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.22)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    return finish(c, { clamp: true, srgb: false });
  };

  /* fire licks — additive, animated by scrolling in shader */
  T.fire = function () {
    const s = 128, c = cv(s), ctx = c.getContext('2d');
    const n = G.makeNoise(2027);
    const img = ctx.createImageData(s, s), d = img.data;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const dx = x / s - 0.5, dy = y / s - 0.5;
        const rr = Math.sqrt(dx * dx + dy * dy) * 2;
        const turb = n.ridge(x / s * 5, y / s * 5, 4);
        let a = (1 - M.smoothstep(0.05, 1.0, rr)) * (0.35 + turb * 0.95);
        a = M.clamp(a, 0, 1);
        const heat = M.clamp(a * 1.5, 0, 1);
        const i = (y * s + x) * 4;
        d[i] = 255;
        d[i + 1] = 90 + heat * 150;
        d[i + 2] = 20 + heat * heat * 90;
        d[i + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return finish(c, { clamp: true, srgb: false });
  };

  /* blue-noise-ish static for the analog video pass */
  T.static = function () {
    const s = 256, c = cv(s), ctx = c.getContext('2d');
    const img = ctx.createImageData(s, s), d = img.data;
    const r = G.rng(9182);
    for (let i = 0; i < d.length; i += 4) {
      const v = r() * 255;
      d[i] = v; d[i + 1] = r() * 255; d[i + 2] = r() * 255; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const t = finish(c, { srgb: false });
    t.minFilter = t.magFilter = THREE.NearestFilter;
    return t;
  };

  /* cloud sheet for the sky dome */
  T.clouds = function () {
    const c = fieldTexture(512, 3313, 5, 6, (v) => {
      const a = M.clamp((v - 0.42) * 2.5, 0, 1);
      const g = 150 + v * 105;
      return [g, g * 0.99, g * 0.98, a * 255];
    });
    return finish(c, { srgb: false });
  };

  /* generic panel material texture: concrete, rusted steel, sandbags, camo */
  T.concrete = function () {
    const c = fieldTexture(256, 5150, 8, 4, (v) => {
      const g = 96 + v * 46;
      return [g, g * 0.99, g * 0.95];
    }, (ctx, s) => {
      const r = G.rng(31);
      ctx.strokeStyle = 'rgba(30,28,26,0.5)'; ctx.lineWidth = 1.4;
      for (let i = 0; i < 26; i++) { // cracks
        let x = r() * s, y = r() * s;
        ctx.beginPath(); ctx.moveTo(x, y);
        for (let k = 0; k < 7; k++) { x += (r() - 0.5) * 34; y += (r() - 0.5) * 34; ctx.lineTo(x, y); }
        ctx.stroke();
      }
      ctx.globalAlpha = 0.3;
      for (let i = 0; i < 260; i++) {
        ctx.fillStyle = r() > 0.5 ? '#5c554c' : '#c8c2b6';
        ctx.fillRect(r() * s, r() * s, 1 + r() * 3, 1 + r() * 3);
      }
      ctx.globalAlpha = 1;
    });
    return finish(c);
  };

  T.steel = function () {
    const c = fieldTexture(256, 2211, 14, 5, (v) => {
      const g = 60 + v * 40;
      return [g * 1.0, g * 0.97, g * 0.93];
    }, (ctx, s) => {
      const r = G.rng(63);
      // rust blooms
      for (let i = 0; i < 40; i++) {
        const x = r() * s, y = r() * s, rad = 4 + r() * 26;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, 'rgba(126,62,26,0.55)');
        g.addColorStop(1, 'rgba(126,62,26,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.283); ctx.fill();
      }
      // weld/panel seams
      ctx.strokeStyle = 'rgba(20,20,20,0.45)'; ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const y = r() * s; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
      }
    });
    return finish(c);
  };

  T.sandbag = function () {
    const s = 256, c = cv(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#6a6047'; ctx.fillRect(0, 0, s, s);
    const r = G.rng(404);
    const rows = 8, cols = 5;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const ox = (y % 2) * (s / cols / 2);
        const px = x * (s / cols) + ox, py = y * (s / rows);
        const w = s / cols - 2, h = s / rows - 2;
        const g = ctx.createLinearGradient(px, py, px, py + h);
        const tint = 0.82 + r() * 0.3;
        g.addColorStop(0, `rgb(${128 * tint},${116 * tint},${84 * tint})`);
        g.addColorStop(0.55, `rgb(${96 * tint},${86 * tint},${60 * tint})`);
        g.addColorStop(1, `rgb(${48 * tint},${43 * tint},${30 * tint})`);
        ctx.fillStyle = g;
        ctx.beginPath();
        const rr = 7;
        ctx.moveTo(px + rr, py);
        ctx.arcTo(px + w, py, px + w, py + h, rr);
        ctx.arcTo(px + w, py + h, px, py + h, rr);
        ctx.arcTo(px, py + h, px, py, rr);
        ctx.arcTo(px, py, px + w, py, rr);
        ctx.fill();
      }
    }
    return finish(c);
  };

  T.camo = function () {
    const s = 256, c = cv(s), ctx = c.getContext('2d');
    ctx.fillStyle = '#3f4632'; ctx.fillRect(0, 0, s, s);
    const r = G.rng(2626);
    const cols = ['#2b3123', '#525a3c', '#6b6b4a', '#22271c'];
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = r.pick(cols);
      ctx.beginPath();
      const x = r() * s, y = r() * s;
      ctx.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        ctx.lineTo(x + (r() - 0.5) * 90, y + (r() - 0.5) * 90);
      }
      ctx.closePath(); ctx.fill();
    }
    return finish(c);
  };

  /* charred / burnt-out metal for wrecks */
  T.charred = function () {
    const c = fieldTexture(256, 8181, 10, 5, (v) => {
      const g = 20 + v * 30;
      return [g * 1.1, g * 1.0, g * 0.95];
    }, (ctx, s) => {
      const r = G.rng(19);
      for (let i = 0; i < 30; i++) {
        const x = r() * s, y = r() * s, rad = 6 + r() * 30;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, 'rgba(150,74,30,0.30)');
        g.addColorStop(1, 'rgba(150,74,30,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, 6.283); ctx.fill();
      }
    });
    return finish(c);
  };

  /* Tree/bush impostor billboard with alpha */
  T.foliage = function () {
    const s = 128, c = cv(s), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    const r = G.rng(707);
    // trunk
    ctx.strokeStyle = '#2e261d'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(s / 2, s); ctx.lineTo(s / 2 + 3, s * 0.55); ctx.stroke();
    ctx.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.moveTo(s / 2 + 2, s * (0.62 + r() * 0.2));
      ctx.lineTo(s / 2 + (r() - 0.5) * 60, s * (0.28 + r() * 0.3));
      ctx.stroke();
    }
    // canopy — bare winter branches with sparse dark leaves
    for (let i = 0; i < 340; i++) {
      const a = r() * 6.283, rad = Math.pow(r(), 0.62) * s * 0.4;
      const x = s / 2 + Math.cos(a) * rad, y = s * 0.4 + Math.sin(a) * rad * 0.85;
      ctx.fillStyle = ['rgba(46,54,34,0.85)', 'rgba(64,70,44,0.8)', 'rgba(30,34,24,0.9)'][i % 3];
      ctx.beginPath(); ctx.arc(x, y, 2 + r() * 5, 0, 6.283); ctx.fill();
    }
    return finish(c, { clamp: true });
  };

  /* muzzle-flash star */
  T.flash = function () {
    const s = 64, c = cv(s), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,240,1)');
    g.addColorStop(0.3, 'rgba(255,200,90,0.55)');
    g.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(255,235,180,0.85)'; ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * 6.283 + 0.3;
      ctx.beginPath(); ctx.moveTo(s / 2, s / 2);
      ctx.lineTo(s / 2 + Math.cos(a) * s * 0.48, s / 2 + Math.sin(a) * s * 0.48);
      ctx.stroke();
    }
    return finish(c, { clamp: true, srgb: false });
  };


  /* tangent-space normal map for the ground — derived from an fbm height
     field so close-range terrain has real lit relief, not flat paint */
  T.groundNormal = function () {
    const size = 256, c = cv(size), ctx = c.getContext('2d');
    const n = G.makeNoise(6161);
    const img = ctx.createImageData(size, size), d = img.data;
    const H = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size, f = 5;
        const mix2 = (a, b) => a * 0.62 + b * 0.38;
        const a = mix2(n.fbm(u * f, v * f, 5), n.ridge(u * f * 2.1, v * f * 2.1, 3));
        const b = mix2(n.fbm((u - 1) * f, v * f, 5), n.ridge((u - 1) * f * 2.1, v * f * 2.1, 3));
        const cc = mix2(n.fbm(u * f, (v - 1) * f, 5), n.ridge(u * f * 2.1, (v - 1) * f * 2.1, 3));
        const dd = mix2(n.fbm((u - 1) * f, (v - 1) * f, 5), n.ridge((u - 1) * f * 2.1, (v - 1) * f * 2.1, 3));
        H[y * size + x] =
          a * (1 - u) * (1 - v) + b * u * (1 - v) + cc * (1 - u) * v + dd * u * v;
      }
    }
    const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
    const strength = 1.5;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
        const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
        const len = Math.hypot(dx, dy, 1);
        const i = (y * size + x) * 4;
        d[i] = ((dx / len) * 0.5 + 0.5) * 255;
        d[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
        d[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return finish(c, { srgb: false });
  };

  /* Build every texture once, lazily, and cache. */
  const cache = {};
  G.getTex = function (name) {
    if (!cache[name]) cache[name] = T[name]();
    return cache[name];
  };
})();
