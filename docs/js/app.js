import { run, summarize, breakEven, DEFAULT_PARAMS, INITIAL_CASH } from "./engine.js";
import { loadSnapshot, loadLiveRun, lastDays, fetchLatest } from "./data.js";
import { TimeChart } from "./chart.js";
import { t, setLang, getLang, detectLang, locale } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const SNAPSHOT_SYMBOLS = ["BTCUSDT", "DOGEUSDT"];
const COIN = { BTCUSDT: "BTC", DOGEUSDT: "DOGE", ETHUSDT: "ETH", SOLUSDT: "SOL" };
const REASON_COLOR = { take_profit: "--series-3", stop_loss: "--series-2", timeout: "--neutral-mark" };

// ---------------------------------------------------------------- 格式化

const MINUS = "−";
function num(v, digits = 2, sign = false) {
  const s = new Intl.NumberFormat(locale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: sign ? "exceptZero" : "auto",
  }).format(Object.is(v, -0) ? 0 : v);
  return s.replace("-", MINUS);
}
const usdt = (v, digits = 2) => num(v, digits, true);
function pct(x, digits = 1, sign = false) {
  return num(x * 100, digits, sign) + "%";
}
function signClass(el, v) {
  el.classList.toggle("is-pos", v > 0);
  el.classList.toggle("is-neg", v < 0);
}
function utcDate(ms, opts) {
  return new Intl.DateTimeFormat(locale(), { timeZone: "UTC", ...opts }).format(ms);
}
const fmtDay = (ms) => utcDate(ms, { month: "short", day: "numeric" });
const fmtDayYear = (ms) => utcDate(ms, { year: "numeric", month: "short", day: "numeric" });
const fmtHM = (ms) => utcDate(ms, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtHMS = (ms) => utcDate(ms, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const fmtDayHM = (ms) => `${fmtDay(ms)} ${fmtHM(ms)} UTC`;
// 小数位按步长取整，避免 0.30000000000000004
const snap = (v, step) => Number((Math.round(v / step) * step).toFixed(8));

function setPressed(container, value) {
  for (const b of container.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.v === String(value)));
  }
}

// ---------------------------------------------------------------- 滑块

function makeSlider(host, def, value, onInput) {
  const wrap = document.createElement("div");
  wrap.className = "slider";
  const top = document.createElement("div");
  top.className = "slider-top";
  const name = document.createElement("label");
  name.className = "slider-name";
  name.dataset.i18n = def.label;
  name.textContent = t(def.label);
  const val = document.createElement("span");
  val.className = "slider-val";
  top.append(name, val);
  const input = document.createElement("input");
  input.type = "range";
  input.min = def.min;
  input.max = def.max;
  input.step = def.step;
  input.id = `s-${host.id}-${def.key}`;
  name.htmlFor = input.id;
  wrap.append(top, input);
  if (def.help) {
    const help = document.createElement("p");
    help.className = "slider-help";
    help.dataset.i18n = def.help;
    help.textContent = t(def.help);
    wrap.append(help);
  }
  host.append(wrap);

  const api = {
    set(v) {
      input.value = v;
      api.refresh();
    },
    refresh() {
      const v = snap(Number(input.value), def.step);
      val.textContent = def.fmt(v);
      input.setAttribute("aria-valuetext", def.fmt(v));
    },
  };
  input.addEventListener("input", () => {
    api.refresh();
    onInput(snap(Number(input.value), def.step));
  });
  api.set(value);
  return api;
}

// ================================================================ 1 参数实验室

const LAB_SLIDERS = [
  { key: "momentum_bars", label: "p.momentum_bars", help: "p.momentum_bars.help", min: 1, max: 15, step: 1, fmt: (v) => t("unit.min", { n: v }) },
  { key: "momentum_threshold", label: "p.momentum_threshold", help: "p.momentum_threshold.help", min: 0, max: 0.005, step: 0.0001, fmt: (v) => pct(v, 2) },
  { key: "take_profit", label: "p.take_profit", help: "p.take_profit.help", min: 0.0005, max: 0.03, step: 0.0005, fmt: (v) => "+" + pct(v, 2) },
  { key: "stop_loss", label: "p.stop_loss", help: "p.stop_loss.help", min: 0.0005, max: 0.03, step: 0.0005, fmt: (v) => MINUS + pct(v, 2) },
  { key: "hold_bars", label: "p.hold_bars", help: "p.hold_bars.help", min: 1, max: 120, step: 1, fmt: (v) => t("unit.min", { n: v }) },
  { key: "fee_rate", label: "p.fee_rate", help: "p.fee_rate.help", min: 0, max: 0.002, step: 0.00025, fmt: (v) => pct(v, 3) },
];

