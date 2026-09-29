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
BAR_MS = 60 * 1000
FIELDS = ["timestamp_ms", "open", "high", "low", "close", "volume"]


def fetch_klines(symbol, days, force=False):
    """拉 symbol 最近 days 天（截至最后一根已收盘）的 1m K线，缓存到 CSV，返回缓存路径。

    缓存按「交易对 + 天数」命名，不同 --days 互不复用。
    """
    os.makedirs(DATA_DIR, exist_ok=True)
    out_path = os.path.join(DATA_DIR, f"{symbol}_{INTERVAL}_{days}d.csv")
    if not force and os.path.exists(out_path):
        print(f"[skip] 已存在 {out_path}（--force 可重新拉取）")
        return out_path

    now_ms = int(time.time() * 1000)
    # 最后一根已收盘 K 线的开盘时间；当前这根还没收盘，不要
    last_open = now_ms // BAR_MS * BAR_MS - BAR_MS
    first_open = last_open - (days * 24 * 60 - 1) * BAR_MS
    end_ms = last_open

    s = requests.Session()
    bars = []
    while end_ms >= first_open:
        batch = _get_batch(s, symbol, end_ms)
        if not batch:
            break
        bars = batch + bars              # batch 是升序，往前补，保持整体升序
        earliest = batch[0][0]           # 本批最早一根的开盘时间
        end_ms = earliest - 1            # 下一批从这里再往前
        if len(bars) % 10000 < 1000:     # 每约 1 万根报一次进度
            print(f"[fetch] {symbol} 累计 {len(bars)} 根，已回到 "
                  f"{time.strftime('%Y-%m-%d', time.gmtime(earliest / 1000))}", flush=True)

    # 最后一批会越过窗口起点，裁掉多出来的部分
    bars = [b for b in bars if first_open <= b[0] <= last_open]
    expected = days * 24 * 60
    print(f"[fetch] {symbol} 共 {len(bars)} 根 K线（窗口应有 {expected} 根）")
    # 先写临时文件再替换，写到一半中断也不会留下残缺的缓存
    tmp_path = out_path + ".tmp"
    with open(tmp_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(FIELDS)
        for b in bars:
            w.writerow([b[0], b[1], b[2], b[3], b[4], b[5]])
    os.replace(tmp_path, out_path)
    print(f"[done] 已缓存 -> {out_path}")
    return out_path


def _get_batch(session, symbol, end_ms):
    """带重试地拉一批（最多 1000 根，截止 end_ms）。

    返回 [] 只表示交易所在 end_ms 之前已没有数据；重试用尽则抛异常，
    不能返回 []，否则残缺数据会被当成完整数据写进缓存。
    """
    params = {"symbol": symbol, "interval": INTERVAL, "endTime": end_ms, "limit": 1000}
    for attempt in range(5):
        try:
            r = session.get(BASE_URL, params=params, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == 4:
                raise RuntimeError(f"拉取 {symbol} K线失败（已重试 5 次），未写缓存: {e!r}") from e
            time.sleep(2 ** attempt)


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
