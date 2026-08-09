/* =========================================================================
   DONBAS FPV 2026 — hud.js
   Canvas-drawn goggle OSD: artificial horizon, tapes, target brackets,
   sweep radar and link telemetry. Everything is vector-drawn so it stays
   razor sharp at any DPI.
   ========================================================================= */
(function () {
  'use strict';
  const G = window.G;
  const M = G.M;

  const GREEN = '#79ffab';
  const GREEN_DIM = 'rgba(121,255,171,0.38)';
  const RED = '#ff5a4a';
  const AMBER = '#ffc14d';

  class HUD {
    constructor(canvas) {
      this.c = canvas;
      this.ctx = canvas.getContext('2d');
      this.msgs = [];
      this.t = 0;
      this.resize();
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = window.innerWidth;
      this.h = window.innerHeight;
      this.c.width = this.w * dpr;
      this.c.height = this.h * dpr;
      this.dpr = dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.small = Math.min(this.w, this.h) < 620;
    }

    msg(text, color, life) {
      this.msgs.push({ text, color: color || GREEN, life: life || 2.4, max: life || 2.4 });
      if (this.msgs.length > 6) this.msgs.shift();
    }

    /* ------------------------------------------------------------------ */
    draw(s, dt) {
      const ctx = this.ctx, w = this.w, h = this.h;
      this.t += dt;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.lineWidth = 1.4;
      ctx.font = `${this.small ? 10 : 12}px "Share Tech Mono", monospace`;
      ctx.textBaseline = 'middle';

      const cx = w / 2, cy = h / 2;
      const scale = this.small ? 0.74 : 1;

      // link quality drives OSD stability — the OSD is transmitted too
      const jitter = (1 - s.signal) * 4;
      const jx = (Math.random() - 0.5) * jitter, jy = (Math.random() - 0.5) * jitter;
      ctx.translate(jx, jy);

      ctx.shadowColor = 'rgba(60,255,140,0.55)';
      ctx.shadowBlur = 6;

      this._horizon(ctx, cx, cy, s, scale);
      this._reticle(ctx, cx, cy, s, scale);
      this._headingTape(ctx, cx, s, scale);
      this._ladder(ctx, w - (this.small ? 44 : 74) * scale, cy, s.alt, 'ALT', 25, scale, true);
      this._ladder(ctx, (this.small ? 44 : 74) * scale, cy, s.speed, 'KPH', 20, scale, false);
      this._targets(ctx, s, scale);
      this._radar(ctx, s, scale);
      this._link(ctx, s, scale);
      this._messages(ctx, cx, cy, dt, scale);

      if (s.warn) {
        ctx.shadowColor = 'rgba(255,60,40,0.8)';
        ctx.fillStyle = Math.sin(this.t * 14) > 0 ? RED : 'rgba(255,90,74,0.35)';
        ctx.font = `bold ${18 * scale}px "Share Tech Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(s.warn, cx, cy + 92 * scale);
      }
      ctx.restore();
    }

    /* ---------------------------------------------- artificial horizon -- */
    _horizon(ctx, cx, cy, s, k) {
      const pxPerDeg = 5.2 * k;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-s.roll);
      ctx.translate(0, M.deg(s.pitch) * pxPerDeg);

      ctx.strokeStyle = GREEN_DIM;
      ctx.fillStyle = GREEN_DIM;
      ctx.textAlign = 'center';

      const limit = this.h * 0.34;
      for (let d = -45; d <= 45; d += 5) {
        const y = -d * pxPerDeg;
        if (Math.abs(y) > limit) continue;
        const major = d % 10 === 0;
        const len = (major ? 62 : 30) * k;
        if (d === 0) {
          ctx.strokeStyle = 'rgba(121,255,171,0.75)';
          ctx.beginPath();
          ctx.moveTo(-160 * k, 0); ctx.lineTo(-34 * k, 0);
          ctx.moveTo(34 * k, 0); ctx.lineTo(160 * k, 0);
          ctx.stroke();
          ctx.strokeStyle = GREEN_DIM;
          continue;
        }
        ctx.beginPath();
        if (d > 0) {
          ctx.moveTo(-len, y); ctx.lineTo(-len * 0.42, y);
          ctx.moveTo(len * 0.42, y); ctx.lineTo(len, y);
        } else {
          // dashed below the horizon, like real FPV OSDs
          ctx.setLineDash([5, 5]);
          ctx.moveTo(-len, y); ctx.lineTo(-len * 0.42, y);
          ctx.moveTo(len * 0.42, y); ctx.lineTo(len, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        if (major && d !== 0) {
          ctx.font = `${9 * k}px "Share Tech Mono", monospace`;
          ctx.fillText(String(Math.abs(d)), -len - 12 * k, y);
          ctx.fillText(String(Math.abs(d)), len + 12 * k, y);
        }
      }
      ctx.restore();

      // roll indicator arc
      ctx.save();
      ctx.translate(cx, cy);
      ctx.strokeStyle = GREEN_DIM;
      const R = 132 * k;
      ctx.beginPath();
      ctx.arc(0, 0, R, -Math.PI * 0.78, -Math.PI * 0.22);
      ctx.stroke();
      for (const a of [-60, -45, -30, -15, 0, 15, 30, 45, 60]) {
        const ang = -Math.PI / 2 + M.rad(a);
        const l = a % 30 === 0 ? 9 * k : 5 * k;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * R, Math.sin(ang) * R);
        ctx.lineTo(Math.cos(ang) * (R + l), Math.sin(ang) * (R + l));
        ctx.stroke();
      }
      ctx.fillStyle = GREEN;
      const ra = -Math.PI / 2 - s.roll;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ra) * (R - 3), Math.sin(ra) * (R - 3));
      ctx.lineTo(Math.cos(ra - 0.035) * (R - 12 * k), Math.sin(ra - 0.035) * (R - 12 * k));
      ctx.lineTo(Math.cos(ra + 0.035) * (R - 12 * k), Math.sin(ra + 0.035) * (R - 12 * k));
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    /* ------------------------------------------------------- reticle ---- */
    _reticle(ctx, cx, cy, s, k) {
      ctx.save();
      ctx.translate(cx, cy);
      const lock = s.lock;
      ctx.strokeStyle = lock ? RED : GREEN;
      ctx.shadowColor = lock ? 'rgba(255,80,60,0.8)' : 'rgba(60,255,140,0.6)';
      ctx.lineWidth = 1.6;
      // centre gun-cross
      ctx.beginPath();
      ctx.moveTo(-26 * k, 0); ctx.lineTo(-8 * k, 0);
      ctx.moveTo(26 * k, 0); ctx.lineTo(8 * k, 0);
      ctx.moveTo(0, -26 * k); ctx.lineTo(0, -8 * k);
      ctx.moveTo(0, 26 * k); ctx.lineTo(0, 8 * k);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 3.2 * k, 0, 6.283);
      ctx.fillStyle = lock ? RED : '#ffffff';
      ctx.fill();
      // impact-point ring pulses when a target is inside the strike cone
      if (lock) {
        const p = 1 + Math.sin(this.t * 12) * 0.08;
        ctx.beginPath();
        ctx.arc(0, 0, 40 * k * p, 0, 6.283);
        ctx.setLineDash([4, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    /* --------------------------------------------------------- ladders -- */
    _ladder(ctx, x, cy, value, label, step, k, right) {
      const H = 150 * k;
      ctx.save();
      ctx.translate(x, cy);
      ctx.strokeStyle = GREEN_DIM;
      ctx.fillStyle = GREEN;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.beginPath();
      ctx.moveTo(0, -H); ctx.lineTo(0, H);
      ctx.stroke();
      const pxPerUnit = (H * 2) / (step * 10);
      const base = Math.floor(value / step) * step;
      for (let i = -6; i <= 6; i++) {
        const v = base + i * step;
        if (v < 0) continue;
        const y = (value - v) * pxPerUnit;
        if (Math.abs(y) > H) continue;
        const major = v % (step * 2) === 0;
        const len = (major ? 12 : 6) * k;
        ctx.beginPath();
        ctx.moveTo(0, y); ctx.lineTo(right ? len : -len, y);
        ctx.stroke();
        if (major) {
          ctx.font = `${9 * k}px "Share Tech Mono", monospace`;
          ctx.fillText(String(v), right ? len + 5 : -len - 5, y);
        }
      }
      // current value box
      ctx.fillStyle = 'rgba(0,20,10,0.8)';
      ctx.strokeStyle = GREEN;
      const bw = 52 * k, bh = 19 * k;
      const bx = right ? 4 : -bw - 4;
      ctx.beginPath();
      ctx.rect(bx, -bh / 2, bw, bh);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.font = `bold ${12 * k}px "Share Tech Mono", monospace`;
      ctx.fillText(String(Math.round(value)), bx + bw / 2, 0);
      ctx.fillStyle = GREEN;
      ctx.font = `${9 * k}px "Share Tech Mono", monospace`;
      ctx.fillText(label, bx + bw / 2, -bh / 2 - 9 * k);
      ctx.restore();
    }

    /* ------------------------------------------------- target brackets -- */
    _targets(ctx, s, k) {
      ctx.save();
      ctx.textAlign = 'center';
      for (const t of s.screenTargets) {
        const size = M.clamp(2200 / t.dist, 12, 90) * k;
        const half = size / 2;
        const isLock = t.locked;
        ctx.strokeStyle = isLock ? RED : (t.priority ? AMBER : 'rgba(121,255,171,0.85)');
        ctx.shadowColor = isLock ? 'rgba(255,60,40,0.9)' : 'rgba(60,255,140,0.5)';
        ctx.lineWidth = isLock ? 2 : 1.3;
        const c = half * 0.36;
        ctx.beginPath();
        // corner brackets
        ctx.moveTo(t.x - half, t.y - half + c); ctx.lineTo(t.x - half, t.y - half); ctx.lineTo(t.x - half + c, t.y - half);
        ctx.moveTo(t.x + half - c, t.y - half); ctx.lineTo(t.x + half, t.y - half); ctx.lineTo(t.x + half, t.y - half + c);
        ctx.moveTo(t.x + half, t.y + half - c); ctx.lineTo(t.x + half, t.y + half); ctx.lineTo(t.x + half - c, t.y + half);
        ctx.moveTo(t.x - half + c, t.y + half); ctx.lineTo(t.x - half, t.y + half); ctx.lineTo(t.x - half, t.y + half - c);
        ctx.stroke();
        if (size > 26) {
          ctx.fillStyle = ctx.strokeStyle;
          ctx.font = `${9 * k}px "Share Tech Mono", monospace`;
          ctx.fillText(t.label, t.x, t.y - half - 8 * k);
          ctx.fillText(Math.round(t.dist) + 'm', t.x, t.y + half + 10 * k);
          if (t.hp < 1) {
            const bw = size * 0.9;
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(t.x - bw / 2, t.y + half + 15 * k, bw, 3 * k);
            ctx.fillStyle = t.hp > 0.5 ? GREEN : AMBER;
            ctx.fillRect(t.x - bw / 2, t.y + half + 15 * k, bw * t.hp, 3 * k);
          }
        }
        if (isLock) {
          ctx.strokeStyle = 'rgba(255,90,74,0.5)';
          ctx.beginPath();
          ctx.moveTo(t.x, t.y - half); ctx.lineTo(t.x, t.y - half - 26 * k);
          ctx.stroke();
        }
      }
      // off-screen threat arrows
      for (const a of s.offscreen) {
        ctx.save();
        ctx.translate(a.x, a.y);
        ctx.rotate(a.angle);
        ctx.fillStyle = a.hostile ? 'rgba(255,90,74,0.85)' : 'rgba(255,193,77,0.8)';
        ctx.beginPath();
        ctx.moveTo(11 * k, 0); ctx.lineTo(-7 * k, 6 * k); ctx.lineTo(-7 * k, -6 * k);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }

    /* ------------------------------------------------------------ radar - */
    _radar(ctx, s, k) {
      const R = (this.small ? 46 : 66) * k;
      const x = R + 22, y = this.h - R - 22;
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = 'rgba(0,18,10,0.55)';
      ctx.beginPath(); ctx.arc(0, 0, R, 0, 6.283); ctx.fill();
      ctx.strokeStyle = GREEN_DIM;
      for (const r of [R, R * 0.66, R * 0.33]) {
        ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.283); ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(-R, 0); ctx.lineTo(R, 0); ctx.moveTo(0, -R); ctx.lineTo(0, R);
      ctx.stroke();

      // sweep
      const sweep = (this.t * 1.7) % 6.283;
      ctx.save();
      ctx.rotate(sweep);
      const g = ctx.createLinearGradient(0, 0, R, 0);
      g.addColorStop(0, 'rgba(121,255,171,0.28)');
      g.addColorStop(1, 'rgba(121,255,171,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, -0.42, 0);
      ctx.closePath(); ctx.fill();
      ctx.restore();

      // contacts, rotated into drone-forward-up frame
      const range = 1100;
      for (const c of s.radar) {
        const dx = c.x - s.px, dz = c.z - s.pz;
        const d = Math.hypot(dx, dz);
        if (d > range) continue;
        const ang = Math.atan2(dx, -dz) - s.heading;
        const rr = (d / range) * R;
        const px = Math.sin(ang) * rr, py = -Math.cos(ang) * rr;
        ctx.fillStyle = c.dead ? 'rgba(120,120,120,0.5)'
          : c.hostileAA ? RED : c.objective ? AMBER : 'rgba(121,255,171,0.9)';
        const sz = c.objective ? 3.4 * k : 2.4 * k;
        ctx.beginPath(); ctx.arc(px, py, sz, 0, 6.283); ctx.fill();
      }
      // own marker
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(0, -5 * k); ctx.lineTo(3.5 * k, 4 * k); ctx.lineTo(-3.5 * k, 4 * k);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = GREEN;
      ctx.font = `${8 * k}px "Share Tech Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('1.1KM', 0, R + 11 * k);
      ctx.restore();
    }

    /* ------------------------------------------------- link telemetry --- */
    _link(ctx, s, k) {
      const w = this.w, h = this.h;
      ctx.save();
      ctx.font = `${10 * k}px "Share Tech Mono", monospace`;

      // top-left: REC + timestamp
      ctx.textAlign = 'left';
      const rec = Math.sin(this.t * 3.4) > -0.2;
      if (rec) {
        ctx.fillStyle = RED;
        ctx.beginPath(); ctx.arc(20, 22, 4.5 * k, 0, 6.283); ctx.fill();
      }
      ctx.fillStyle = GREEN;
      ctx.fillText('REC', 30, 22);
      ctx.fillText(s.clock, 62, 22);
      ctx.fillStyle = GREEN_DIM;
      ctx.fillText('CAM-01  UA-3AB  ' + s.droneTag, 20, 38);

      // bottom-centre link bars
      const bx = w / 2, by = h - 26;
      ctx.textAlign = 'center';
      const bars = Math.round(s.signal * 5);
      for (let i = 0; i < 5; i++) {
        const bh = 4 + i * 3;
        ctx.fillStyle = i < bars ? (bars <= 2 ? RED : GREEN) : 'rgba(121,255,171,0.18)';
        ctx.fillRect(bx - 34 + i * 9, by - bh, 6, bh);
      }
      ctx.fillStyle = s.signal < 0.45 ? RED : GREEN;
      ctx.fillText(Math.round(s.signal * 100) + '%', bx + 30, by - 6);
      ctx.fillStyle = GREEN_DIM;
      ctx.fillText(s.signal < 0.45 ? 'LINK DEGRADED' : '5.8GHz ANALOG', bx, by + 10);

      // battery
      ctx.textAlign = 'right';
      const bat = s.battery;
      ctx.strokeStyle = bat < 0.2 ? RED : GREEN;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      const bw = 46 * k, bhh = 14 * k;
      ctx.beginPath(); ctx.rect(w - 20 - bw, h - 40, bw, bhh); ctx.fill(); ctx.stroke();
      ctx.fillStyle = bat < 0.2 ? RED : (bat < 0.45 ? AMBER : GREEN);
      ctx.fillRect(w - 18 - bw, h - 38, (bw - 4) * bat, bhh - 4);
      ctx.fillStyle = GREEN;
      ctx.fillText(Math.round(bat * 100) + '%  ' + s.volts.toFixed(1) + 'V', w - 20, h - 52);

      ctx.restore();
    }

    _messages(ctx, cx, cy, dt, k) {
      ctx.save();
      ctx.textAlign = 'center';
      let y = cy - 150 * k;
      for (let i = this.msgs.length - 1; i >= 0; i--) {
        const m2 = this.msgs[i];
        m2.life -= dt;
        if (m2.life <= 0) { this.msgs.splice(i, 1); continue; }
      }
      for (let i = 0; i < this.msgs.length; i++) {
        const m2 = this.msgs[i];
        const a = M.clamp(m2.life / 0.5, 0, 1);
        ctx.globalAlpha = a;
        ctx.fillStyle = m2.color;
        ctx.shadowColor = m2.color;
        ctx.font = `bold ${13 * k}px "Share Tech Mono", monospace`;
        ctx.fillText(m2.text, cx, y);
        y -= 19 * k;
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  /* heading tape drawn as a standalone routine for clarity */
  HUD.prototype._headingTape = function (ctx, cx, s, k) {
    const y = 26 * k + 22;
    const W = (this.small ? 110 : 190) * k;
    const hdg = M.deg(s.heading);
    ctx.save();
    ctx.translate(cx, y);
    ctx.strokeStyle = GREEN_DIM;
    ctx.fillStyle = GREEN;
    ctx.textAlign = 'center';
    ctx.beginPath(); ctx.moveTo(-W, 10 * k); ctx.lineTo(W, 10 * k); ctx.stroke();
    const pxPerDeg = W / 55;
    for (let d = -60; d <= 60; d += 5) {
      const deg = hdg + d;
      const x = d * pxPerDeg;
      if (Math.abs(x) > W) continue;
      const norm = ((Math.round(deg) % 360) + 360) % 360;
      const major = norm % 15 === 0;
      ctx.beginPath();
      ctx.moveTo(x, 10 * k); ctx.lineTo(x, 10 * k - (major ? 8 : 4) * k);
      ctx.stroke();
      if (norm % 45 === 0) {
        const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
        ctx.font = `${9 * k}px "Share Tech Mono", monospace`;
        ctx.fillText(names[norm] || String(norm), x, -2 * k);
      }
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, 12 * k); ctx.lineTo(-5 * k, 20 * k); ctx.lineTo(5 * k, 20 * k);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = GREEN;
    ctx.font = `bold ${11 * k}px "Share Tech Mono", monospace`;
    ctx.fillText(String(Math.round(((hdg % 360) + 360) % 360)).padStart(3, '0'), 0, 30 * k);
    ctx.restore();
  };

  G.HUD = HUD;
})();