const PRESETS = {
  original: { ...DEFAULT_PARAMS },
  nofee: { ...DEFAULT_PARAMS, fee_rate: 0 },
  wide: { ...DEFAULT_PARAMS, take_profit: 0.02, stop_loss: 0.01, hold_bars: 120 },
  picky: { ...DEFAULT_PARAMS, momentum_bars: 5, momentum_threshold: 0.003, take_profit: 0.01, stop_loss: 0.005, hold_bars: 30 },
};

const lab = {
  symbol: "BTCUSDT",
  days: 90,
  source: "snapshot",
  params: { ...DEFAULT_PARAMS },
  bars: null,
  result: null,
  sliders: {},
  loadToken: 0,
  abort: null,
  note: null, // { key, vars, error }
  pending: false,
};

let pnlChart;

function initLab() {
  const host = $("sliders");
  for (const def of LAB_SLIDERS) {
    lab.sliders[def.key] = makeSlider(host, def, lab.params[def.key], (v) => {
      lab.params[def.key] = v;
      scheduleRun();
    });
  }

  $("presets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-preset]");
    if (!b) return;
    lab.params = { ...PRESETS[b.dataset.preset] };
    for (const def of LAB_SLIDERS) lab.sliders[def.key].set(lab.params[def.key]);
    scheduleRun();
  });

  $("coin-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.v === lab.symbol) return;
    lab.symbol = b.dataset.v;
    if (!SNAPSHOT_SYMBOLS.includes(lab.symbol)) lab.source = "latest";
    loadLabData();
  });
  $("days-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    lab.days = Number(b.dataset.v);
    loadLabData();
  });
  $("source-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    lab.source = b.dataset.v;
    loadLabData();
  });

  pnlChart = new TimeChart($("pnl-chart"), {
    height: (w) => (w < 560 ? 240 : 320),
    zeroLine: true,
    endLabels: true,
    yFormat: (v, step) => num(v, step !== undefined && step < 1 ? 2 : 0),
    tipValue: (v) => usdt(v),
    xTick: (ms, step) => (step >= 86400e3 || ms % 86400e3 === 0 ? fmtDay(ms) : fmtHM(ms)),
    xTooltip: fmtDayHM,
  });

  $("daily-details").addEventListener("toggle", renderDaily);
  loadLabData();
}

function renderFilters() {
  setPressed($("coin-seg"), lab.symbol);
  setPressed($("days-seg"), lab.days);
  setPressed($("source-seg"), lab.source);
  for (const b of $("days-seg").querySelectorAll("button")) b.textContent = t("lab.days", { n: b.dataset.v });
  $("source-seg").querySelector('[data-v="snapshot"]').disabled = !SNAPSHOT_SYMBOLS.includes(lab.symbol);
}

function renderNote() {
  const el = $("data-note");
  el.replaceChildren();
  el.classList.toggle("is-error", !!lab.note?.error);
  if (!lab.note) return;
  const parts = Array.isArray(lab.note) ? lab.note : [lab.note];
  el.textContent = parts.map((p) => t(p.key, p.vars)).join(" ");
  if (lab.note.progress !== undefined) {
    const bar = document.createElement("span");
    bar.className = "progress";
    const fill = document.createElement("span");
    fill.style.width = `${Math.round(lab.note.progress * 100)}%`;
    bar.append(fill);
    el.append(bar);
  }
}

function rangeNote(key, bars) {
  return { key, vars: { from: fmtDayYear(bars.start), to: fmtDayYear(bars.end - 60_000) } };
}

