"""生成网站（docs/）用的内置数据。

产物（都写到 docs/data/，随仓库发布，网站离线也能用）：
    - {SYMBOL}_1m_90d.json：截至某个 UTC 零点的 90 天 1m K 线，只保留回测用到的 open / close
    - live_run.json：results/trades.csv 那次 90 分钟实盘的逐笔成交 + 同时段 DOGE 1s K 线收盘价

价格编码：按「最小价格单位」换成整数再做差分，网页端用 整数 / 10**decimals 还原，
和 Python 里 float("0.09541") 得到的是同一个浮点数，所以回测结果能逐位对上。

用法（在仓库根目录）：
    python tools/build_site_data.py              # 窗口截至今天 UTC 零点
    python tools/build_site_data.py --end 2026-10-10
"""

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backtest"))

import requests

from fetch_data import _get_batch

OUT_DIR = os.path.join(ROOT, "docs", "data")
SYMBOLS = ["BTCUSDT", "DOGEUSDT"]
DAYS = 90
MIN_MS = 60 * 1000
TRADES_CSV = os.path.join(ROOT, "results", "trades.csv")


def fetch_range(session, symbol, interval, start_ms, end_open_ms):
    """拉 [start_ms, end_open_ms] 之间开盘的所有 K 线（升序）。"""
    bars = []
    end_ms = end_open_ms
    while end_ms >= start_ms:
        batch = _get_batch_interval(session, symbol, interval, end_ms)
        if not batch:
            break
        bars = batch + bars
        end_ms = batch[0][0] - 1
        print(f"[fetch] {symbol} {interval} 累计 {len(bars)} 根", end="\r", flush=True)
    print()
    return [b for b in bars if start_ms <= b[0] <= end_open_ms]


def _get_batch_interval(session, symbol, interval, end_ms):
    if interval == "1m":
        return _get_batch(session, symbol, end_ms)
    # fetch_data 只支持 1m，1s 在这里单独请求
    params = {"symbol": symbol, "interval": interval, "endTime": end_ms, "limit": 1000}
    for attempt in range(5):
        try:
            r = session.get("https://data-api.binance.vision/api/v3/klines", params=params, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == 4:
                raise RuntimeError(f"拉取 {symbol} {interval} K线失败: {e!r}") from e
            time.sleep(2 ** attempt)


def decimals_of(prices):
    """一组价格字符串里，去掉末尾 0 之后最多的小数位数。"""
    d = 0
    for p in prices:
        exp = Decimal(p).normalize().as_tuple().exponent
        d = max(d, -exp if exp < 0 else 0)
    return d


def to_int(p, dec):
    v = Decimal(p) * (10 ** dec)
    assert v == v.to_integral_value(), p
    return int(v)


def build_klines(session, symbol, end_day):
    end_ms = int(end_day.timestamp() * 1000)
    first_open = end_ms - DAYS * 24 * 60 * MIN_MS
    last_open = end_ms - MIN_MS
    bars = fetch_range(session, symbol, "1m", first_open, last_open)
    print(f"[data] {symbol} {len(bars)} 根（窗口应有 {DAYS * 24 * 60} 根）")

    dec = decimals_of([b[1] for b in bars] + [b[4] for b in bars])
    # open 与上一根 close 通常相等或只差一两个价位，存差值体积最小
    opens_d, closes_d, gaps = [], [], []
    prev_close = 0
    for i, b in enumerate(bars):
        o, c = to_int(b[1], dec), to_int(b[4], dec)
        opens_d.append(o - prev_close)
        closes_d.append(c - o)
        prev_close = c
        if i > 0 and b[0] - bars[i - 1][0] != MIN_MS:
            gaps.append([i, b[0]])     # 交易所停机等原因造成的缺口：从第 i 根起时间戳另起

    out = {
        "symbol": symbol,
        "interval": "1m",
        "start": bars[0][0],
        "end": bars[-1][0] + MIN_MS,
        "decimals": dec,
        "count": len(bars),
        "gaps": gaps,
        "open": opens_d,     # open[i] = close[i-1] + 本值（i=0 时相对 0）
        "close": closes_d,   # close[i] = open[i] + 本值
    }
    path = os.path.join(OUT_DIR, f"{symbol}_1m_{DAYS}d.json")
    _write_json(path, out)
    # 同时写一份和 backtest/data 同格式的 CSV，供 Python 回测核对用（*.csv 已被 gitignore）
    csv_path = os.path.join(ROOT, "backtest", "data", f"{symbol}_1m_site.csv")
    os.makedirs(os.path.dirname(csv_path), exist_ok=True)
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["timestamp_ms", "open", "high", "low", "close", "volume"])
        for b in bars:
            w.writerow([b[0], b[1], b[2], b[3], b[4], b[5]])


def build_live_run(session):
    with open(TRADES_CSV, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    times = [datetime.fromisoformat(r["time_utc"]) for r in rows]
    t0 = int(times[0].timestamp()) * 1000 - 60_000
    t1 = int(times[-1].timestamp()) * 1000 + 120_000
    bars = fetch_range(session, "DOGEUSDT", "1s", t0, t1)
    print(f"[data] DOGEUSDT 1s {len(bars)} 根")

    dec = decimals_of([b[4] for b in bars] + [r["price"] for r in rows])
    # 1s K 线在没有成交的秒是缺失的，按时间戳存差分，网页端按时间画
    ts_d, close_d = [], []
    prev_t, prev_c = 0, 0
    for b in bars:
        c = to_int(b[4], dec)
        ts_d.append((b[0] - prev_t) // 1000)
        close_d.append(c - prev_c)
        prev_t, prev_c = b[0], c

    trades = [{
        "t": int(round(datetime.fromisoformat(r["time_utc"]).timestamp() * 1000)),
        "side": r["side"],
        "price": r["price"],
        "qty": float(r["qty"]),
        "fee": float(r["fee"]),
        "pnl": float(r["pnl"]),
    } for r in rows]

    out = {
        "symbol": "DOGEUSDT",
        "decimals": dec,
        "seconds": ts_d,     # 秒级时间戳差分，第一个是相对 0 的绝对秒
        "close": close_d,
        "trades": trades,
    }
    _write_json(os.path.join(OUT_DIR, "live_run.json"), out)


def _write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)
    print(f"[done] {os.path.relpath(path, ROOT)}  {os.path.getsize(path) / 1024:,.0f} KB")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--end", help="窗口结束日（UTC 零点，不含），默认今天，如 2026-10-10")
    parser.add_argument("--skip-klines", action="store_true", help="只重建 live_run.json")
    args = parser.parse_args()

    if args.end:
        end_day = datetime.strptime(args.end, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    else:
        now = datetime.now(timezone.utc)
        end_day = now.replace(hour=0, minute=0, second=0, microsecond=0)

    s = requests.Session()
    if not args.skip_klines:
        for sym in SYMBOLS:
            build_klines(s, sym, end_day)
    build_live_run(s)
