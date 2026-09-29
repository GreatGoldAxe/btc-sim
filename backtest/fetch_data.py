"""从币安公开 REST 拉历史 1m K 线，缓存到本地 CSV。

依赖: requests
域名: 用 data-api.binance.vision（官方备用域名，api.binance.com 在部分网络被屏蔽）
用法:
    python fetch_data.py --symbol BTCUSDT --days 90 [--force]
"""

import argparse
import csv
import os
import sys
import time

import requests

BASE_URL = "https://data-api.binance.vision/api/v3/klines"
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
INTERVAL = "1m"
FIELDS = ["timestamp_ms", "open", "high", "low", "close", "volume"]


def fetch_klines(symbol, days, force=False):
    """拉 symbol 最近 days 天的 1m K线，缓存到 CSV，返回缓存路径。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    out_path = os.path.join(DATA_DIR, f"{symbol}_{INTERVAL}.csv")
    if not force and os.path.exists(out_path):
        print(f"[skip] 已存在 {out_path}（--force 可重新拉取）")
        return out_path

    now_ms = int(time.time() * 1000)
    start_ms = now_ms - days * 24 * 3600 * 1000
    end_ms = now_ms

    s = requests.Session()
    bars = []
    while end_ms > start_ms:
        batch = _get_batch(s, symbol, end_ms)
        if not batch:
            break
        bars = batch + bars              # batch 是升序，往前补，保持整体升序
        earliest = batch[0][0]           # 本批最早一根的开盘时间
        end_ms = earliest - 1            # 下一批从这里再往前
        if len(bars) % 10000 < 1000:     # 每约 1 万根报一次进度
            print(f"[fetch] {symbol} 累计 {len(bars)} 根，已回到 "
                  f"{time.strftime('%Y-%m-%d', time.gmtime(earliest / 1000))}", flush=True)

    print(f"[fetch] {symbol} 共 {len(bars)} 根 K线")
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(FIELDS)
        for b in bars:
            w.writerow([b[0], b[1], b[2], b[3], b[4], b[5]])
    print(f"[done] 已缓存 -> {out_path}")
    return out_path


def _get_batch(session, symbol, end_ms):
    """带重试地拉一批（最多 1000 根，截止 end_ms）。失败返回 []。"""
    params = {"symbol": symbol, "interval": INTERVAL, "endTime": end_ms, "limit": 1000}
    for attempt in range(5):
        try:
            r = session.get(BASE_URL, params=params, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == 4:
                print(f"[error] 拉取失败: {e!r}", flush=True)
                return []
            time.sleep(2 ** attempt)
    return []


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    fetch_klines(args.symbol, args.days, args.force)