async function loadLabData() {
  renderFilters();
  const token = ++lab.loadToken;
  lab.abort?.abort();
  lab.abort = null;
  $("results").classList.add("is-loading");
  $("pnl-chart").classList.add("is-loading");

  const { symbol, days } = lab;
  let bars;
  let note;
  try {
    if (lab.source === "snapshot") {
      lab.note = { key: "lab.loading" };
      renderNote();
      bars = lastDays(await loadSnapshot(symbol), days);
      note = rangeNote("lab.snapshotNote", bars);
    } else {
      const ctrl = new AbortController();
      lab.abort = ctrl;
      const pre = SNAPSHOT_SYMBOLS.includes(symbol) ? [] : [{ key: "lab.latestOnly", vars: { coin: COIN[symbol] } }];
      lab.note = { key: "lab.downloading", vars: { pct: "0%" }, progress: 0 };
      renderNote();
      bars = await fetchLatest(symbol, days, (p) => {
        if (token !== lab.loadToken) return;
        lab.note = { key: "lab.downloading", vars: { pct: pct(p, 0) }, progress: p };
        renderNote();
      }, ctrl.signal);
      note = [...pre, rangeNote("lab.latestNote", bars)];
    }
  } catch (err) {
    if (token !== lab.loadToken) return;
    const msg = err?.message || String(err);
    if (SNAPSHOT_SYMBOLS.includes(symbol)) {
      lab.source = "snapshot";
      renderFilters();
      bars = lastDays(await loadSnapshot(symbol), days);
      note = { key: "lab.fetchError", vars: { err: msg }, error: true };
    } else {
      lab.note = { key: "lab.fetchErrorNoFallback", vars: { err: msg }, error: true };
      renderNote();
      $("results").classList.remove("is-loading");
      $("pnl-chart").classList.remove("is-loading");
      return;
    }
  }
  if (token !== lab.loadToken) return;
  lab.bars = bars;
  lab.note = note;
  renderNote();
  $("results").classList.remove("is-loading");
  $("pnl-chart").classList.remove("is-loading");
  runLab();
}

function scheduleRun() {
  if (lab.pending) return;
  lab.pending = true;
  requestAnimationFrame(() => {
    lab.pending = false;
    runLab();
  });
}

function runLab() {
  renderPresetState();
  if (!lab.bars) return;
  const { acct, equity, fees } = run(lab.bars, lab.params);
  const s = summarize(acct, equity);
  const after = new Float64Array(equity.length);
  const before = new Float64Array(equity.length);
  for (let i = 0; i < equity.length; i++) {
    after[i] = equity[i] - INITIAL_CASH;
    before[i] = equity[i] + fees[i] - INITIAL_CASH;
  }
  lab.result = { acct, s, after, before };
  renderLabResults();
}

function renderPresetState() {
  for (const b of $("presets").querySelectorAll("[data-preset]")) {
    const p = PRESETS[b.dataset.preset];
    const same = Object.keys(p).every((k) => Math.abs(p[k] - lab.params[k]) < 1e-12);
    b.setAttribute("aria-pressed", String(same));
  }
}

function renderLabResults() {
  const r = lab.result;
  if (!r) return;
  const { s } = r;
  const n = s.roundTrips;
  const before = s.realizedPnl + s.closedFees;

  $("r-net").textContent = `${usdt(s.realizedPnl)} USDT`;
  signClass($("r-net"), s.realizedPnl);
  $("r-return").textContent = t("res.ofStart", { pct: pct(s.realizedPnl / INITIAL_CASH, 2, true) });
  $("r-before").textContent = usdt(before);
  signClass($("r-before"), before);
  $("r-fees").textContent = num(s.closedFees);
  $("r-trades").textContent = num(n, 0);
  $("r-winrate").textContent = n ? pct(s.winRate) : "–";
  $("r-wins").textContent = n ? t("res.wins", { w: num(s.wins, 0), n: num(n, 0) }) : "";

  $("no-trades").hidden = n > 0;
  $("per-trade").hidden = n === 0;
  if (n) {
    $("pt-total").textContent = usdt(s.realizedPnl / n, 3);
    $("pt-fees").textContent = usdt(-s.closedFees / n, 3);
    $("pt-price").textContent = usdt(s.pricePnl / n, 3);
    signClass($("pt-total"), s.realizedPnl / n);
  }

  const series = [
    { key: "after", label: t("series.after"), values: r.after, color: "--series-1" },
    { key: "before", label: t("series.before"), values: r.before, color: "--series-2" },
  ];
  pnlChart.update({ ts: lab.bars.ts, series });
  pnlChart.setAriaLabel(`${t("chart.pnl")}: ${t("series.after")} ${usdt(s.realizedPnl)} USDT, ${t("series.before")} ${usdt(before)} USDT`);

  // 平仓方式表
  const tbody = $("exit-table").querySelector("tbody");
  tbody.replaceChildren();
  for (const key of ["take_profit", "stop_loss", "timeout"]) {
    const row = s.reasons[key];
    const tr = document.createElement("tr");
    const share = n ? row.count / n : 0;
    tr.append(
      cellReason(key),
      cell(num(row.count, 0), true),
      cellShare(share, REASON_COLOR[key]),
      cell(row.count ? usdt(row.pricePnl / row.count, 3) : "–", true),
      cell(row.count ? usdt(row.pnl / row.count, 3) : "–", true),
    );
    tbody.append(tr);
  }
  renderDaily();
}

