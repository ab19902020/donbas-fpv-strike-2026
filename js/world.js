/* =========================================================================
   DONBAS FPV 2026 — world.js
   Sky dome, deformable heightfield terrain, battlefield set dressing and
   every hostile entity in the AO.
   ========================================================================= */
(function () {
  'use strict';
  const G = window.G;
  const M = G.M;
  const V3 = THREE.Vector3;

  /* =====================================================================
     SKY
     ===================================================================== */
  const SKY_FS = `
    uniform vec3 uZenith, uHorizon, uGround, uSunColor;
    uniform vec3 uSunDir;
    uniform float uTime;
    uniform sampler2D tClouds;
    varying vec3 vDir;

    void main(){
      vec3 d = normalize(vDir);
      float h = d.y;
      // atmospheric gradient with a compressed, hazy horizon band
      float t = pow(clamp(h*1.05 + 0.02, 0.0, 1.0), 0.42);
      vec3 col = mix(uHorizon, uZenith, t);
      col = mix(col, uGround, smoothstep(0.0, -0.12, h));

      // sun disc + broad forward-scatter glow
      float sd = max(dot(d, uSunDir), 0.0);
      col += uSunColor * pow(sd, 900.0) * 9.0;
      col += uSunColor * pow(sd, 14.0) * 0.34;
      col += uSunColor * pow(sd, 3.0) * 0.07;

      // two scrolling cloud sheets, flattened toward the horizon
      if (h > -0.02){
        float persp = 1.0 / max(h + 0.10, 0.075);
        vec2 uv = d.xz * persp;
        float c1 = texture2D(tClouds, uv*0.030 + vec2(uTime*0.0032, uTime*0.0011)).a;
        float c2 = texture2D(tClouds, uv*0.062 - vec2(uTime*0.0051, uTime*0.0018)).a;
        float cov = clamp(c1*0.85 + c2*0.55 - 0.16, 0.0, 1.0);
        cov *= smoothstep(-0.02, 0.20, h);
        float lit = pow(max(dot(d, uSunDir), 0.0), 5.0);
        vec3 cc = mix(vec3(0.30,0.31,0.34), vec3(0.90,0.86,0.80), lit*0.8 + 0.22);
        col = mix(col, cc, cov*0.86);
      }

      // smoke haze layer sitting on the horizon
      float haze = exp(-abs(h)*11.0);
      col = mix(col, uHorizon*1.04, haze*0.22);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  G.buildSky = function (scene, sunDir) {
    const geo = new THREE.SphereGeometry(9000, 48, 32);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color(0x24405f).convertSRGBToLinear() },
        uHorizon: { value: new THREE.Color(0x8f8878).convertSRGBToLinear() },
        uGround: { value: new THREE.Color(0x8b8477).convertSRGBToLinear() },
        uSunColor: { value: new THREE.Color(0xffd9a0).convertSRGBToLinear() },
        uSunDir: { value: sunDir.clone().normalize() },
        uTime: { value: 0 },
        tClouds: { value: G.getTex('clouds') },
      },
      vertexShader: `
        varying vec3 vDir;
        void main(){
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: SKY_FS,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    scene.add(mesh);
    return mesh;
  };

  /* =====================================================================
     TERRAIN — heightfield with live crater deformation
     ===================================================================== */
  class Terrain {
    constructor(scene, opts) {
      this.size = opts.size;
      this.seg = opts.seg;
      this.n = opts.seg + 1;
      this.sp = opts.size / opts.seg;
      this.half = opts.size / 2;
      this.noise = G.makeNoise(opts.seed || 1);
      this.h = new Float32Array(this.n * this.n);
      this.burn = new Float32Array(this.n * this.n);

      this._baseHeights();

      const geo = new THREE.PlaneGeometry(opts.size, opts.size, opts.seg, opts.seg);
      geo.rotateX(-Math.PI / 2);
      this.geo = geo;
      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));

      for (let i = 0; i < pos.count; i++) pos.setY(i, this.h[i]);
      this._normals(0, 0, this.n - 1, this.n - 1);
      this._colors(0, 0, this.n - 1, this.n - 1);

      const groundN = G.getTex('groundNormal');
      groundN.wrapS = groundN.wrapT = THREE.RepeatWrapping;
      groundN.repeat.set(opts.size / 19, opts.size / 19);
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.97, metalness: 0.0,
        normalMap: groundN,
      });
      mat.normalScale.set(0.62, 0.62);
      const mud = G.getTex('mud'), grass = G.getTex('grass'), rock = G.getTex('rock');
      mud.repeat.set(1, 1); grass.repeat.set(1, 1); rock.repeat.set(1, 1);
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uMud = { value: mud };
        sh.uniforms.uGrass = { value: grass };
        sh.uniforms.uRock = { value: rock };
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWN;')
          .replace('#include <worldpos_vertex>',
            '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>',
            '#include <common>\nuniform sampler2D uMud;uniform sampler2D uGrass;uniform sampler2D uRock;\nvarying vec3 vWPos;varying vec3 vWN;')
          .replace('#include <map_fragment>', `#include <map_fragment>
            vec2 uvA = vWPos.xz * 0.075;      // close detail
            vec2 uvB = vWPos.xz * 0.0092;     // macro variation
            vec2 uvC = vWPos.xz * 0.42;       // micro grain, only readable up close
            vec3 mudC   = texture2D(uMud,   uvA).rgb * texture2D(uMud, uvB*2.3).rgb * 2.15;
            vec3 grassC = texture2D(uGrass, uvA*0.72).rgb * texture2D(uGrass, uvB).rgb * 2.15;
            vec3 rockC  = texture2D(uRock,  uvA*1.9).rgb * 1.05;
            float slope = 1.0 - clamp(vWN.y, 0.0, 1.0);
            float blend = texture2D(uGrass, uvB*0.55).g * 2.0;
            vec3 det = mix(grassC, mudC, clamp(blend*1.25, 0.0, 1.0));
            det = mix(det, rockC, smoothstep(0.16, 0.44, slope));
            // expand contrast around mid grey so the ground reads as churned earth
            det = clamp((det - 0.5) * 1.55 + 0.5, 0.0, 2.0);
            float micro = texture2D(uMud, uvC).g;
            det *= 0.80 + micro * 0.45;
            diffuseColor.rgb *= det * 1.58;
          `);
        this.shader = sh;
      };
      mat.customProgramCacheKey = () => 'donbas-terrain';

      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      this.mesh = mesh;

      // far skirt so the world never shows an edge through the fog
      const skirt = new THREE.Mesh(
        new THREE.RingGeometry(this.half * 0.98, 14000, 48, 1),
        new THREE.MeshBasicMaterial({ color: 0x2b2820, fog: true })
      );
      skirt.geometry.rotateX(-Math.PI / 2);
      skirt.position.y = -26;
      skirt.renderOrder = -5;
      scene.add(skirt);
      this.skirt = skirt;
    }

    _baseHeights() {
      const n = this.noise, N = this.n;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const x = -this.half + i * this.sp;
          const z = -this.half + j * this.sp;
          const u = x * 0.00085, v = z * 0.00085;
          let hh = n.fbm(u, v, 5) * 78;                 // broad steppe swells
          hh += n.fbm(u * 3.1 + 41, v * 3.1 - 17, 4) * 17;
          hh += n.ridge(u * 1.6 - 9, v * 1.6 + 5, 4) * 26; // low spoil ridges
          // river / drainage valley cutting across the AO
          const river = Math.abs(z - Math.sin(x * 0.0016) * 320 - 140);
          hh -= Math.exp(-river * river / (2 * 210 * 210)) * 42;
          // flatten the launch plateau in the south
          const dz = z - this.half * 0.78;
          hh = M.lerp(hh, 8, M.smoothstep(260, 60, Math.hypot(x * 0.55, dz)));
          this.h[j * N + i] = hh;
        }
      }
    }

    idx(i, j) { return j * this.n + i; }

    // world -> grid, with bilinear interpolation
    heightAt(x, z) {
      const fx = (x + this.half) / this.sp;
      const fz = (z + this.half) / this.sp;
      let i = Math.floor(fx), j = Math.floor(fz);
      if (i < 0) i = 0; if (j < 0) j = 0;
      if (i > this.n - 2) i = this.n - 2;
      if (j > this.n - 2) j = this.n - 2;
      const tx = M.clamp(fx - i, 0, 1), tz = M.clamp(fz - j, 0, 1);
      const h = this.h, N = this.n;
      const a = h[j * N + i], b = h[j * N + i + 1];
      const c = h[(j + 1) * N + i], d = h[(j + 1) * N + i + 1];
      return M.lerp(M.lerp(a, b, tx), M.lerp(c, d, tx), tz);
    }

    _normals(i0, j0, i1, j1) {
      const N = this.n, h = this.h, nrm = this.geo.attributes.normal.array;
      const s2 = this.sp * 2;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const il = Math.max(0, i - 1), ir = Math.min(N - 1, i + 1);
          const jd = Math.max(0, j - 1), ju = Math.min(N - 1, j + 1);
          const nx = h[j * N + il] - h[j * N + ir];
          const nz = h[jd * N + i] - h[ju * N + i];
          const len = Math.hypot(nx, s2, nz) || 1;
          const k = (j * N + i) * 3;
          nrm[k] = nx / len; nrm[k + 1] = s2 / len; nrm[k + 2] = nz / len;
        }
      }
      this.geo.attributes.normal.needsUpdate = true;
    }

    _colors(i0, j0, i1, j1) {
      const N = this.n, h = this.h, col = this.geo.attributes.color.array, n = this.noise;
      const c = new THREE.Color();
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * N + i;
          const x = -this.half + i * this.sp, z = -this.half + j * this.sp;
          const hh = h[k];
          const wet = M.smoothstep(-16, -46, hh);              // valley floor mud
          const patch = n.fbm(x * 0.0042, z * 0.0042, 4) * 0.5 + 0.5;
          const dry = n.fbm(x * 0.017 + 100, z * 0.017, 3) * 0.5 + 0.5;
          // dead-winter palette: olive drab -> ochre -> cold mud
          let r = M.lerp(0.235, 0.375, patch) * M.lerp(1, 0.66, wet);
          let g = M.lerp(0.255, 0.360, patch) * M.lerp(1, 0.64, wet);
          let b = M.lerp(0.185, 0.235, patch) * M.lerp(1, 0.74, wet);
          const t = 0.86 + dry * 0.28;
          r *= t; g *= t; b *= t;
          const burn = this.burn[k];
          if (burn > 0) {
            const bf = M.clamp(burn, 0, 1);
            r = M.lerp(r, 0.075, bf); g = M.lerp(g, 0.068, bf); b = M.lerp(b, 0.062, bf);
          }
          c.setRGB(r, g, b).convertSRGBToLinear();
          const k3 = k * 3;
          col[k3] = c.r; col[k3 + 1] = c.g; col[k3 + 2] = c.b;
        }
      }
      this.geo.attributes.color.needsUpdate = true;
    }

    /* Punch a crater into the mesh — geometry, shading and burn scar. */
    crater(x, z, radius, depth) {
      const N = this.n;
      const i0 = M.clamp(Math.floor((x - radius + this.half) / this.sp) - 1, 0, N - 1);
      const i1 = M.clamp(Math.ceil((x + radius + this.half) / this.sp) + 1, 0, N - 1);
      const j0 = M.clamp(Math.floor((z - radius + this.half) / this.sp) - 1, 0, N - 1);
      const j1 = M.clamp(Math.ceil((z + radius + this.half) / this.sp) + 1, 0, N - 1);
      if (i1 <= i0 || j1 <= j0) return;
      const pos = this.geo.attributes.position;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const px = -this.half + i * this.sp, pz = -this.half + j * this.sp;
          const d = Math.hypot(px - x, pz - z) / radius;
          if (d > 1.35) continue;
          const k = j * N + i;
          // bowl with a raised ejecta lip
          const bowl = -depth * Math.pow(Math.max(0, 1 - d * d), 1.6);
          const lip = depth * 0.30 * Math.exp(-Math.pow((d - 1.0) * 3.1, 2));
          this.h[k] += bowl + lip;
          this.burn[k] = Math.min(1, this.burn[k] + (1 - M.smoothstep(0.4, 1.25, d)) * 0.95);
          pos.setY(k, this.h[k]);
        }
      }
      pos.needsUpdate = true;
      this._normals(i0, j0, i1, j1);
      this._colors(i0, j0, i1, j1);
    }

    flatten(x, z, radius, targetH) {
      const N = this.n;
      const i0 = M.clamp(Math.floor((x - radius + this.half) / this.sp), 0, N - 1);
      const i1 = M.clamp(Math.ceil((x + radius + this.half) / this.sp), 0, N - 1);
      const j0 = M.clamp(Math.floor((z - radius + this.half) / this.sp), 0, N - 1);
      const j1 = M.clamp(Math.ceil((z + radius + this.half) / this.sp), 0, N - 1);
      const pos = this.geo.attributes.position;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const px = -this.half + i * this.sp, pz = -this.half + j * this.sp;
          const d = Math.hypot(px - x, pz - z) / radius;
          if (d > 1.3) continue;
          const k = j * N + i;
          this.h[k] = M.lerp(this.h[k], targetH, 1 - M.smoothstep(0.55, 1.25, d));
          pos.setY(k, this.h[k]);
        }
      }
      pos.needsUpdate = true;
      this._normals(i0, j0, i1, j1);
      this._colors(i0, j0, i1, j1);
    }
  }
  G.Terrain = Terrain;

  /* =====================================================================
     SHARED MATERIALS
     ===================================================================== */
  function mats() {
    if (G._mats) return G._mats;
    const rep = (t, r) => { const c = t.clone(); c.needsUpdate = true; c.repeat.set(r, r); c.wrapS = c.wrapT = THREE.RepeatWrapping; return c; };
    const m = {
      steel: new THREE.MeshStandardMaterial({ map: rep(G.getTex('steel'), 1), color: 0xb2b6b0, roughness: 0.72, metalness: 0.65 }),
      charred: new THREE.MeshStandardMaterial({ map: rep(G.getTex('charred'), 1), color: 0x8a8580, roughness: 0.94, metalness: 0.4 }),
      concrete: new THREE.MeshStandardMaterial({ map: rep(G.getTex('concrete'), 1), color: 0xc0bab0, roughness: 0.95, metalness: 0.0 }),
      sandbag: new THREE.MeshStandardMaterial({ map: rep(G.getTex('sandbag'), 1), color: 0xc4bda6, roughness: 1.0, metalness: 0.0 }),
      camo: new THREE.MeshStandardMaterial({ map: rep(G.getTex('camo'), 1), color: 0xb6bcaa, roughness: 0.95, metalness: 0.05 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x8b7050, roughness: 1.0 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x4a4642, roughness: 0.9, metalness: 0.3 }),
      olive: new THREE.MeshStandardMaterial({ color: 0x707d5c, roughness: 0.92, metalness: 0.1 }),
      flesh: new THREE.MeshStandardMaterial({ color: 0x9a8a70, roughness: 1.0 }),
      glassGlow: new THREE.MeshBasicMaterial({ color: 0xff5522 }),
    };
    // colours above are authored in sRGB; r128 uploads material colours raw,
    // so convert once here or everything renders washed out
    for (const k in m) if (m[k].color) m[k].color.convertSRGBToLinear();
    G._mats = m;
    return m;
  }

  function box(w, h, d, mat, x, y, z) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }
  function cyl(rt, rb, h, seg, mat, x, y, z) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 10), mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  /* =====================================================================
     MODELS
     ===================================================================== */
  const Models = {};

  Models.tank = function (destroyed) {
    const m = mats();
    const g = new THREE.Group();
    const body = destroyed ? m.charred : m.olive;
    const hull = box(7.4, 2.0, 3.6, body, 0, 2.0, 0);
    g.add(hull);
    g.add(box(6.2, 0.9, 4.6, body, 0, 1.15, 0));
    // tracks + road wheels
    for (const s of [-1, 1]) {
      g.add(box(7.8, 1.5, 1.0, m.dark, 0, 0.85, s * 1.85));
      for (let i = -3; i <= 3; i++) {
        const w = cyl(0.6, 0.6, 0.9, 10, m.dark, i * 1.15, 0.85, s * 1.85);
        w.rotation.x = Math.PI / 2;
        g.add(w);
      }
    }
    // turret
    const tur = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 2.25, 1.25, 12), body);
    dome.castShadow = true; tur.add(dome);
    const barrel = cyl(0.22, 0.26, 6.0, 10, m.steel, 0, 0.15, 0);
    barrel.rotation.z = Math.PI / 2;
    barrel.position.set(3.4, 0.15, 0);
    tur.add(barrel);
    tur.position.set(-0.3, 3.2, 0);
    if (destroyed) {
      tur.rotation.y = 2.1;
      tur.position.set(-3.6, 1.2, 3.4);
      tur.rotation.z = 0.5;
    }
    g.add(tur);
    g.userData.turret = tur;
    return g;
  };

  Models.bmp = function (destroyed) {
    const m = mats();
    const g = new THREE.Group();
    const body = destroyed ? m.charred : m.camo;
    const hull = new THREE.Mesh(new THREE.BoxGeometry(6.6, 1.7, 3.0), body);
    hull.position.y = 1.9; hull.castShadow = true; hull.receiveShadow = true; g.add(hull);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.1, 2.7), body);
    nose.position.set(3.6, 1.55, 0); nose.rotation.z = -0.25; nose.castShadow = true; g.add(nose);
    for (const s of [-1, 1]) g.add(box(6.8, 1.3, 0.85, m.dark, 0, 0.8, s * 1.6));
    const tur = new THREE.Mesh(new THREE.ConeGeometry(1.25, 1.1, 8), body);
    tur.position.set(-0.4, 3.2, 0); tur.castShadow = true; g.add(tur);
    const bar = cyl(0.11, 0.13, 3.6, 8, m.steel, 1.6, 3.3, 0);
    bar.rotation.z = Math.PI / 2; g.add(bar);
    return g;
  };

  Models.aaGun = function () {
    const m = mats();
    const g = new THREE.Group();
    // towed carriage
    g.add(box(3.4, 0.5, 2.4, m.olive, 0, 0.9, 0));
    for (const s of [-1, 1]) {
      const w = cyl(0.75, 0.75, 0.4, 14, m.dark, -0.4, 0.75, s * 1.5);
      w.rotation.x = Math.PI / 2; g.add(w);
    }
    g.add(box(0.5, 0.5, 3.6, m.olive, 1.2, 0.55, 0));
    const yaw = new THREE.Group();
    yaw.position.y = 1.3;
    g.add(yaw);
    yaw.add(cyl(0.55, 0.8, 0.7, 12, m.olive, 0, 0.3, 0));
    const pitch = new THREE.Group();
    pitch.position.y = 0.85;
    yaw.add(pitch);
    // shield
    const sh = box(0.16, 1.5, 2.4, m.olive, 0.7, 0.35, 0);
    pitch.add(sh);
    // twin barrels
    for (const s of [-1, 1]) {
      const b = cyl(0.10, 0.13, 3.4, 8, m.steel, 1.9, 0.15, s * 0.32);
      b.rotation.z = Math.PI / 2;
      pitch.add(b);
      const mz = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.0),
        new THREE.MeshBasicMaterial({ map: G.getTex('flash'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      mz.position.set(3.7, 0.15, s * 0.32);
      mz.visible = false;
      pitch.add(mz);
      if (!g.userData.flashes) g.userData.flashes = [];
      g.userData.flashes.push(mz);
    }
    // ammo box + crew seat
    pitch.add(box(0.6, 0.5, 0.7, m.dark, -0.5, 0.1, 0.9));
    g.userData.yaw = yaw;
    g.userData.pitch = pitch;
    g.userData.muzzle = new V3(3.9, 2.3, 0);
    return g;
  };

  Models.bunker = function () {
    const m = mats();
    const g = new THREE.Group();
    // sandbag revetment ring
    const R = 5.2;
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2;
      if (a > 1.9 && a < 2.7) continue; // entrance
      const b = box(2.0, 1.5, 1.2, m.sandbag, Math.cos(a) * R, 0.75, Math.sin(a) * R);
      b.rotation.y = -a;
      g.add(b);
      if (i % 2 === 0) {
        const b2 = box(1.8, 1.3, 1.1, m.sandbag, Math.cos(a) * R, 2.05, Math.sin(a) * R);
        b2.rotation.y = -a + 0.2; g.add(b2);
      }
    }
    // dug-in command shelter
    g.add(box(6.4, 2.6, 5.0, m.concrete, 0, 1.3, 0));
    const roof = box(7.4, 0.7, 6.0, m.concrete, 0, 2.9, 0);
    g.add(roof);
    // logs + earth on the roof
    for (let i = -3; i <= 3; i++) {
      const l = cyl(0.32, 0.32, 6.0, 7, m.wood, i * 1.05, 3.45, 0);
      l.rotation.x = Math.PI / 2; g.add(l);
    }
    // antenna mast + guy wires
    const mast = cyl(0.07, 0.12, 11, 6, m.steel, 2.4, 9.2, -1.8);
    g.add(mast);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * 6.283;
      const pts = [new V3(2.4, 14.6, -1.8), new V3(2.4 + Math.cos(a) * 5, 0.2, -1.8 + Math.sin(a) * 5)];
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x1a1a18 }));
      g.add(line);
    }
    // dish
    const dish = new THREE.Mesh(new THREE.SphereGeometry(1.05, 12, 8, 0, 6.283, 0, 1.0), m.steel);
    dish.rotation.x = -1.1; dish.position.set(2.4, 13.2, -1.8);
    dish.castShadow = true; g.add(dish);
    return g;
  };

  Models.ammoDepot = function () {
    const m = mats();
    const g = new THREE.Group();
    const r = G.rng(555);
    for (let i = 0; i < 22; i++) {
      const c = box(1.6, 0.8, 0.9, m.olive,
        (r() - 0.5) * 9, 0.4 + Math.floor(i / 8) * 0.85, (r() - 0.5) * 7);
      c.rotation.y = r() * 0.6;
      g.add(c);
    }
    // stacked shells
    for (let i = 0; i < 10; i++) {
      const s = cyl(0.18, 0.2, 1.1, 8, m.steel, (r() - 0.5) * 8, 0.55, (r() - 0.5) * 6);
      s.rotation.z = Math.PI / 2; s.rotation.y = r() * 3;
      g.add(s);
    }
    // camo net on poles
    for (const [px, pz] of [[-5.5, -4.5], [5.5, -4.5], [-5.5, 4.5], [5.5, 4.5]]) {
      g.add(cyl(0.09, 0.09, 4.4, 6, m.wood, px, 2.2, pz));
    }
    const net = new THREE.Mesh(new THREE.PlaneGeometry(13, 11, 6, 6), new THREE.MeshStandardMaterial({
      map: G.getTex('camo'), transparent: true, opacity: 0.82, side: THREE.DoubleSide, roughness: 1,
    }));
    net.rotation.x = -Math.PI / 2; net.position.y = 4.4;
    const np = net.geometry.attributes.position;
    for (let i = 0; i < np.count; i++) np.setZ(i, Math.sin(i * 1.7) * 0.45 - 0.3);
    net.geometry.computeVertexNormals();
    g.add(net);
    return g;
  };

  Models.ewTruck = function () {
    const m = mats();
    const g = new THREE.Group();
    g.add(box(3.2, 1.9, 2.5, m.camo, 2.6, 2.0, 0));         // cab
    g.add(box(6.0, 2.8, 2.8, m.camo, -1.6, 2.5, 0));        // box body
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
      const w = cyl(0.72, 0.72, 0.55, 12, m.dark, 3.0 - i * 2.6, 0.75, s * 1.35);
      w.rotation.x = Math.PI / 2; g.add(w);
    }
    const mast = cyl(0.12, 0.16, 8, 8, m.steel, -3.2, 7.5, 0);
    g.add(mast);
    const dish = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.09, 6, 20), m.steel);
    dish.position.set(-3.2, 11.4, 0); dish.castShadow = true;
    g.add(dish);
    const inner = new THREE.Mesh(new THREE.CircleGeometry(1.45, 20),
      new THREE.MeshStandardMaterial({ color: 0x2a2f26, side: THREE.DoubleSide, roughness: 0.8 }));
    inner.position.copy(dish.position); g.add(inner);
    g.userData.dish = dish;
    g.userData.dishInner = inner;
    return g;
  };

  Models.infantry = function () {
    const m = mats();
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 1.15, 8), m.camo);
    body.position.y = 1.05; body.castShadow = true; g.add(body);
    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.22, 0.9, 6), m.olive);
    legs.position.y = 0.45; legs.castShadow = true; g.add(legs);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), m.olive);
    head.position.y = 1.72; head.castShadow = true; g.add(head);
    const rifle = box(1.0, 0.07, 0.07, m.dark, 0.4, 1.15, 0.22);
    rifle.rotation.y = 0.25; g.add(rifle);
    const pack = box(0.3, 0.5, 0.45, m.olive, -0.28, 1.1, 0);
    g.add(pack);
    return g;
  };

  Models.ruin = function (rng, w, h, d) {
    const m = mats();
    const g = new THREE.Group();
    const floors = Math.max(1, Math.round(h / 3.4));
    for (let f = 0; f < floors; f++) {
      const shrink = 1 - f * 0.04;
      const fw = w * shrink, fd = d * shrink;
      const damaged = f >= floors - 1 && rng() > 0.35;
      // four walls, each possibly blown open
      const walls = [
        [0, 0, fd / 2, fw, 0],
        [0, 0, -fd / 2, fw, 0],
        [fw / 2, 0, 0, fd, Math.PI / 2],
        [-fw / 2, 0, 0, fd, Math.PI / 2],
      ];
      for (const [wx, , wz, len, rot] of walls) {
        const segs = 3;
        for (let s = 0; s < segs; s++) {
          if (rng() < (damaged ? 0.55 : 0.18)) continue; // collapsed section
          const sl = len / segs;
          const wall = new THREE.Mesh(new THREE.BoxGeometry(sl * 0.98, 3.2 * (damaged ? 0.4 + rng() * 0.6 : 1), 0.4), m.concrete);
          const off = (s - (segs - 1) / 2) * sl;
          wall.position.set(wx + (rot ? 0 : off), f * 3.4 + 1.6, wz + (rot ? off : 0));
          wall.rotation.y = rot;
          wall.castShadow = true; wall.receiveShadow = true;
          g.add(wall);
        }
      }
      // floor slab
      if (f > 0 && rng() > 0.25) {
        const slab = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.3, fd), m.concrete);
        slab.position.y = f * 3.4;
        slab.castShadow = true; slab.receiveShadow = true;
        g.add(slab);
      }
    }
    // rubble skirt
    for (let i = 0; i < 16; i++) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.5 + rng() * 1.6, 0.4 + rng(), 0.5 + rng() * 1.4), m.concrete);
      const a = rng() * 6.283, dd = w * 0.5 + rng() * 5;
      r.position.set(Math.cos(a) * dd, 0.3, Math.sin(a) * dd);
      r.rotation.set(rng(), rng() * 3, rng());
      r.castShadow = true;
      g.add(r);
    }
    return g;
  };

  G.Models = Models;

  /* =====================================================================
     TARGETS / ENTITIES
     ===================================================================== */
  let TARGET_ID = 1;
  class Target {
    constructor(cfg) {
      this.id = TARGET_ID++;
      Object.assign(this, cfg);
      this.hp = this.maxHp = cfg.hp || 100;
      this.alive = true;
      this.pos = cfg.group.position;
      this.radius = cfg.radius || 6;
      this.smokeT = 0;
      this.fireT = 0;
      this.cool = Math.random() * 2;
      this.burst = 0;
    }
    damage(d, fx) {
      if (!this.alive) return false;
      this.hp -= d;
      if (this.hp <= 0) { this.kill(fx); return true; }
      return false;
    }
    kill(fx) {
      if (!this.alive) return;
      this.alive = false;
      this.dead = true;
      this.burning = 14 + Math.random() * 8;
      const p = this.pos;
      fx.explode(new V3(p.x, p.y + this.radius * 0.4, p.z), this.blast || 9);
      if (this.terrain) this.terrain.crater(p.x, p.z, this.radius * 1.5, this.radius * 0.45);
      // wreck the model
      this.group.traverse((o) => {
        if (o.isMesh && o.material && o.material.color) {
          o.material = o.material.clone();
          o.material.color.multiplyScalar(0.30);
          if (o.material.roughness !== undefined) o.material.roughness = 1;
        }
      });
      this.group.rotation.z += (Math.random() - 0.5) * 0.35;
      this.group.rotation.x += (Math.random() - 0.5) * 0.25;
      if (this.onKill) this.onKill(this);
    }
    update(dt, ctx) {
      if (this.dead) {
        if (this.burning > 0) {
          this.burning -= dt;
          this.fireT -= dt;
          if (this.fireT <= 0) {
            this.fireT = 0.05;
            const p = this.pos, r = this.radius * 0.6;
            ctx.fx.fire.spawn({
              x: p.x + (Math.random() - 0.5) * r, y: p.y + 1 + Math.random() * 2, z: p.z + (Math.random() - 0.5) * r,
              vx: (Math.random() - 0.5) * 1.6, vy: 4 + Math.random() * 4, vz: (Math.random() - 0.5) * 1.6,
              life: 0.5 + Math.random() * 0.4, size0: 2.4, size1: 0.6,
              grav: -6, drag: 1.2, r: 1.5, g: 0.68, b: 0.22, r1: 0.7, g1: 0.18, b1: 0.03,
            });
          }
        }
        this.smokeT -= dt;
        if (this.smokeT <= 0 && (this.burning > -40)) {
          this.smokeT = 0.10;
          const p = this.pos;
          ctx.fx.smoke.spawn({
            x: p.x + (Math.random() - 0.5) * 3, y: p.y + 2, z: p.z + (Math.random() - 0.5) * 3,
            vx: (Math.random() - 0.5) * 2, vy: 5 + Math.random() * 5, vz: (Math.random() - 0.5) * 2,
            life: 5 + Math.random() * 5, size0: 4, size1: 24,
            rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 0.4,
            grav: -1.1, drag: 0.4, alpha: 0.55,
            r: 0.06, g: 0.055, b: 0.05, r1: 0.20, g1: 0.20, b1: 0.215,
          });
        }
        return;
      }
      if (this.behavior) this.behavior(dt, ctx);
    }
  }
  G.Target = Target;

  /* =====================================================================
     WORLD BUILD
     ===================================================================== */
  G.buildWorld = function (scene, terrain, fx, seed) {
    const rng = G.rng(seed || 20260525);
    const m = mats();
    const targets = [];
    const groundAt = (x, z) => terrain.heightAt(x, z);

    function place(group, x, z, yOff, ry) {
      group.position.set(x, groundAt(x, z) + (yOff || 0), z);
      group.rotation.y = ry === undefined ? rng() * 6.283 : ry;
      scene.add(group);
      return group;
    }

    /* ---------------- Ukrainian line (south) : friendly trenches -------- */
    const trenchGroups = [];
    function trenchLine(x0, z0, x1, z1, segs, friendly) {
      const g = new THREE.Group();
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const x = M.lerp(x0, x1, t) + Math.sin(t * 9) * 14;
        const z = M.lerp(z0, z1, t) + Math.cos(t * 7) * 11;
        const y = groundAt(x, z);
        terrain.flatten(x, z, 16, y - 1.6);
        const ang = Math.atan2(z1 - z0, x1 - x0) + Math.PI / 2;
        // parapet of sandbags along the front lip
        for (let k = -2; k <= 2; k++) {
          const px = x + Math.cos(ang) * (5 + k * 0.1), pz = z + Math.sin(ang) * (5 + k * 0.1);
          const b = box(2.4, 1.1, 1.3, m.sandbag, px, groundAt(px, pz) + 0.55 + Math.abs(k) * 0.0, pz);
          b.rotation.y = -ang + (rng() - 0.5) * 0.2;
          b.position.x += Math.cos(ang + Math.PI / 2) * k * 2.4;
          b.position.z += Math.sin(ang + Math.PI / 2) * k * 2.4;
          b.position.y = groundAt(b.position.x, b.position.z) + 0.55;
          g.add(b);
        }
        // timber revetment posts
        for (let k = -2; k <= 2; k += 2) {
          const px = x + Math.cos(ang + Math.PI / 2) * k * 2.4;
          const pz = z + Math.sin(ang + Math.PI / 2) * k * 2.4;
          const p = cyl(0.14, 0.14, 2.2, 6, m.wood, px, groundAt(px, pz) + 0.9, pz);
          g.add(p);
        }
        // dugout every few segments
        if (i % 3 === 0) {
          const d = box(3.2, 1.6, 2.6, m.wood, x, groundAt(x, z) + 0.6, z);
          d.rotation.y = -ang; g.add(d);
          const cover = box(3.6, 0.3, 3.0, m.dark, x, groundAt(x, z) + 1.5, z);
          cover.rotation.y = -ang; g.add(cover);
        }
      }
      scene.add(g);
      trenchGroups.push({ g, friendly });
      return g;
    }

    trenchLine(-900, 620, 900, 700, 26, true);
    trenchLine(-1000, -240, 950, -180, 26, false);
    trenchLine(-1050, -520, 700, -600, 20, false);

    /* ---------------- treelines & scrub (instanced billboards) ---------- */
    (function foliage() {
      const tex = G.getTex('foliage');
      const mat = new THREE.MeshStandardMaterial({
        map: tex, transparent: true, alphaTest: 0.42, side: THREE.DoubleSide,
        roughness: 1, metalness: 0, color: 0xa8a8a0,
      });
      const plane = new THREE.PlaneGeometry(1, 1);
      plane.translate(0, 0.5, 0);
      const cross = plane.clone();
      cross.rotateY(Math.PI / 2);
      const geo = mergeGeoms([plane, cross]);
      const COUNT = 1500;
      const inst = new THREE.InstancedMesh(geo, mat, COUNT);
      inst.castShadow = true;
      inst.receiveShadow = true;
      const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      const s = new V3(), p = new V3();
      let n = 0;
      const noise = terrain.noise;
      // shelterbelt rows typical of the steppe, plus scattered scrub
      const belts = [
        [-1200, 380, 1200, 340], [-1200, -60, 1200, -20],
        [-260, -1200, -180, 1200], [700, -1200, 640, 1200],
      ];
      for (const [ax, az, bx, bz] of belts) {
        const len = Math.hypot(bx - ax, bz - az);
        const steps = Math.floor(len / 13);
        for (let i = 0; i < steps && n < COUNT; i++) {
          const t = i / steps;
          for (let r = -1; r <= 1; r++) {
            if (n >= COUNT) break;
            const x = M.lerp(ax, bx, t) + r * 9 + (rng() - 0.5) * 7;
            const z = M.lerp(az, bz, t) + r * 4 + (rng() - 0.5) * 7;
            const sc = 11 + rng() * 12;
            p.set(x, groundAt(x, z) - 0.4, z);
            s.set(sc * (0.7 + rng() * 0.5), sc, sc);
            q.setFromEuler(e.set(0, rng() * 3.14, 0));
            mtx.compose(p, q, s);
            inst.setMatrixAt(n++, mtx);
          }
        }
      }
      while (n < COUNT) {
        const x = (rng() - 0.5) * terrain.size * 0.95;
        const z = (rng() - 0.5) * terrain.size * 0.95;
        const d = noise.fbm(x * 0.002, z * 0.002, 3);
        if (d < 0.05) { // clumped, not uniform
          const sc = 4 + rng() * 7;
          p.set(x, groundAt(x, z) - 0.3, z);
          s.set(sc * (0.8 + rng() * 0.6), sc * 0.8, sc);
          q.setFromEuler(e.set(0, rng() * 3.14, 0));
          mtx.compose(p, q, s);
          inst.setMatrixAt(n++, mtx);
        } else {
          mtx.compose(p.set(0, -9999, 0), q.identity(), s.set(1, 1, 1));
          inst.setMatrixAt(n++, mtx);
        }
      }
      inst.instanceMatrix.needsUpdate = true;
      scene.add(inst);
    })();

    /* ---------------- power line running across the AO ------------------ */
    (function powerline() {
      const pts = [];
      for (let i = 0; i <= 14; i++) {
        const x = -1250 + i * 180, z = 120 + Math.sin(i * 0.6) * 60;
        pts.push(new V3(x, groundAt(x, z), z));
      }
      const wireMat = new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.75 });
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const pole = new THREE.Group();
        pole.add(cyl(0.22, 0.34, 17, 6, m.wood, 0, 8.5, 0));
        pole.add(box(0.25, 0.25, 7, m.wood, 0, 15.6, 0));
        pole.add(box(0.22, 0.22, 5, m.wood, 0, 13.4, 0));
        if (rng() > 0.75) { pole.rotation.z = (rng() - 0.5) * 0.5; } // knocked askew
        pole.position.copy(p);
        scene.add(pole);
        if (i < pts.length - 1) {
          for (const off of [-3, 0, 3]) {
            const a = new V3(p.x, p.y + 15.6, p.z + off);
            const b = new V3(pts[i + 1].x, pts[i + 1].y + 15.6, pts[i + 1].z + off);
            const seg = [];
            for (let k = 0; k <= 8; k++) {
              const t = k / 8;
              const v = a.clone().lerp(b, t);
              v.y -= Math.sin(t * Math.PI) * 3.2;
              seg.push(v);
            }
            if (rng() > 0.85) continue; // downed wire
            scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(seg), wireMat));
          }
        }
      }
    })();

    /* ---------------- ruined settlement -------------------------------- */
    const ruinSpots = [];
    (function village() {
      for (let i = 0; i < 16; i++) {
        const x = -520 + (i % 4) * 95 + (rng() - 0.5) * 30;
        const z = -720 + Math.floor(i / 4) * 88 + (rng() - 0.5) * 30;
        const w = 12 + rng() * 12, d = 10 + rng() * 10, h = 4 + rng() * 11;
        terrain.flatten(x, z, Math.max(w, d) * 0.8, groundAt(x, z));
        const b = Models.ruin(rng, w, h, d);
        place(b, x, z, 0, rng() * 6.283);
        ruinSpots.push(new V3(x, groundAt(x, z), z));
        // some are still burning
        if (rng() > 0.55) {
          const t = new Target({
            type: 'fire', group: b, radius: Math.max(w, d) * 0.5, hp: 1e9,
            terrain: null, label: 'RUIN',
          });
          t.dead = true; t.alive = false; t.burning = 1e6;
          t.pos = b.position;
          targets.push(t);
        }
      }
    })();

    /* ---------------- static wrecks (atmosphere, not objectives) -------- */
    for (let i = 0; i < 12; i++) {
      const x = (rng() - 0.5) * 2100, z = (rng() - 0.5) * 1600 - 200;
      const wreck = rng() > 0.5 ? Models.tank(true) : Models.bmp(true);
      place(wreck, x, z, 0.2);
      wreck.rotation.z = (rng() - 0.5) * 0.3;
      terrain.crater(x, z, 14, 3.2);
      if (rng() > 0.5) {
        const t = new Target({ type: 'wreck', group: wreck, radius: 5, hp: 1e9 });
        t.dead = true; t.alive = false; t.burning = rng() > 0.5 ? 1e6 : -1e6;
        targets.push(t);
      }
    }

    /* ---------------- pre-existing shell craters ------------------------ */
    for (let i = 0; i < 70; i++) {
      const x = (rng() - 0.5) * 2300, z = (rng() - 0.5) * 2000;
      const r = 6 + rng() * 16;
      terrain.crater(x, z, r, r * 0.34);
    }

    /* =================== OBJECTIVES ==================== */
    function makeTarget(kind, x, z, cfg) {
      const g = cfg.model();
      terrain.flatten(x, z, cfg.flat || 12, groundAt(x, z));
      place(g, x, z, cfg.yOff || 0, cfg.ry);
      const t = new Target(Object.assign({
        type: kind, group: g, terrain: terrain,
      }, cfg));
      targets.push(t);
      return t;
    }

    // --- AA emplacements: the things that actually shoot back
    const aaSpots = [[-430, -420], [380, -520], [-60, -880], [820, -300]];
    const aaGuns = [];
    for (const [x, z] of aaSpots) {
      const t = makeTarget('aa', x, z, {
        model: Models.aaGun, hp: 60, radius: 4.5, blast: 11, flat: 14,
        label: 'ZU-23 AA', score: 350,
      });
      t.range = 620;
      t.behavior = function (dt, ctx) {
        const p = ctx.player;
        if (!p || !p.alive) return;
        const dx = p.pos.x - this.pos.x, dy = p.pos.y - this.pos.y - 2.2, dz = p.pos.z - this.pos.z;
        const dist = Math.hypot(dx, dy, dz);
        const yawT = Math.atan2(-dz, dx);
        const pitchT = -Math.atan2(dy, Math.hypot(dx, dz));
        const yaw = this.group.userData.yaw, pit = this.group.userData.pitch;
        yaw.rotation.y = M.damp(yaw.rotation.y, yawT - this.group.rotation.y, 2.6, dt);
        pit.rotation.z = M.damp(pit.rotation.z, M.clamp(pitchT, -1.35, 0.2), 3.0, dt);
        if (dist > this.range || p.pos.y - ctx.groundAt(p.pos.x, p.pos.z) < 3) return;
        this.cool -= dt;
        if (this.cool <= 0) {
          this.cool = 1.5 + Math.random() * 1.6;
          this.burst = 6 + Math.floor(Math.random() * 5);
          this.burstT = 0;
        }
        if (this.burst > 0) {
          this.burstT -= dt;
          if (this.burstT <= 0) {
            this.burstT = 0.075;
            this.burst--;
            const muzzle = this.group.userData.muzzle.clone();
            muzzle.applyMatrix4(this.group.matrixWorld);
            // lead the target, but imperfectly — this is a moving FPV drone
            const lead = 0.55 + Math.random() * 0.35;
            const aim = new V3(
              p.pos.x + p.vel.x * lead * (dist / 320),
              p.pos.y + p.vel.y * lead * (dist / 320),
              p.pos.z + p.vel.z * lead * (dist / 320)
            );
            const dir = aim.sub(muzzle).normalize();
            const spread = 0.026 + dist * 0.00006;
            dir.x += (Math.random() - 0.5) * spread;
            dir.y += (Math.random() - 0.5) * spread;
            dir.z += (Math.random() - 0.5) * spread;
            dir.normalize();
            ctx.fx.tracers.fire(muzzle, dir, 420, 0xff6a2a, 2.2, true, 16);
            ctx.fx.flashLight(muzzle, 4.5, 0.07, 0xffa040, 70);
            const fl = this.group.userData.flashes;
            if (fl) { const f = fl[this.burst % fl.length]; f.visible = true; f._t = 0.05; }
            ctx.fx.sparks.spawn({
              x: muzzle.x, y: muzzle.y, z: muzzle.z,
              vx: dir.x * 20, vy: dir.y * 20, vz: dir.z * 20,
              life: 0.09, size0: 3.2, size1: 0.4, r: 3, g: 1.8, b: 0.7,
            });
          }
        }
        const fl = this.group.userData.flashes;
        if (fl) for (const f of fl) {
          if (f.visible) { f._t -= dt; if (f._t <= 0) f.visible = false; else f.lookAt(ctx.camera.position); }
        }
      };
      aaGuns.push(t);
    }

    // --- command post
    const cp = makeTarget('cp', -140, -690, {
      model: Models.bunker, hp: 120, radius: 8, blast: 16, flat: 20,
      label: 'COMMAND POST', score: 700, ry: 0.4,
    });

    // --- ammo depot
    const depot = makeTarget('depot', 610, -760, {
      model: Models.ammoDepot, hp: 80, radius: 8, blast: 18, flat: 18,
      label: 'AMMO DEPOT', score: 600,
    });
    depot.onKill = function () {
      // cook-off: a long chain of secondaries
      let n = 0;
      const iv = setInterval(() => {
        if (n++ > 8) { clearInterval(iv); return; }
        const p = this.pos;
        fx.explode(new V3(p.x + (Math.random() - 0.5) * 24, p.y + Math.random() * 8, p.z + (Math.random() - 0.5) * 24),
          5 + Math.random() * 8);
      }, 260);
    };

    // --- EW / jammer trucks
    const jammers = [];
    for (const [x, z] of [[-780, -560], [430, -300]]) {
      const t = makeTarget('ew', x, z, {
        model: Models.ewTruck, hp: 55, radius: 5, blast: 12, flat: 14,
        label: 'EW JAMMER', score: 500,
      });
      t.jamRadius = 420;
      t.behavior = function (dt, ctx) {
        const d = this.group.userData.dish;
        if (!d) return;
        d.rotation.z += dt * 1.1;
        const inner = this.group.userData.dishInner;
        if (inner) inner.rotation.z = d.rotation.z;
      };
      jammers.push(t);
    }

    // --- armour column (multiple targets forming one objective)
    const column = [];
    for (let i = 0; i < 5; i++) {
      const x = -960 + i * 46 + (rng() - 0.5) * 10;
      const z = -960 + i * 22;
      const t = makeTarget('armour', x, z, {
        model: () => (i % 2 ? Models.bmp(false) : Models.tank(false)),
        hp: 70, radius: 5.5, blast: 14, flat: 12,
        label: i % 2 ? 'BMP-3' : 'T-72', score: 400, ry: 0.6,
      });
      column.push(t);
    }

    // --- dismounted infantry advancing on our trench
    const infantry = [];
    for (let i = 0; i < 14; i++) {
      const x = -260 + (rng() - 0.5) * 900;
      const z = -120 + (rng() - 0.5) * 260;
      const t = makeTarget('inf', x, z, {
        model: Models.infantry, hp: 22, radius: 2.4, blast: 5, flat: 0,
        label: 'INFANTRY', score: 120,
      });
      t.walkDir = new V3(rng() - 0.5, 0, 0.6 + rng() * 0.5).normalize();
      t.phase = rng() * 6.283;
      t.behavior = function (dt, ctx) {
        this.phase += dt * 5;
        const sp = 2.6;
        this.pos.x += this.walkDir.x * sp * dt;
        this.pos.z += this.walkDir.z * sp * dt;
        this.pos.y = ctx.groundAt(this.pos.x, this.pos.z);
        this.group.rotation.y = Math.atan2(this.walkDir.x, this.walkDir.z);
        this.group.position.y += Math.abs(Math.sin(this.phase)) * 0.09;
        if (this.pos.z > 560) this.walkDir.z *= -1;
      };
      infantry.push(t);
    }

    /* ---------------- burning horizon (distant city) -------------------- */
    const horizonFires = [];
    for (let i = 0; i < 7; i++) {
      const a = -0.9 + i * 0.28;
      horizonFires.push(new V3(Math.sin(a) * 2400, 0, -2200 + Math.cos(a) * 240));
    }

    return {
      targets, aaGuns, jammers, infantry, column, cp, depot, ruinSpots, horizonFires,
    };
  };

  /* small helper: merge a couple of buffer geometries (positions/normals/uv) */
  function mergeGeoms(list) {
    let vCount = 0, iCount = 0;
    for (const g of list) { vCount += g.attributes.position.count; iCount += g.index ? g.index.count : 0; }
    const pos = new Float32Array(vCount * 3);
    const nrm = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const idx = new Uint32Array(iCount);
    let vo = 0, io = 0;
    for (const g of list) {
      const p = g.attributes.position.array, n = g.attributes.normal.array, u = g.attributes.uv.array;
      pos.set(p, vo * 3); nrm.set(n, vo * 3); uv.set(u, vo * 2);
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length;
      vo += g.attributes.position.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    return out;
  }
})();
