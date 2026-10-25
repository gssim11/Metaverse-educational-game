// 가벼운 캔버스 시계열 차트 (외부 라이브러리 없음)
export const PALETTE = ['#4cc9f0', '#f72585', '#ffd166', '#06d6a0', '#b388ff', '#ff8c42', '#90be6d', '#e0e0e0'];

export class LineChart {
  constructor(canvas, { onSeek } = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.series = [];
    this.t = [];
    this.cursor = null;
    this.events = [];
    this.onSeek = onSeek;
    const seek = (ev) => {
      if (!this.onSeek || !this.t.length) return;
      const r = this.c.getBoundingClientRect();
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      const { l, w } = this.box();
      const f = Math.min(1, Math.max(0, (x - l) / w));
      this.onSeek(this.t0 + f * (this.t1 - this.t0) - this.t0);
    };
    canvas.addEventListener('pointerdown', (e) => { this.drag = true; seek(e); });
    canvas.addEventListener('pointermove', (e) => { if (this.drag) seek(e); });
    window.addEventListener('pointerup', () => { this.drag = false; });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  box() {
    const W = this.c.clientWidth, H = this.c.clientHeight;
    return { l: 40, t: 10, w: Math.max(10, W - 52), h: Math.max(10, H - 34), W, H };
  }
  set(t, series, events = []) {
    this.t = t;
    this.t0 = t[0] ?? 0;
    this.t1 = t[t.length - 1] ?? 1;
    this.series = series;
    this.events = events;
    this.draw();
  }
  setCursor(sec) { this.cursor = sec; this.draw(); }
  draw() {
    const { c, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const { l, t, w, h, W, H } = this.box();
    if (!W || !H) return;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--line').trim() || '#333';
    const muted = css.getPropertyValue('--muted').trim() || '#999';
    let lo = Infinity, hi = -Infinity;
    for (const s of this.series) for (const v of s.y) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.08 || 5;
    lo -= pad; hi += pad;
    const span = this.t1 - this.t0 || 1;
    const X = (tt) => l + ((tt - this.t0) / span) * w;
    const Y = (v) => t + (1 - (v - lo) / (hi - lo)) * h;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = muted; ctx.strokeStyle = grid; ctx.lineWidth = 1;
    const step = niceStep((hi - lo) / 4);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      ctx.beginPath(); ctx.moveTo(l, Y(v)); ctx.lineTo(l + w, Y(v)); ctx.stroke();
      ctx.fillText(String(Math.round(v)), 4, Y(v) + 4);
    }
    const tstep = niceStep(span / 5);
    for (let s = 0; s <= span; s += tstep) ctx.fillText(s.toFixed(tstep < 1 ? 1 : 0) + 's', X(this.t0 + s) - 8, H - 6);
    for (const ev of this.events) {
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(this.t0 + ev.t), t); ctx.lineTo(X(this.t0 + ev.t), t + h); ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const s of this.series) {
      ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.beginPath();
      let pen = false;
      for (let i = 0; i < this.t.length; i++) {
        const v = s.y[i];
        if (!Number.isFinite(v)) { pen = false; continue; }
        if (pen) ctx.lineTo(X(this.t[i]), Y(v)); else { ctx.moveTo(X(this.t[i]), Y(v)); pen = true; }
      }
      ctx.stroke();
    }
    if (this.cursor != null) {
      const x = X(this.t0 + this.cursor);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + h); ctx.stroke();
    }
  }
}

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