function cell(text, isNum) {
  const td = document.createElement("td");
  td.textContent = text;
  if (isNum) td.className = "num";
  return td;
}

function cellReason(key) {
  const td = document.createElement("td");
  const span = document.createElement("span");
  span.className = "reason-cell";
  const dot = document.createElement("span");
  dot.className = "key-dot";
  dot.style.setProperty("--key", `var(${REASON_COLOR[key]})`);
  const label = document.createElement("span");
  label.textContent = t(`reason.${key}`);
  span.append(dot, label);
  td.append(span);
  return td;
}

function cellShare(share, color) {
  const td = document.createElement("td");
  const wrap = document.createElement("div");
  wrap.className = "share-bar";
  const track = document.createElement("div");
  track.className = "share-track";
  const fill = document.createElement("div");
  fill.className = "share-fill";
  fill.style.width = `${share * 100}%`;
  fill.style.setProperty("--key", `var(${color})`);
  track.append(fill);
  const p = document.createElement("span");
  p.className = "share-pct";
  p.textContent = pct(share);
  wrap.append(track, p);
  td.append(wrap);
  return td;
}

function renderDaily() {
  if (!$("daily-details").open || !lab.result) return;
  const ts = lab.bars.ts;
  const days = new Map();
  for (const tr of lab.result.acct.closedTrades) {
    const day = Math.floor(ts[tr.exitIdx] / 86400e3) * 86400e3;
    const d = days.get(day) || { n: 0, before: 0, after: 0 };
    d.n++;
    d.before += tr.pricePnl;
    d.after += tr.pnl;
    days.set(day, d);
  }
  const tbody = $("daily-table").querySelector("tbody");
  tbody.replaceChildren();
  for (const [day, d] of [...days].sort((a, b) => a[0] - b[0])) {
    const tr = document.createElement("tr");
    tr.append(cell(fmtDayYear(day)), cell(num(d.n, 0), true), cell(usdt(d.before), true), cell(usdt(d.after), true));
    tbody.append(tr);
  }
}

// ================================================================ 2 保本计算器

const BE_SLIDERS = [
  { key: "tp", label: "be.tp", min: 0.0005, max: 0.03, step: 0.0005, fmt: (v) => "+" + pct(v, 2) },
  { key: "sl", label: "be.sl", min: 0.0005, max: 0.03, step: 0.0005, fmt: (v) => MINUS + pct(v, 2) },
  { key: "fee", label: "be.fee", min: 0, max: 0.002, step: 0.00025, fmt: (v) => pct(v, 3) },
];
const BE_PRESETS = {
  live: { tp: 0.003, sl: 0.0015, fee: 0.001 },
  first: { tp: 0.001, sl: 0.001, fee: 0.001 },
  sym: { tp: 0.01, sl: 0.01, fee: 0.001 },
};
const LIVE_TP_SHARE = 2 / 20; // 实盘：触及目标的 20 笔里 2 笔止盈
const be = { ...BE_PRESETS.live, sliders: {} };

function initBreakEven() {
  const host = $("be-inputs");
  for (const def of BE_SLIDERS) {
    be.sliders[def.key] = makeSlider(host, def, be[def.key], (v) => {
      be[def.key] = v;
      renderBreakEven();
    });
  }
  $("be-presets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-be]");
    if (!b) return;
    Object.assign(be, BE_PRESETS[b.dataset.be]);
    for (const def of BE_SLIDERS) be.sliders[def.key].set(be[def.key]);
    renderBreakEven();
  });
  renderBreakEven();
}

function placeMark(el, p, label) {
  el.style.left = `${p * 100}%`;
  const span = el.querySelector("span");
  span.textContent = label;
  // 贴边时标签往里收，避免被裁掉
  span.style.transform = p < 0.12 ? "translateX(-4px)" : p > 0.88 ? "translateX(calc(-100% + 4px))" : "translateX(-50%)";
}

