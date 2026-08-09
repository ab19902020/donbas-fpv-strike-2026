/* =========================================================================
   DONBAS FPV 2026 — fx.js
   Custom deferred-ish post stack (HDR buffer -> 3-level bloom -> analog
   video composite) plus the GPU-instanced particle / debris / tracer
   systems that carry all of the combat spectacle.
   ========================================================================= */
(function () {
  'use strict';
  const G = window.G;
  const M = G.M;

  /* =====================================================================
     FULLSCREEN PASS HELPERS
     ===================================================================== */
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadMesh = new THREE.Mesh(quadGeo, null);
  const quadScene = new THREE.Scene();
  quadScene.add(quadMesh);

  function blit(renderer, material, target) {
    quadMesh.material = material;
    renderer.setRenderTarget(target || null);
    renderer.render(quadScene, quadCam);
  }

  const VERT = `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `;

  /* =====================================================================
     POST FX
     ===================================================================== */
  class PostFX {
    constructor(renderer, w, h) {
      this.renderer = renderer;
      const gl2 = renderer.capabilities.isWebGL2;
      const type = gl2 ? THREE.HalfFloatType : THREE.UnsignedByteType;
      const opts = {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        type: type,
        format: THREE.RGBAFormat,
        depthBuffer: true,
        stencilBuffer: false,
      };
      this.scene = new THREE.WebGLRenderTarget(w, h, opts);
      const bopts = Object.assign({}, opts, { depthBuffer: false });
      this.levels = [];
      for (let i = 0; i < 3; i++) {
        const d = Math.pow(2, i + 1);
        this.levels.push({
          a: new THREE.WebGLRenderTarget(Math.max(2, (w / d) | 0), Math.max(2, (h / d) | 0), bopts),
          b: new THREE.WebGLRenderTarget(Math.max(2, (w / d) | 0), Math.max(2, (h / d) | 0), bopts),
        });
      }

      this.bright = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uThreshold: { value: 1.05 },
          uKnee: { value: 0.55 },
        },
        vertexShader: VERT,
        fragmentShader: `
          uniform sampler2D tDiffuse; uniform float uThreshold, uKnee;
          varying vec2 vUv;
          void main(){
            vec3 c = texture2D(tDiffuse, vUv).rgb;
            float l = max(c.r, max(c.g, c.b));
            float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0*uKnee);
            soft = soft*soft/(4.0*uKnee + 1e-4);
            float w = max(soft, l - uThreshold) / max(l, 1e-4);
            gl_FragColor = vec4(min(c * w, vec3(3.2)), 1.0);
          }
        `,
      });

      this.blur = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: null },
          uDir: { value: new THREE.Vector2(1, 0) },
          uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
        },
        vertexShader: VERT,
        fragmentShader: `
          uniform sampler2D tDiffuse; uniform vec2 uDir, uTexel;
          varying vec2 vUv;
          void main(){
            vec2 o = uDir * uTexel;
            vec3 s = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
            s += texture2D(tDiffuse, vUv + o*1.3846153846).rgb * 0.3162162162;
            s += texture2D(tDiffuse, vUv - o*1.3846153846).rgb * 0.3162162162;
            s += texture2D(tDiffuse, vUv + o*3.2307692308).rgb * 0.0702702703;
            s += texture2D(tDiffuse, vUv - o*3.2307692308).rgb * 0.0702702703;
            gl_FragColor = vec4(s, 1.0);
          }
        `,
      });

      this.copy = new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: VERT,
        fragmentShader: `
          uniform sampler2D tDiffuse; varying vec2 vUv;
          void main(){ gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0); }
        `,
      });

      /* ---- the signature look: analog FPV downlink ---- */
      this.composite = new THREE.ShaderMaterial({
        uniforms: {
          tScene: { value: this.scene.texture },
          tB1: { value: this.levels[0].a.texture },
          tB2: { value: this.levels[1].a.texture },
          tB3: { value: this.levels[2].a.texture },
          tNoise: { value: G.getTex('static') },
          uRes: { value: new THREE.Vector2(w, h) },
          uTime: { value: 0 },
          uSignal: { value: 1 },      // 1 = clean link, 0 = total loss
          uGlitch: { value: 0 },      // one-shot corruption bursts
          uHit: { value: 0 },         // red damage flash
          uFlash: { value: 0 },       // white detonation flash
          uBoost: { value: 0 },       // extra barrel + speedlines on dive
          uExposure: { value: 0.98 },
          uBloom: { value: 0.44 },
          uDesat: { value: 0 },       // greys out on drone loss
          uAspect: { value: w / h },
        },
        vertexShader: VERT,
        fragmentShader: `
          uniform sampler2D tScene, tB1, tB2, tB3, tNoise;
          uniform vec2 uRes;
          uniform float uTime, uSignal, uGlitch, uHit, uFlash, uBoost, uExposure, uBloom, uDesat, uAspect;
          varying vec2 vUv;

          float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

          // Narkowicz ACES approximation
          vec3 aces(vec3 x){
            const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
            return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
          }

          void main(){
            float loss = 1.0 - uSignal;
            vec2 uv = vUv;

            // --- horizontal tearing when the link degrades -----------------
            float lineSeed = floor(uv.y * 220.0);
            float tearGate = step(0.986 - loss*0.10 - uGlitch*0.25,
                                  hash(vec2(lineSeed, floor(uTime*13.0))));
            float tear = (hash(vec2(lineSeed, floor(uTime*17.0))) - 0.5)
                         * (0.06*loss + 0.09*uGlitch) * tearGate
                         * smoothstep(0.04, 0.22, loss + uGlitch);
            uv.x += tear;

            // rolling sync bar
            float roll = fract(uv.y + uTime * 0.11);
            float bar = smoothstep(0.995, 1.0, roll) * (0.35 + loss);
            uv.x += bar * 0.010;

            // --- lens: barrel distortion + chromatic aberration ------------
            vec2 c = uv - 0.5;
            c.x *= uAspect;
            float r2 = dot(c, c);
            float k = 0.055 + uBoost * 0.055;
            vec2 d = c * (1.0 + k*r2 + 0.028*r2*r2);
            d.x /= uAspect;
            vec2 duv = d + 0.5;

            float ca = (0.0011 + r2*0.0052) * (1.0 + uGlitch*7.0 + loss*3.0);
            vec2 dir = normalize(d + 1e-6);
            vec3 col;
            col.r = texture2D(tScene, duv + dir*ca).r;
            col.g = texture2D(tScene, duv).g;
            col.b = texture2D(tScene, duv - dir*ca).b;

            // --- bloom (3 octaves, wide tail) ------------------------------
            vec3 bl = texture2D(tB1, duv).rgb * 0.55
                    + texture2D(tB2, duv).rgb * 0.28
                    + texture2D(tB3, duv).rgb * 0.20;
            col += bl * uBloom;

            // --- tone map + grade -----------------------------------------
            col = aces(col * uExposure);
            // cold shadows / warm highs, the classic Donbas winter grade
            float lum = dot(col, vec3(0.299,0.587,0.114));
            col = mix(col, vec3(lum), uDesat);
            col.rgb = mix(col.rgb, col.rgb * vec3(0.86, 0.96, 1.10), 0.35 * (1.0 - lum));
            col.rgb = mix(col.rgb, col.rgb * vec3(1.10, 1.01, 0.90), 0.30 * lum);

            // --- sensor noise, worse in the dark and on weak signal --------
            vec3 n = texture2D(tNoise, uv * (uRes / 256.0) + vec2(hash(vec2(uTime,1.0)), hash(vec2(2.0,uTime)))).rgb;
            col += (n - 0.5) * (0.016 + loss*0.30 + (1.0-lum)*0.018);

            // --- blocky digital dropout ------------------------------------
            float blockAmt = smoothstep(0.55, 1.0, loss + uGlitch*0.5);
            if (blockAmt > 0.001){
              vec2 bs = vec2(26.0, 14.0);
              vec2 bid = floor(uv * bs);
              float h = hash(bid + floor(uTime * 8.0));
              if (h > 1.0 - blockAmt * 0.55){
                vec2 juv = (bid + 0.5) / bs;
                col = mix(col, texture2D(tScene, juv).rgb + (h-0.5)*0.4, 0.85);
              }
            }

            // --- scanlines + shadow mask -----------------------------------
            float scan = 0.90 + 0.10 * sin(vUv.y * uRes.y * 1.35 + uTime * 2.0);
            col *= scan;
            col *= 0.965 + 0.035 * sin(vUv.x * uRes.x * 1.6);

            // --- speed lines on dive boost ---------------------------------
            if (uBoost > 0.01){
              float a = atan(d.y, d.x);
              float streak = pow(smoothstep(0.06, 0.55, r2), 1.5)
                           * (0.5 + 0.5*sin(a*46.0 + uTime*38.0));
              col += streak * uBoost * 0.11;
            }

            // --- flashes ----------------------------------------------------
            col = mix(col, vec3(1.0, 0.97, 0.9), min(uFlash, 0.6));
            col = mix(col, vec3(0.72, 0.03, 0.03), uHit * 0.72);

            // --- vignette + corner smear ------------------------------------
            float v = 1.0 - smoothstep(0.28, 0.92, r2 * 1.15);
            col *= mix(0.30, 1.0, v);

            // link dead: collapse to static
            col = mix(col, n * 0.85, smoothstep(0.82, 1.0, loss));

            gl_FragColor = vec4(pow(max(col, 0.0), vec3(1.0/2.2)), 1.0);
          }
        `,
      });

      this.setSize(w, h);
    }

    setSize(w, h) {
      w = Math.max(2, w | 0); h = Math.max(2, h | 0);
      this.scene.setSize(w, h);
      for (let i = 0; i < 3; i++) {
        const dd = Math.pow(2, i + 1);
        const lw = Math.max(2, (w / dd) | 0), lh = Math.max(2, (h / dd) | 0);
        this.levels[i].a.setSize(lw, lh);
        this.levels[i].b.setSize(lw, lh);
      }
      this.composite.uniforms.uRes.value.set(w, h);
      this.composite.uniforms.uAspect.value = w / h;
    }

    render(scene, camera, dt) {
      const r = this.renderer;
      r.setRenderTarget(this.scene);
      r.clear();
      r.render(scene, camera);

      // bright pass into level 0
      this.bright.uniforms.tDiffuse.value = this.scene.texture;
      blit(r, this.bright, this.levels[0].a);

      // progressive downsample + separable blur
      for (let i = 0; i < 3; i++) {
        const L = this.levels[i];
        if (i > 0) {
          this.copy.uniforms.tDiffuse.value = this.levels[i - 1].a.texture;
          blit(r, this.copy, L.a);
        }
        const tw = L.a.width, th = L.a.height;
        this.blur.uniforms.uTexel.value.set(1 / tw, 1 / th);
        this.blur.uniforms.tDiffuse.value = L.a.texture;
        this.blur.uniforms.uDir.value.set(1, 0);
        blit(r, this.blur, L.b);
        this.blur.uniforms.tDiffuse.value = L.b.texture;
        this.blur.uniforms.uDir.value.set(0, 1);
        blit(r, this.blur, L.a);
      }

      const u = this.composite.uniforms;
      u.uTime.value += dt;
      u.uGlitch.value = Math.max(0, u.uGlitch.value - dt * 2.4);
      u.uHit.value = Math.max(0, u.uHit.value - dt * 2.6);
      u.uFlash.value = Math.max(0, u.uFlash.value - dt * 8.0);
      blit(r, this.composite, null);
    }
  }
  G.PostFX = PostFX;

  /* =====================================================================
     INSTANCED BILLBOARD PARTICLES
     One draw call per system. Live particles stay packed at the front of
     the arrays via swap-remove so instanceCount is always exact.
     ===================================================================== */
  const PART_VERT = `
    attribute vec3 iPos;
    attribute vec4 iData;   // x: size  y: rotation  z: alpha  w: frame/heat
    attribute vec3 iColor;
    varying vec2 vUv;
    varying vec3 vCol;
    varying float vAlpha;
    varying float vFog;
    uniform float uFogDensity;
    void main(){
      vUv = uv; vCol = iColor; vAlpha = iData.z;
      float s = sin(iData.y), c = cos(iData.y);
      vec2 p = position.xy * iData.x;
      p = vec2(p.x*c - p.y*s, p.x*s + p.y*c);
      vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      vec3 wp = iPos + right*p.x + up*p.y;
      vec4 mv = viewMatrix * vec4(wp, 1.0);
      float dist = -mv.z;
      float f = uFogDensity * dist;
      vFog = 1.0 - exp(-f*f);
      gl_Position = projectionMatrix * mv;
    }
  `;

  class Particles {
    constructor(scene, opts) {
      const max = opts.max;
      this.max = max;
      this.count = 0;
      this.pool = [];
      for (let i = 0; i < max; i++) this.pool.push(newParticle());

      const g = new THREE.InstancedBufferGeometry();
      const quad = new THREE.PlaneGeometry(1, 1);
      g.index = quad.index;
      g.attributes.position = quad.attributes.position;
      g.attributes.uv = quad.attributes.uv;
      this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
      this.aData = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
      this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('iPos', this.aPos);
      g.setAttribute('iData', this.aData);
      g.setAttribute('iColor', this.aColor);
      g.instanceCount = 0;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

      const additive = !!opts.additive;
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          tMap: { value: opts.map },
          uFogColor: { value: (opts.fogColor || new THREE.Color(0x8d99a6)).clone() },
          uFogDensity: { value: opts.fogDensity === undefined ? 0.0016 : opts.fogDensity },
        },
        vertexShader: PART_VERT,
        fragmentShader: `
          uniform sampler2D tMap; uniform vec3 uFogColor;
          varying vec2 vUv; varying vec3 vCol; varying float vAlpha; varying float vFog;
          void main(){
            vec4 t = texture2D(tMap, vUv);
            float a = t.a * vAlpha;
            if (a < 0.004) discard;
            vec3 c = t.rgb * vCol;
            ${additive
            ? 'c *= (1.0 - vFog*0.85); gl_FragColor = vec4(c*a, a);'
            : 'c = mix(c, uFogColor, vFog); gl_FragColor = vec4(c, a);'}
          }
        `,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        side: THREE.DoubleSide,
      });
      if (additive) mat.blending = THREE.CustomBlending,
        mat.blendSrc = THREE.OneFactor, mat.blendDst = THREE.OneMinusSrcAlphaFactor;

      this.mesh = new THREE.Mesh(g, mat);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = additive ? 12 : 10;
      this.material = mat;
      this.geometry = g;
      scene.add(this.mesh);
    }

    spawn(cfg) {
      if (this.count >= this.max) {
        // recycle the oldest (front of the live block)
        this.count--;
        const dead = this.pool[0];
        this.pool[0] = this.pool[this.count];
        this.pool[this.count] = dead;
      }
      const p = this.pool[this.count++];
      p.reset(cfg);
      return p;
    }

    update(dt, wind) {
      const live = this.count;
      for (let i = 0; i < this.count; i++) {
        const p = this.pool[i];
        p.life -= dt;
        if (p.life <= 0) {
          this.count--;
          const t = this.pool[i];
          this.pool[i] = this.pool[this.count];
          this.pool[this.count] = t;
          i--;
          continue;
        }
        p.vy -= p.grav * dt;
        p.vx += (wind.x - p.vx) * p.drag * dt;
        p.vz += (wind.z - p.vz) * p.drag * dt;
        p.vy -= p.vy * p.drag * dt * 0.5;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.rot += p.spin * dt;
        if (p.y < p.floor) { p.y = p.floor; p.vy *= -0.15; p.vx *= 0.7; p.vz *= 0.7; }
      }
      void live;

      const pos = this.aPos.array, data = this.aData.array, col = this.aColor.array;
      for (let i = 0; i < this.count; i++) {
        const p = this.pool[i];
        const t = 1 - p.life / p.maxLife; // 0..1 age
        const size = p.size0 + (p.size1 - p.size0) * t;
        let a = p.alpha;
        a *= t < p.fadeIn ? t / p.fadeIn : 1 - M.smoothstep(p.fadeOut, 1, t);
        const i3 = i * 3, i4 = i * 4;
        pos[i3] = p.x; pos[i3 + 1] = p.y; pos[i3 + 2] = p.z;
        data[i4] = size; data[i4 + 1] = p.rot; data[i4 + 2] = Math.max(a, 0); data[i4 + 3] = t;
        const k = p.colorMix ? t : 0;
        col[i3] = p.r + (p.r1 - p.r) * k;
        col[i3 + 1] = p.g + (p.g1 - p.g) * k;
        col[i3 + 2] = p.b + (p.b1 - p.b) * k;
      }
      this.aPos.needsUpdate = this.aData.needsUpdate = this.aColor.needsUpdate = true;
      this.geometry.instanceCount = this.count;
    }
  }

  function newParticle() {
    return {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      life: 0, maxLife: 1, size0: 1, size1: 1, rot: 0, spin: 0,
      grav: 0, drag: 0, alpha: 1, floor: -1e9,
      r: 1, g: 1, b: 1, r1: 1, g1: 1, b1: 1, colorMix: 0,
      fadeIn: 0.08, fadeOut: 0.55,
      reset(c) {
        this.x = c.x; this.y = c.y; this.z = c.z;
        this.vx = c.vx || 0; this.vy = c.vy || 0; this.vz = c.vz || 0;
        this.life = this.maxLife = c.life;
        this.size0 = c.size0; this.size1 = c.size1 === undefined ? c.size0 : c.size1;
        this.rot = c.rot || 0; this.spin = c.spin || 0;
        this.grav = c.grav || 0; this.drag = c.drag === undefined ? 0.4 : c.drag;
        this.alpha = c.alpha === undefined ? 1 : c.alpha;
        this.floor = c.floor === undefined ? -1e9 : c.floor;
        this.r = c.r; this.g = c.g; this.b = c.b;
        this.r1 = c.r1 === undefined ? c.r : c.r1;
        this.g1 = c.g1 === undefined ? c.g : c.g1;
        this.b1 = c.b1 === undefined ? c.b : c.b1;
        this.colorMix = c.r1 !== undefined ? 1 : 0;
        this.fadeIn = c.fadeIn === undefined ? 0.08 : c.fadeIn;
        this.fadeOut = c.fadeOut === undefined ? 0.55 : c.fadeOut;
      },
    };
  }

  /* =====================================================================
     DEBRIS — instanced lit boxes with real tumbling
     ===================================================================== */
  class Debris {
    constructor(scene, max) {
      this.max = max; this.count = 0;
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x3a352e, roughness: 0.85, metalness: 0.35,
        map: G.getTex('charred'),
      });
      this.mesh = new THREE.InstancedMesh(geo, mat, max);
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mesh.frustumCulled = false;
      this.mesh.castShadow = true;
      this.mesh.count = 0;
      scene.add(this.mesh);
      this.items = [];
      for (let i = 0; i < max; i++) {
        this.items.push({
          p: new THREE.Vector3(), v: new THREE.Vector3(),
          q: new THREE.Quaternion(), av: new THREE.Vector3(),
          s: new THREE.Vector3(1, 1, 1), life: 0, maxLife: 1,
        });
      }
      this._m = new THREE.Matrix4();
      this._q = new THREE.Quaternion();
      this._e = new THREE.Euler();
    }
    spawn(pos, vel, size, life) {
      if (this.count >= this.max) this.count = this.max - 1;
      const it = this.items[this.count++];
      it.p.copy(pos); it.v.copy(vel);
      it.s.set(size * (0.5 + Math.random()), size * (0.5 + Math.random()), size * (0.5 + Math.random()));
      it.av.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
      it.q.setFromEuler(this._e.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28));
      it.life = it.maxLife = life;
    }
    update(dt, groundAt) {
      for (let i = 0; i < this.count; i++) {
        const it = this.items[i];
        it.life -= dt;
        if (it.life <= 0) {
          this.count--;
          const t = this.items[i]; this.items[i] = this.items[this.count]; this.items[this.count] = t;
          i--; continue;
        }
        it.v.y -= 26 * dt;
        it.p.addScaledVector(it.v, dt);
        const gy = groundAt(it.p.x, it.p.z);
        if (it.p.y < gy + it.s.y * 0.5) {
          it.p.y = gy + it.s.y * 0.5;
          it.v.y *= -0.28; it.v.x *= 0.62; it.v.z *= 0.62;
          it.av.multiplyScalar(0.55);
        }
        this._q.setFromEuler(this._e.set(it.av.x * dt, it.av.y * dt, it.av.z * dt));
        it.q.multiply(this._q);
        const shrink = it.life < 0.6 ? it.life / 0.6 : 1;
        this._m.compose(it.p, it.q, {
          x: it.s.x * shrink, y: it.s.y * shrink, z: it.s.z * shrink,
        });
        this.mesh.setMatrixAt(i, this._m);
      }
      this.mesh.count = this.count;
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /* =====================================================================
     TRACERS — additive line segments with a velocity-stretched trail
     ===================================================================== */
  class Tracers {
    constructor(scene, max) {
      this.max = max; this.count = 0;
      const g = new THREE.BufferGeometry();
      this.pos = new Float32Array(max * 6);
      this.col = new Float32Array(max * 6);
      g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
      g.setDrawRange(0, 0);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const m = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      this.mesh = new THREE.LineSegments(g, m);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 13;
      scene.add(this.mesh);
      this.geo = g;
      this.items = [];
      for (let i = 0; i < max; i++) {
        this.items.push({
          p: new THREE.Vector3(), v: new THREE.Vector3(),
          life: 0, col: new THREE.Color(), len: 6, hostile: false, dmg: 0,
        });
      }
    }
    fire(from, dir, speed, color, life, hostile, dmg) {
      if (this.count >= this.max) this.count = this.max - 1;
      const t = this.items[this.count++];
      t.p.copy(from); t.v.copy(dir).multiplyScalar(speed);
      t.life = life; t.col.set(color); t.hostile = !!hostile;
      t.dmg = dmg || 0;
      t.len = speed * 0.035;
      return t;
    }
    update(dt, groundAt, onHitPlayer, playerPos) {
      const p = this.pos, c = this.col;
      for (let i = 0; i < this.count; i++) {
        const t = this.items[i];
        t.life -= dt;
        t.v.y -= 3.2 * dt;
        t.p.addScaledVector(t.v, dt);
        let dead = t.life <= 0;
        if (!dead && t.p.y < groundAt(t.p.x, t.p.z)) {
          dead = true;
          if (G.fx) G.fx.sparkBurst(t.p, 6, 0.5);
        }
        if (!dead && t.hostile && playerPos && t.p.distanceToSquared(playerPos) < 36) {
          dead = true;
          if (onHitPlayer) onHitPlayer(t.dmg, t.p);
        }
        if (dead) {
          this.count--;
          const tmp = this.items[i]; this.items[i] = this.items[this.count]; this.items[this.count] = tmp;
          i--; continue;
        }
        const i6 = i * 6;
        const nx = t.v.x, ny = t.v.y, nz = t.v.z;
        const inv = t.len / (Math.hypot(nx, ny, nz) || 1);
        p[i6] = t.p.x; p[i6 + 1] = t.p.y; p[i6 + 2] = t.p.z;
        p[i6 + 3] = t.p.x - nx * inv; p[i6 + 4] = t.p.y - ny * inv; p[i6 + 5] = t.p.z - nz * inv;
        const f = Math.min(1, t.life * 3);
        c[i6] = t.col.r * f; c[i6 + 1] = t.col.g * f; c[i6 + 2] = t.col.b * f;
        c[i6 + 3] = t.col.r * f * 0.05; c[i6 + 4] = t.col.g * f * 0.05; c[i6 + 5] = t.col.b * f * 0.05;
      }
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
      this.geo.setDrawRange(0, this.count * 2);
    }
  }

  /* =====================================================================
     FX DIRECTOR — explosions, fireballs, shockwaves, flash lights
     ===================================================================== */
  const FIREBALL_VS = `
    varying vec3 vN; varying vec2 vUv; varying float vNoise;
    uniform float uTime, uGrow;
    // cheap 3d value noise for the churn
    float h(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }
    float n3(vec3 p){
      vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x), mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x), f.y),
                 mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x), mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x), f.y), f.z);
    }
    void main(){
      vN = normalize(normalMatrix * normal);
      vUv = uv;
      float d = n3(normal*2.6 + uTime*1.6) * 0.5 + n3(normal*6.0 - uTime*2.2) * 0.28;
      vNoise = d;
      vec3 pos = position * (1.0 + (d-0.4) * 0.30 * uGrow);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
  `;
  const FIREBALL_FS = `
    varying vec3 vN; varying float vNoise;
    uniform float uAge, uAlpha;
    void main(){
      // fade toward the silhouette so the mesh reads as gas, not a faceted shell
      float face = clamp(abs(vN.z), 0.0, 1.0);
      float soft = pow(face, 0.85);
      float rim = pow(1.0 - face, 1.6);
      float heat = clamp(vNoise*1.5 + 0.25 - uAge*0.9, 0.0, 1.0);
      vec3 core = mix(vec3(1.45,0.34,0.07), vec3(2.30,1.85,1.00), pow(heat,2.2));
      vec3 col = core * (0.55 + rim*0.5);
      col = mix(col, vec3(0.09,0.08,0.075), clamp(uAge*1.25 - 0.18, 0.0, 0.9));
      float a = uAlpha * clamp(1.0 - uAge, 0.0, 1.0) * soft;
      if (a < 0.004) discard;
      gl_FragColor = vec4(col * a, a);
    }
  `;

  class FXDirector {
    constructor(scene, opts) {
      this.scene = scene;
      this.groundAt = opts.groundAt || (() => 0);
      this.wind = new THREE.Vector3(2.2, 0, -1.1);

      const fogCfg = { fogColor: opts.fogColor, fogDensity: opts.fogDensity };
      const P = (max, map, additive) =>
        new Particles(scene, Object.assign({ max, map, additive }, fogCfg));
      this.smoke = P(2600, G.getTex('smoke'), false);
      this.fire = P(900, G.getTex('fire'), true);
      this.sparks = P(1800, G.getTex('glow'), true);
      this.dust = P(900, G.getTex('smoke'), false);
      this.debris = new Debris(scene, 420);
      this.tracers = new Tracers(scene, 900);

      // fireball pool
      this.balls = [];
      const bgeo = new THREE.IcosahedronGeometry(1, 3);
      for (let i = 0; i < 10; i++) {
        const mat = new THREE.ShaderMaterial({
          uniforms: { uTime: { value: 0 }, uAge: { value: 0 }, uAlpha: { value: 1 }, uGrow: { value: 1 } },
          vertexShader: FIREBALL_VS, fragmentShader: FIREBALL_FS,
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        });
        const m = new THREE.Mesh(bgeo, mat);
        m.visible = false; m.frustumCulled = false; m.renderOrder = 14;
        scene.add(m);
        this.balls.push({ mesh: m, life: 0, maxLife: 1, r: 1 });
      }

      // shockwave pool
      this.waves = [];
      const rgeo = new THREE.RingGeometry(0.72, 1.0, 64);
      rgeo.rotateX(-Math.PI / 2);
      for (let i = 0; i < 8; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xd9a878, transparent: true, opacity: 0.55,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        });
        const m = new THREE.Mesh(rgeo, mat);
        m.visible = false; m.renderOrder = 13;
        scene.add(m);
        this.waves.push({ mesh: m, life: 0, maxLife: 1, r0: 1, r1: 30 });
      }

      // flash light pool
      this.lights = [];
      for (let i = 0; i < 5; i++) {
        const l = new THREE.PointLight(0xffb861, 0, 260, 2);
        l.visible = false;
        scene.add(l);
        this.lights.push({ light: l, life: 0, maxLife: 1, power: 0 });
      }

      this.shake = 0;
      this.shakeV = new THREE.Vector3();
      this._v = new THREE.Vector3();
      this.scorchPool = [];
      this.scorchIdx = 0;
      this.listeners = [];
    }

    /* ---- decal scorch marks laid onto the terrain ---- */
    initScorch(count, terrain) {
      const tex = G.getTex('scorch');
      const geo = new THREE.CircleGeometry(1, 24);
      geo.rotateX(-Math.PI / 2);
      for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          map: tex, transparent: true, opacity: 0.0, depthWrite: false,
          blending: THREE.NormalBlending, color: 0x1a1714,
        }));
        m.renderOrder = 2;
        m.visible = false;
        this.scene.add(m);
        this.scorchPool.push(m);
      }
      this.terrain = terrain;
    }
    scorch(x, z, r) {
      if (!this.scorchPool.length) return;
      const m = this.scorchPool[this.scorchIdx++ % this.scorchPool.length];
      m.position.set(x, this.groundAt(x, z) + 0.45, z);
      m.scale.setScalar(r);
      m.rotation.y = Math.random() * 6.28;
      m.material.opacity = 0.9;
      m.visible = true;
    }

    // intensity is in the same scale as the sun (~2.4), so keep it modest —
    // an over-bright point light saturates the whole heightfield instantly
    flashLight(pos, intensity, life, color, distance) {
      let best = null;
      for (const l of this.lights) if (!best || l.life < best.life) best = l;
      best.light.position.copy(pos);
      best.light.color.set(color || 0xffb055);
      best.light.distance = distance || 240;
      best.power = intensity;
      best.life = best.maxLife = life;
      best.light.visible = true;
    }

    sparkBurst(pos, n, scale) {
      scale = scale || 1;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283, e = Math.random() * 1.4;
        const sp = (7 + Math.random() * 26) * scale;
        this.sparks.spawn({
          x: pos.x, y: pos.y, z: pos.z,
          vx: Math.cos(a) * Math.cos(e) * sp, vy: Math.sin(e) * sp * 1.2, vz: Math.sin(a) * Math.cos(e) * sp,
          life: 0.35 + Math.random() * 0.6, size0: 0.55 * scale, size1: 0.08 * scale,
          grav: 22, drag: 0.9, r: 3.2, g: 1.5, b: 0.5, r1: 2.0, g1: 0.35, b1: 0.08,
          fadeIn: 0.02, fadeOut: 0.3,
        });
      }
    }

    /* ---- the money shot ---- */
    explode(pos, power, opts) {
      opts = opts || {};
      const p = pos;
      const gy = this.groundAt(p.x, p.z);
      const ground = p.y - gy < power * 1.2;

      // fireball
      let ball = null;
      for (const b of this.balls) if (!b.life) { ball = b; break; }
      if (!ball) ball = this.balls[0];
      ball.mesh.position.copy(p);
      ball.r = power * 0.95;
      ball.life = ball.maxLife = 0.55 + power * 0.03;
      ball.mesh.visible = true;
      ball.mesh.material.uniforms.uTime.value = Math.random() * 10;

      // shockwave along the ground
      if (ground) {
        let w = null;
        for (const q of this.waves) if (!q.life) { w = q; break; }
        if (w) {
          w.mesh.position.set(p.x, gy + 1.2, p.z);
          w.life = w.maxLife = 0.36 + power * 0.008;
          w.r0 = power * 0.5; w.r1 = power * 4.2;
          w.mesh.visible = true;
        }
        this.scorch(p.x, p.z, power * 2.4);
      }

      // core fire
      for (let i = 0; i < 9 + power * 0.9; i++) {
        const a = Math.random() * 6.283, e = Math.random() * 1.2;
        const sp = (3 + Math.random() * 12) * (power / 6);
        this.fire.spawn({
          x: p.x, y: p.y, z: p.z,
          vx: Math.cos(a) * Math.cos(e) * sp, vy: Math.abs(Math.sin(e)) * sp + 4, vz: Math.sin(a) * Math.cos(e) * sp,
          life: 0.32 + Math.random() * 0.5,
          size0: power * 0.38, size1: power * 1.15,
          rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 3,
          grav: -4, drag: 1.9, r: 1.65, g: 0.80, b: 0.28, r1: 0.60, g1: 0.16, b1: 0.04,
          fadeIn: 0.04, fadeOut: 0.28,
        });
      }

      // smoke column — dark soot that thins to grey as it disperses
      for (let i = 0; i < 14 + power * 1.4; i++) {
        const a = Math.random() * 6.283;
        const sp = (1.5 + Math.random() * 7) * (power / 7);
        const g = 0.055 + Math.random() * 0.05;
        this.smoke.spawn({
          x: p.x + (Math.random() - 0.5) * power, y: p.y + Math.random() * power * 0.6, z: p.z + (Math.random() - 0.5) * power,
          vx: Math.cos(a) * sp, vy: 3 + Math.random() * 9, vz: Math.sin(a) * sp,
          life: 2.4 + Math.random() * 3.4,
          size0: power * 0.6, size1: power * 2.8,
          rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 0.7,
          grav: -1.6, drag: 0.55, alpha: 0.72,
          r: g * 1.5, g: g * 1.15, b: g * 0.9, r1: g * 2.4, g1: g * 2.5, b1: g * 2.7,
          fadeIn: 0.05, fadeOut: 0.4,
        });
      }

      // dirt kick
      if (ground) {
        for (let i = 0; i < 14 + power; i++) {
          const a = Math.random() * 6.283;
          const sp = (6 + Math.random() * 20) * (power / 8);
          this.dust.spawn({
            x: p.x, y: gy + 0.6, z: p.z,
            vx: Math.cos(a) * sp, vy: 6 + Math.random() * 16, vz: Math.sin(a) * sp,
            life: 1.6 + Math.random() * 2.2,
            size0: power * 0.35, size1: power * 2.2,
            rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 1.2,
            grav: 4.5, drag: 0.7, alpha: 0.5, floor: gy,
            r: 0.14, g: 0.12, b: 0.095, r1: 0.105, g1: 0.095, b1: 0.08,
          });
        }
      }

      this.sparkBurst(p, 26 + power * 2, power / 7);

      // debris
      const dn = Math.min(28, 8 + power);
      for (let i = 0; i < dn; i++) {
        const a = Math.random() * 6.283, e = 0.3 + Math.random();
        const sp = 10 + Math.random() * 26;
        this._v.set(Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp * 1.4, Math.sin(a) * Math.cos(e) * sp);
        this.debris.spawn(p, this._v, 0.35 + Math.random() * power * 0.14, 2.5 + Math.random() * 3);
      }

      this.flashLight(p, power * 1.25, 0.4, 0xffa858, power * 14);
      this.emit('explode', p, power, opts);
      return ball;
    }

    on(fn) { this.listeners.push(fn); }
    emit() {
      const a = arguments;
      for (const f of this.listeners) f.apply(null, a);
    }

    update(dt, playerPos, onHitPlayer) {
      this.smoke.update(dt, this.wind);
      this.fire.update(dt, this.wind);
      this.sparks.update(dt, this.wind);
      this.dust.update(dt, this.wind);
      this.debris.update(dt, this.groundAt);
      this.tracers.update(dt, this.groundAt, onHitPlayer, playerPos);

      for (const b of this.balls) {
        if (!b.life) continue;
        b.life -= dt;
        const age = 1 - Math.max(b.life, 0) / b.maxLife;
        if (b.life <= 0) { b.mesh.visible = false; b.life = 0; continue; }
        const s = b.r * (0.35 + Math.pow(age, 0.45) * 1.35);
        b.mesh.scale.setScalar(s);
        b.mesh.material.uniforms.uAge.value = age;
        b.mesh.material.uniforms.uTime.value += dt * 1.6;
        b.mesh.material.uniforms.uGrow.value = 0.4 + age;
      }
      for (const w of this.waves) {
        if (!w.life) continue;
        w.life -= dt;
        const age = 1 - Math.max(w.life, 0) / w.maxLife;
        if (w.life <= 0) { w.mesh.visible = false; w.life = 0; continue; }
        const r = M.lerp(w.r0, w.r1, Math.pow(age, 0.55));
        w.mesh.scale.set(r, 1, r);
        w.mesh.material.opacity = 0.42 * Math.pow(1 - age, 1.9);
      }
      for (const l of this.lights) {
        if (!l.life) continue;
        l.life -= dt;
        if (l.life <= 0) { l.light.visible = false; l.life = 0; l.light.intensity = 0; continue; }
        const k = l.life / l.maxLife;
        l.light.intensity = l.power * k * k;
      }
      for (const s of this.scorchPool) {
        if (s.visible && s.material.opacity < 0.86) {
          // permanent once laid; nothing to do
        }
      }
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }

    addShake(v) { this.shake = Math.min(1.6, this.shake + v); }
  }

  G.FXDirector = FXDirector;
  G.Particles = Particles;
})();
