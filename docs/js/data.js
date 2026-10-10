// 行情数据：内置快照（docs/data/*.json）或从币安公开 API 现拉。
// 两者都解码成 { ts, open, close }（Float64Array），给 engine.run 用。

const KLINES_URL = "https://data-api.binance.vision/api/v3/klines";
const MIN_MS = 60_000;

/** 解码 tools/build_site_data.py 写出的 1m 快照。 */
export function decodeKlines(j) {
  const n = j.count;
  const scale = 10 ** j.decimals;
  const ts = new Float64Array(n);
  const open = new Float64Array(n);
  const close = new Float64Array(n);
  let prevClose = 0;
  let t = j.start;
  let g = 0;
  for (let i = 0; i < n; i++) {
    if (g < j.gaps.length && j.gaps[g][0] === i) {
      t = j.gaps[g][1];
      g++;
    } else if (i > 0) {
      t += MIN_MS;
    }
    const o = prevClose + j.open[i];
    const c = o + j.close[i];
    ts[i] = t;
    // 整数 / 10^d 与 Python float("0.09541") 是同一个浮点数
    open[i] = o / scale;
    close[i] = c / scale;
    prevClose = c;
  }
  return { ts, open, close, start: j.start, end: j.end };
}

/** 解码实盘回放数据：1s 收盘价 + 逐笔成交。 */
export function decodeLiveRun(j) {
  const scale = 10 ** j.decimals;
  const n = j.seconds.length;
  const ts = new Float64Array(n);
  const price = new Float64Array(n);
  let t = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    t += j.seconds[i];
    c += j.close[i];
    ts[i] = t * 1000;
    price[i] = c / scale;
  }
  return { ts, price, trades: j.trades.map((r) => ({ ...r, price: Number(r.price) })) };
}

const snapshotCache = new Map();

export async function loadSnapshot(symbol) {
  if (!snapshotCache.has(symbol)) {
    const p = fetch(`data/${symbol}_1m_90d.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(decodeKlines);
    snapshotCache.set(symbol, p);
    p.catch(() => snapshotCache.delete(symbol));
  }
  return snapshotCache.get(symbol);
}

export async function loadLiveRun() {
  const r = await fetch("data/live_run.json");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return decodeLiveRun(await r.json());
}

/** 取最后 days 天（快照或现拉的结果都适用）。 */
export function lastDays(bars, days) {
  const from = bars.end - days * 24 * 60 * MIN_MS;
  let i = 0;
  while (i < bars.ts.length && bars.ts[i] < from) i++;
  return {
    ts: bars.ts.subarray(i),
    open: bars.open.subarray(i),
    close: bars.close.subarray(i),
    start: from,
    end: bars.end,
  };
}

const liveCache = new Map();

/**
 * 从币安拉最近 days 天、截至最后一根已收盘的 1m K 线（同 backtest/fetch_data.py 的窗口）。
 * onProgress(0..1)；signal 用于取消。
 */
export async function fetchLatest(symbol, days, onProgress, signal) {
  const key = `${symbol}:${days}`;
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < 5 * MIN_MS) return hit.bars;

  const now = Date.now();
  const lastOpen = Math.floor(now / MIN_MS) * MIN_MS - MIN_MS;
  const firstOpen = lastOpen - (days * 24 * 60 - 1) * MIN_MS;

  // 按 1000 根一段切好，4 路并发
  const chunks = [];
  for (let s = firstOpen; s <= lastOpen; s += 1000 * MIN_MS) {
    chunks.push([s, Math.min(s + 999 * MIN_MS, lastOpen)]);
  }
  const results = new Array(chunks.length);
  let done = 0;
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const k = next++;
      results[k] = await getChunk(symbol, chunks[k][0], chunks[k][1], signal);
      done++;
      onProgress?.(done / chunks.length);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);

  const rows = results.flat();
  const n = rows.length;
  const bars = {
    ts: new Float64Array(n),
    open: new Float64Array(n),
    close: new Float64Array(n),
    start: firstOpen,
    end: lastOpen + MIN_MS,
  };
  for (let i = 0; i < n; i++) {
    bars.ts[i] = rows[i][0];
    bars.open[i] = Number(rows[i][1]);
    bars.close[i] = Number(rows[i][4]);
  }
  liveCache.set(key, { bars, fetchedAt: Date.now() });
  return bars;
}

async function getChunk(symbol, startMs, endMs, signal) {
  const url = `${KLINES_URL}?symbol=${symbol}&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}