function renderBreakEven() {
  const r = breakEven(be.tp, be.sl, be.fee);
  for (const [id, v] of [["be-win", r.win], ["be-loss", r.loss], ["be-flat", r.flat]]) {
    $(id).textContent = `${usdt(v, 3)} USDT`;
    signClass($(id), v);
  }
  for (const b of $("be-presets").querySelectorAll("[data-be]")) {
    const p = BE_PRESETS[b.dataset.be];
    b.setAttribute("aria-pressed", String(["tp", "sl", "fee"].every((k) => Math.abs(p[k] - be[k]) < 1e-12)));
  }
  const need = $("be-mark-need");
  if (r.required === null) {
    $("be-verdict").textContent = t("be.impossible");
    $("be-fill").style.width = "100%";
    need.hidden = true;
  } else {
    $("be-verdict").textContent = t("be.required", { p: pct(r.required) });
    $("be-fill").style.width = `${r.required * 100}%`;
    need.hidden = false;
    placeMark(need, r.required, t("be.marker.need", { p: pct(r.required) }));
  }
  placeMark($("be-mark-live"), LIVE_TP_SHARE, t("be.marker.live", { p: pct(LIVE_TP_SHARE, 0) }));
  $("be-note").textContent = t("be.note", { flat: `${usdt(r.flat, 3)} USDT` });
}

// ================================================================ 3 实盘回放

const rp = {
  data: null,
  trips: [],
  t0: 0,
  t1: 0,
  cur: 0,
  playing: false,
  lastFrame: 0,
  selected: null, // 选中的来回编号
  pinned: false, // 用户手动选过，播放时不再自动跟随
  shownCount: -1,
};
let rpChart;
let rpDetail;

function buildTrips(trades) {
  const trips = [];
  let open = null;
  for (const tr of trades) {
    if (tr.side === "BUY") {
      open = tr;
    } else if (open) {
      const held = (tr.t - open.t) / 1000;
      const pricePnl = (tr.price - open.price) * open.qty;
      // 旧格式 trades.csv 没有平仓原因：持仓 ≥58 秒判为超时，其余按价差方向（同 FINDINGS.md）
      const reason = held >= 58 ? "timeout" : tr.price > open.price ? "take_profit" : "stop_loss";
      trips.push({ n: trips.length + 1, buy: open, sell: tr, held, pricePnl, fees: open.fee + tr.fee, pnl: tr.pnl, reason });
      open = null;
    }
  }
  if (open) trips.push({ n: trips.length + 1, buy: open, sell: null, reason: "open" });
  return trips;
}

async function initReplay() {
  rpChart = new TimeChart($("rp-chart"), {
    height: (w) => (w < 560 ? 260 : 340),
    yFormat: (v, step) => num(v, step < 0.0001 ? 5 : 4),
    tipValue: (v) => num(v, 5),
    xTick: (ms) => fmtHM(ms),
    xTooltip: (ms) => `${fmtHMS(ms)} UTC`,
    onSelect: (mk) => selectTrip(mk.trip, true),
  });
  rpDetail = new TimeChart($("rp-detail-chart"), {
    height: 220,
    yFormat: (v, step) => num(v, step < 0.0001 ? 5 : 4),
    tipValue: (v) => num(v, 5),
    xTick: (ms) => fmtHMS(ms),
    xTooltip: (ms) => `${fmtHMS(ms)} UTC`,
  });

  try {
    rp.data = await loadLiveRun();
  } catch {
    $("rp-detail-none").textContent = t("rp.loadError");
    return;
  }
  rp.trips = buildTrips(rp.data.trades);
  rp.t0 = rp.data.ts[0];
  rp.t1 = rp.data.ts[rp.data.ts.length - 1];
  rp.cur = rp.t1;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of rp.data.price) {
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  for (const tr of rp.data.trades) {
    lo = Math.min(lo, tr.price);
    hi = Math.max(hi, tr.price);
  }
  rp.yDomain = [lo, hi];

  $("rp-play").addEventListener("click", togglePlay);
  $("rp-restart").addEventListener("click", () => {
    rp.cur = rp.t0;
    rp.pinned = false;
    rp.selected = null;
    if (!rp.playing) togglePlay();
    else renderReplay();
  });
  $("rp-scrub").addEventListener("input", (e) => {
    rp.cur = rp.t0 + (Number(e.target.value) / 1000) * (rp.t1 - rp.t0);
    renderReplay();
  });
  $("rp-log").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-n]");
    if (tr) selectTrip(Number(tr.dataset.n), true);
  });
  $("rp-log").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-n]");
    if (tr && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      selectTrip(Number(tr.dataset.n), true);
    }
  });

  rp.selected = rp.trips.find((x) => x.reason === "take_profit")?.n ?? 1;
  renderReplay();
}

