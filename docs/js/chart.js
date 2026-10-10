// 极简 canvas 时间序列图：折线（共用 x）、成交标记、阈值线、十字准线 + 提示框。
// 颜色全部读 CSS 变量，切换主题后调用 redraw() 即可。

const DPR = () => Math.max(1, window.devicePixelRatio || 1);

const TIME_STEPS = [
  1e3, 5e3, 10e3, 15e3, 30e3,
  60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3,
  3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3,
  86400e3, 2 * 86400e3, 7 * 86400e3, 14 * 86400e3, 30 * 86400e3,
];

function niceTicks(lo, hi, maxTicks) {
  if (!(hi > lo)) {
    const pad = Math.abs(lo) * 0.01 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / Math.max(1, maxTicks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, lo: start, hi: end, step };
}

function lowerBound(arr, x, n = arr.length) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class TimeChart {
  constructor(el, opts) {
    this.el = el;
    this.opts = {
      height: 300,
      yFormat: (v) => String(v),
      xTick: (t) => new Date(t).toISOString(),
      xTooltip: (t) => new Date(t).toISOString(),
      zeroLine: false,
      endLabels: false,
      ariaLabel: "",
      ...opts,
    };
    this.data = null;
    this.hoverIdx = null;

    el.classList.add("tc");
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "img");
    this.tip = document.createElement("div");
    this.tip.className = "tc-tip";
    this.tip.hidden = true;
    el.append(this.canvas, this.tip);

    this.canvas.addEventListener("pointermove", (e) => this._onPointer(e));
    this.canvas.addEventListener("pointerdown", (e) => this._onPointer(e));
    this.canvas.addEventListener("pointerleave", () => this._clearHover());
    this.canvas.addEventListener("blur", () => this._clearHover());
    this.canvas.addEventListener("click", (e) => this._onClick(e));
    this.canvas.addEventListener("keydown", (e) => this._onKey(e));

    this.ro = new ResizeObserver(() => this.redraw());
    this.ro.observe(el);
  }

  setAriaLabel(s) {
    this.canvas.setAttribute("aria-label", s);
  }

  update(data) {
    this.data = data;
    if (this.hoverIdx !== null && this.hoverIdx >= this._count()) this.hoverIdx = null;
    this.redraw();
  }

  _count() {
    const d = this.data;
    return d ? Math.min(d.count ?? d.ts.length, d.ts.length) : 0;
  }

  _css(name) {
    return getComputedStyle(this.el).getPropertyValue(name).trim();
  }

  redraw() {
    const w = this.el.clientWidth;
    const h = typeof this.opts.height === "function" ? this.opts.height(w) : this.opts.height;
    if (!w) return;
    const dpr = DPR();
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    this.w = w;
    this.h = h;
    if (!this.data || !this.data.ts.length) return;
    this._layout(ctx);
    this._draw(ctx);
  }

  _layout(ctx) {
    const d = this.data;
    const n = this._count();
    const font = `12px ${this._css("--font-sans") || "system-ui, sans-serif"}`;
    ctx.font = font;
    this.font = font;

    const x0 = d.xDomain ? d.xDomain[0] : d.ts[0];
    const x1 = d.xDomain ? d.xDomain[1] : d.ts[d.ts.length - 1];

    // y 范围：可见区间内所有序列 + 标记 + 阈值线
    let lo = Infinity;
    let hi = -Infinity;
    if (d.yDomain) {
      [lo, hi] = d.yDomain;
    } else {
      const i0 = lowerBound(d.ts, x0, n);
      const i1 = lowerBound(d.ts, x1 + 1, n);
      for (const s of d.series) {
        for (let i = i0; i < i1; i++) {
          const v = s.values[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      for (const m of d.markers || []) {
        if (m.t >= x0 && m.t <= x1) {
          lo = Math.min(lo, m.y);
          hi = Math.max(hi, m.y);
        }
      }
      for (const l of d.hLines || []) {
        lo = Math.min(lo, l.y);
        hi = Math.max(hi, l.y);
      }
      if (this.opts.zeroLine) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      if (!isFinite(lo)) {
        lo = 0;
        hi = 1;
      }
    }
    const yt = niceTicks(lo, hi, Math.max(3, Math.floor(this.h / 60)));
    this.yTicks = yt.ticks;
    this.y0 = yt.lo;
    this.y1 = yt.hi;

    const labelW = Math.max(...this.yTicks.map((v) => ctx.measureText(this.opts.yFormat(v, yt.step)).width));
    this.yStep = yt.step;
    this.endLabelW = 0;
    if (this.opts.endLabels && this.w >= 560) {
      this.endLabelW = Math.max(...d.series.map((s) => ctx.measureText(s.label).width)) + 20;
    }
    this.m = { l: Math.ceil(labelW) + 14, r: 12 + this.endLabelW, t: 12, b: 28 };
    this.pw = this.w - this.m.l - this.m.r;
    this.ph = this.h - this.m.t - this.m.b;
    this.x0 = x0;
    this.x1 = x1 > x0 ? x1 : x0 + 1;
  }

  sx(t) {
    return this.m.l + ((t - this.x0) / (this.x1 - this.x0)) * this.pw;
  }

  sy(v) {
    return this.m.t + (1 - (v - this.y0) / (this.y1 - this.y0)) * this.ph;
  }

  _draw(ctx) {
    const d = this.data;
    const n = this._count();
    const { m, pw, ph } = this;
    const grid = this._css("--grid");
    const axis = this._css("--axis");
    const muted = this._css("--text-muted");
    const ink2 = this._css("--text-secondary");
    const surface = this._css("--surface-1");

    // 网格 + y 轴刻度
    ctx.font = this.font;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    ctx.lineWidth = 1;
    for (const v of this.yTicks) {
      const y = Math.round(this.sy(v)) + 0.5;
      ctx.strokeStyle = this.opts.zeroLine && v === 0 ? axis : grid;
      ctx.beginPath();
      ctx.moveTo(m.l, y);
      ctx.lineTo(m.l + pw, y);
      ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(this.opts.yFormat(v, this.yStep), m.l - 8, y);
    }

    // x 轴刻度
    const span = this.x1 - this.x0;
    const maxTicks = Math.max(2, Math.floor(pw / 96));
    const step = TIME_STEPS.find((s) => span / s <= maxTicks) || TIME_STEPS[TIME_STEPS.length - 1];
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = muted;
    ctx.strokeStyle = axis;
    const first = Math.ceil(this.x0 / step) * step;
    for (let t = first; t <= this.x1; t += step) {
      const x = Math.round(this.sx(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, m.t + ph);
      ctx.lineTo(x, m.t + ph + 4);
      ctx.stroke();
      const label = this.opts.xTick(t, step);
      const tw = ctx.measureText(label).width;
      if (x - tw / 2 < 0 || x + tw / 2 > this.w) continue;
      ctx.fillText(label, x, m.t + ph + 8);
    }
    ctx.beginPath();
    ctx.moveTo(m.l, Math.round(m.t + ph) + 0.5);
    ctx.lineTo(m.l + pw, Math.round(m.t + ph) + 0.5);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(m.l, m.t - 6, pw, ph + 12);
    ctx.clip();

    // 阈值线（虚线 = 「这是一条规则」，不是网格）
    ctx.setLineDash([4, 4]);
    for (const l of d.hLines || []) {
      const y = Math.round(this.sy(l.y)) + 0.5;
      ctx.strokeStyle = this._css(l.color || "--text-muted");
      ctx.beginPath();
      ctx.moveTo(m.l, y);
      ctx.lineTo(m.l + pw, y);
      ctx.stroke();
    }
    for (const l of d.vLines || []) {
      const x = Math.round(this.sx(l.t)) + 0.5;
      ctx.strokeStyle = this._css(l.color || "--text-muted");
      ctx.beginPath();
      ctx.moveTo(x, m.t);
      ctx.lineTo(x, m.t + ph);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 折线：每个像素列取 first/min/max/last，13 万点也不丢尖峰
    const i0 = Math.max(0, lowerBound(d.ts, this.x0, n) - 1);
    const i1 = Math.min(n, lowerBound(d.ts, this.x1, n) + 1);
    for (const s of d.series) {
      ctx.strokeStyle = this._css(s.color);
      ctx.lineWidth = s.width || 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      let col = null;
      let cMin = 0;
      let cMax = 0;
      let cLast = 0;
      let started = false;
      const flush = () => {
        if (col === null) return;
        ctx.lineTo(col, this.sy(cMin));
        ctx.lineTo(col, this.sy(cMax));
        ctx.lineTo(col, this.sy(cLast));
      };
      for (let i = i0; i < i1; i++) {
        const x = this.sx(d.ts[i]);
        const v = s.values[i];
        const c = Math.round(x);
        if (!started) {
          ctx.moveTo(x, this.sy(v));
          started = true;
        }
        if (c !== col) {
          flush();
          col = c;
          cMin = cMax = cLast = v;
          ctx.lineTo(c, this.sy(v));
        } else {
          if (v < cMin) cMin = v;
          if (v > cMax) cMax = v;
          cLast = v;
        }
      }
      flush();
      ctx.stroke();
    }

    // 标记
    for (const mk of d.markers || []) {
      if (mk.t < this.x0 || mk.t > this.x1) continue;
      this._marker(ctx, mk, surface, mk.id === d.highlight);
    }
    ctx.restore();

    // 阈值线标签（在裁剪区外画，防止被截断）
    ctx.font = this.font;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "right";
    for (const l of d.hLines || []) {
      if (!l.label) continue;
      this._labelBox(ctx, l.label, m.l + pw - 4, this.sy(l.y) - 3, "right", surface, ink2);
    }
    for (const l of d.vLines || []) {
      if (!l.label) continue;
      // 右边放不下就放到线的左侧
      const x = this.sx(l.t);
      const fitsRight = x + 4 + ctx.measureText(l.label).width <= m.l + pw;
      ctx.textAlign = fitsRight ? "left" : "right";
      this._labelBox(ctx, l.label, fitsRight ? x + 4 : x - 4, m.t + 14, ctx.textAlign, surface, ink2);
    }

    // 线尾标签（文字用正文色，颜色由旁边的短线承担）
    if (this.endLabelW && n) {
      const last = Math.min(i1, n) - 1;
      const ys = d.series.map((s) => this.sy(s.values[last]));
      const collide = ys.some((y, a) => ys.some((y2, b) => a !== b && Math.abs(y - y2) < 16));
      if (!collide) {
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        d.series.forEach((s, k) => {
          const x = m.l + pw + 8;
          ctx.strokeStyle = this._css(s.color);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, ys[k]);
          ctx.lineTo(x + 8, ys[k]);
          ctx.stroke();
          ctx.fillStyle = ink2;
          ctx.fillText(s.label, x + 12, ys[k]);
        });
      }
    }

    // 十字准线
    if (this.hoverIdx !== null && this.hoverIdx < n) {
      const i = this.hoverIdx;
      const x = Math.round(this.sx(d.ts[i])) + 0.5;
      ctx.strokeStyle = this._css("--text-muted");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, m.t);
      ctx.lineTo(x, m.t + ph);
      ctx.stroke();
      for (const s of d.series) {
        ctx.beginPath();
        ctx.arc(x, this.sy(s.values[i]), 4, 0, Math.PI * 2);
        ctx.fillStyle = this._css(s.color);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = surface;
        ctx.stroke();
      }
    }
  }

  _labelBox(ctx, text, x, y, align, surface, ink) {
    const w = ctx.measureText(text).width;
    const bx = align === "right" ? x - w - 3 : x - 3;
    ctx.fillStyle = surface;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(bx, y - 14, w + 6, 15);
    ctx.globalAlpha = 1;
    ctx.fillStyle = ink;
    ctx.fillText(text, x, y);
  }

  _marker(ctx, mk, surface, highlighted) {
    const x = this.sx(mk.t);
    const y = this.sy(mk.y);
    const r = highlighted ? 6.5 : 4.5;
    ctx.beginPath();
    if (mk.shape === "up") {
      const s = r + 1.5;
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y + s * 0.8);
      ctx.lineTo(x - s, y + s * 0.8);
      ctx.closePath();
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = this._css(mk.color);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = highlighted ? this._css("--text-primary") : surface;
    ctx.stroke();
  }

  _idxAt(px) {
    const d = this.data;
    const n = this._count();
    if (!n) return null;
    const t = this.x0 + ((px - this.m.l) / this.pw) * (this.x1 - this.x0);
    let i = lowerBound(d.ts, t, n);
    if (i >= n) i = n - 1;
    if (i > 0 && Math.abs(d.ts[i - 1] - t) < Math.abs(d.ts[i] - t)) i--;
    const lo = lowerBound(d.ts, this.x0, n);
    const hi = lowerBound(d.ts, this.x1 + 1, n) - 1;
    return Math.max(lo, Math.min(hi, i));
  }

  _onPointer(e) {
    if (!this.data || !this.pw) return;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (px < this.m.l - 4 || px > this.m.l + this.pw + 4) return this._clearHover();
    this.hoverIdx = this._idxAt(px);
    this.redraw();
    this._showTip(px, py);
  }

  _onKey(e) {
    if (!this.data) return;
    const n = this._count();
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const stepN = Math.max(1, Math.round(n / 100));
    const cur = this.hoverIdx ?? (e.key === "ArrowLeft" ? n : -1);
    this.hoverIdx = Math.max(0, Math.min(n - 1, cur + (e.key === "ArrowLeft" ? -stepN : stepN)));
    this.redraw();
    this._showTip(this.sx(this.data.ts[this.hoverIdx]), this.m.t + 20);
  }

  _clearHover() {
    if (this.hoverIdx === null) return;
    this.hoverIdx = null;
    this.tip.hidden = true;
    this.redraw();
  }

  _nearestMarker(px, py, radius) {
    let best = null;
    let bd = radius * radius;
    for (const mk of this.data.markers || []) {
      if (mk.t < this.x0 || mk.t > this.x1) continue;
      const dx = this.sx(mk.t) - px;
      const dy = this.sy(mk.y) - py;
      const dd = dx * dx + dy * dy;
      if (dd <= bd) {
        bd = dd;
        best = mk;
      }
    }
    return best;
  }

  _onClick(e) {
    if (!this.data?.markers || !this.opts.onSelect) return;
    const r = this.canvas.getBoundingClientRect();
    const mk = this._nearestMarker(e.clientX - r.left, e.clientY - r.top, 14);
    if (mk) this.opts.onSelect(mk);
  }

  _showTip(px, py) {
    const d = this.data;
    const i = this.hoverIdx;
    if (i === null) return;
    const tip = this.tip;
    tip.replaceChildren();
    const head = document.createElement("div");
    head.className = "tc-tip-head";
    head.textContent = this.opts.xTooltip(d.ts[i]);
    tip.append(head);
    for (const s of d.series) {
      tip.append(this._tipRow(s.color, this.opts.tipValue ? this.opts.tipValue(s.values[i], s) : this.opts.yFormat(s.values[i]), s.label, "line"));
    }
    // 准线附近的成交标记
    const near = (d.markers || []).filter((mk) => Math.abs(this.sx(mk.t) - this.sx(d.ts[i])) <= 6);
    for (const mk of near.slice(0, 4)) {
      tip.append(this._tipRow(mk.color, mk.tipValue, mk.tipLabel, mk.shape));
    }
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = px + 14;
    if (left + tw > this.w) left = px - tw - 14;
    if (left < 0) left = 0;
    let top = Math.max(0, Math.min(this.h - th, py - th / 2));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  _tipRow(color, value, label, shape) {
    const row = document.createElement("div");
    row.className = "tc-tip-row";
    const key = document.createElement("span");
    key.className = `tc-key tc-key-${shape}`;
    key.style.setProperty("--key", `var(${color})`);
    const v = document.createElement("strong");
    v.textContent = value;
    const l = document.createElement("span");
    l.className = "tc-tip-label";
    l.textContent = label;
    row.append(key, v, l);
    return row;
  }
}