function togglePlay() {
  rp.playing = !rp.playing;
  if (rp.playing) {
    if (rp.cur >= rp.t1) rp.cur = rp.t0;
    rp.pinned = false;
    rp.lastFrame = performance.now();
    requestAnimationFrame(tick);
  }
  renderPlayButton();
  renderReplay();
}

function renderPlayButton() {
  const label = $("rp-play").querySelector("span");
  label.dataset.i18n = rp.playing ? "rp.pause" : "rp.play";
  label.textContent = t(label.dataset.i18n);
}

function tick(now) {
  if (!rp.playing) return;
  const dt = Math.min(100, now - rp.lastFrame);
  rp.lastFrame = now;
  rp.cur += dt * Number($("rp-speed").value);
  if (rp.cur >= rp.t1) {
    rp.cur = rp.t1;
    rp.playing = false;
    renderPlayButton();
  }
  renderReplay();
  if (rp.playing) requestAnimationFrame(tick);
}

function selectTrip(n, pin) {
  rp.selected = n;
  if (pin) rp.pinned = true;
  renderReplay(true);
}

function visibleTrips() {
  return rp.trips.filter((x) => x.buy.t <= rp.cur);
}

function renderReplay(forceLog = false) {
  if (!rp.data) return;
  const { ts, price } = rp.data;
  let count = 0;
  while (count < ts.length && ts[count] <= rp.cur) count++;
  // 二分会更快，但 5,500 个点每帧线性扫一遍也只要几微秒

  const trips = visibleTrips();
  const closed = trips.filter((x) => x.sell && x.sell.t <= rp.cur);
  if (!rp.pinned && rp.playing && trips.length) rp.selected = trips[trips.length - 1].n;

  // 统计（只算已平仓的来回，口径同 README）
  let net = 0;
  let fees = 0;
  let before = 0;
  for (const x of closed) {
    net += x.pnl;
    fees += x.fees;
    before += x.pricePnl;
  }
  $("rp-trades").textContent = num(closed.length, 0);
  $("rp-net").textContent = usdt(net);
  signClass($("rp-net"), net);
  $("rp-fees").textContent = num(fees);
  $("rp-before").textContent = usdt(before);
  signClass($("rp-before"), before);
  $("rp-clock").textContent = `${fmtHMS(rp.cur)} UTC`;
  $("rp-scrub").value = String(Math.round(((rp.cur - rp.t0) / (rp.t1 - rp.t0)) * 1000));

  const markers = [];
  for (const x of trips) {
    markers.push({ id: `b${x.n}`, trip: x.n, t: x.buy.t, y: x.buy.price, shape: "up", color: "--series-1", tipLabel: `${t("reason.buy")} #${x.n}`, tipValue: num(x.buy.price, 5) });
    if (x.sell && x.sell.t <= rp.cur) {
      markers.push({ id: `s${x.n}`, trip: x.n, t: x.sell.t, y: x.sell.price, shape: "dot", color: REASON_COLOR[x.reason], tipLabel: `${t(`reason.${x.reason}`)} #${x.n}`, tipValue: num(x.sell.price, 5) });
    }
  }
  const series = [{ key: "price", label: "DOGE", values: price, color: "--price-line", width: 1.5 }];
  rpChart.update({ ts, series, count, markers, xDomain: [rp.t0, rp.t1], yDomain: rp.yDomain, highlight: rp.selected ? `b${rp.selected}` : null });
  rpChart.setAriaLabel(`${t("rp.chart")}: ${closed.length} ${t("rp.trades")}, ${t("rp.net")} ${usdt(net)} USDT`);

  renderDetail(count);
  if (forceLog || trips.length !== rp.shownCount || closed.length !== rp.shownClosed) renderLog(trips);
}

function renderDetail(count) {
  const x = rp.trips.find((tr) => tr.n === rp.selected && tr.buy.t <= rp.cur);
  $("rp-detail-none").hidden = !!x;
  $("rp-detail-chart").hidden = !x;
  $("rp-detail-list").hidden = !x;
  $("rp-detail-title").textContent = x ? t("rp.detail", { n: x.n }) : t("rp.log");
  if (!x) return;
  const { ts, price } = rp.data;
  const entry = x.buy.price;
  const sold = x.sell && x.sell.t <= rp.cur;
  const endT = Math.max(x.sell ? x.sell.t : x.buy.t + 60_000, x.buy.t + 60_000);
  const markers = [{ id: "b", t: x.buy.t, y: entry, shape: "up", color: "--series-1", tipLabel: t("reason.buy"), tipValue: num(entry, 5) }];
  if (sold) markers.push({ id: "s", t: x.sell.t, y: x.sell.price, shape: "dot", color: REASON_COLOR[x.reason], tipLabel: t(`reason.${x.reason}`), tipValue: num(x.sell.price, 5) });
  rpDetail.update({
    ts,
    series: [{ key: "price", label: "DOGE", values: price, color: "--price-line", width: 2 }],
    count,
    markers,
    xDomain: [x.buy.t - 20_000, endT + 15_000],
    hLines: [
      { y: entry * 1.003, label: t("rp.detail.tp"), color: "--series-3" },
      { y: entry, label: t("rp.detail.entry"), color: "--text-muted" },
      { y: entry * (1 - 0.0015), label: t("rp.detail.sl"), color: "--series-2" },
    ],
    vLines: [{ t: x.buy.t + 60_000, label: t("rp.detail.timeout") }],
  });

  const dl = $("rp-detail-list");
  dl.replaceChildren();
  const add = (k, v, cls) => {
    const d = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = t(k);
    const dd = document.createElement("dd");
    dd.textContent = v;
    if (cls !== undefined) signClass(dd, cls);
    d.append(dt, dd);
    dl.append(d);
  };
  add("rp.detail.bought", num(entry, 5));
  add("rp.detail.sold", sold ? num(x.sell.price, 5) : "–");
  add("rp.detail.held", sold ? t("unit.s", { n: num(x.held, 1) }) : "–");
  add("rp.detail.exit", sold ? t(`reason.${x.reason}`) : t("reason.open"));
  if (sold) {
    add("rp.detail.price", usdt(x.pricePnl, 3), x.pricePnl);
    add("rp.detail.fees", usdt(-x.fees, 3), -1);
    add("rp.detail.net", usdt(x.pnl, 3), x.pnl);
  }
}

function renderLog(trips) {
  rp.shownCount = trips.length;
  rp.shownClosed = trips.filter((x) => x.sell && x.sell.t <= rp.cur).length;
  const tbody = $("rp-log").querySelector("tbody");
  tbody.replaceChildren();
  $("rp-log-empty").hidden = trips.length > 0;
  for (const x of [...trips].reverse()) {
    const sold = x.sell && x.sell.t <= rp.cur;
    const tr = document.createElement("tr");
    tr.dataset.n = x.n;
    tr.tabIndex = 0;
    if (x.n === rp.selected) tr.classList.add("is-selected");
    const reasonKey = sold ? x.reason : "open";
    const reasonTd = sold ? cellReason(x.reason) : cell(t(`reason.${reasonKey}`));
    const priceTd = cell(sold ? usdt(x.pricePnl, 3) : "–", true);
    const netTd = cell(sold ? usdt(x.pnl, 3) : "–", true);
    if (sold) signClass(netTd, x.pnl);
    tr.append(
      cell(String(x.n), true),
      cell(fmtHMS(x.buy.t)),
      cell(sold ? t("unit.s", { n: num(x.held, 0) }) : "–", true),
      reasonTd,
      priceTd,
      netTd,
    );
    tbody.append(tr);
  }
}

// ================================================================ 语言 / 主题

function applyLang(l) {
  setLang(l);
  renderFilters();
  renderNote();
  for (const s of Object.values(lab.sliders)) s.refresh();
  for (const s of Object.values(be.sliders)) s.refresh();
  renderLabResults();
  renderBreakEven();
  renderPlayButton();
  renderReplay(true);
}

function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function redrawCharts() {
  pnlChart?.redraw();
  rpChart?.redraw();
  rpDetail?.redraw();
}

function init() {
  setLang(detectLang());
  $("lang-toggle").addEventListener("click", () => applyLang(getLang() === "zh" ? "en" : "zh"));
  $("theme-toggle").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("btc-sim-theme", next);
    } catch {}
    redrawCharts();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redrawCharts);

  initLab();
  initBreakEven();
  initReplay();
}

init();
