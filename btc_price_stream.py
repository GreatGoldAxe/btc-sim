"""BTC/USDT 实时行情采集 —— 学习用纸面交易器的第一步。

功能：
    1. 连接币安公开行情 WebSocket（无需 API Key）。
    2. 实时接收 BTCUSDT 逐笔成交（trade）并打印到终端。
    3. 把每一笔成交追加写入 CSV，供后续回放 / 分析。

运行：
    pip install -r requirements.txt
    python btc_price_stream.py

停止：Ctrl+C
"""

import asyncio
import csv
import json
import os
import sys
from datetime import datetime, timezone

import websockets

# --------------------------- 配置 -----------------------------------------
SYMBOL = "btcusdt"              # 交易对（币安流名要求小写）
# 逐笔成交流：每笔成交推一条消息，含价格 p、数量 q、成交时间 T、方向 m
WS_URL = f"wss://stream.binance.com:9443/ws/{SYMBOL}@trade"
CSV_PATH = "btc_usdt_ticks.csv"
CSV_HEADER = ["trade_time_utc", "timestamp_ms", "price", "qty", "is_buyer_maker"]

PRINT_EVERY_N = 1               # 每 N 笔打印一次（1 = 每一笔都打印）
QUEUE_MAXSIZE = 10_000          # 队列上限：写盘慢时给上游施加背压，避免内存暴涨
# --------------------------------------------------------------------------


def format_tick(msg: dict) -> dict:
    """从原始成交消息里挑出我们关心的字段，转成规整的字典。

    币安 @trade 消息关键字段：
        T  —— 成交时间（毫秒时间戳）
        p  —— 成交价（字符串，如 "96853.10"）
        q  —— 成交数量（字符串，BTC）
        m  —— 买方是否为挂单方（maker）。True 表示有人主动卖出（砸盘单）
    """
    return {
        "trade_time_utc": datetime.fromtimestamp(
            msg["T"] / 1000, tz=timezone.utc
        ).isoformat(),
        "timestamp_ms": msg["T"],
        "price": msg["p"],
        "qty": msg["q"],
        "is_buyer_maker": msg["m"],
    }


def display_line(tick: dict) -> str:
    """把一笔成交格式化成终端里的一行。"""
    side = "SELL" if tick["is_buyer_maker"] else "BUY"
    return (
        f"{tick['trade_time_utc']}  "
        f"price={float(tick['price']):>12,.2f}  "
        f"qty={tick['qty']:>10}  {side}"
    )


class TickWriter:
    """把成交追加写入 CSV，带缓冲（批量 flush 减少磁盘抖动）。"""

    def __init__(self, path: str):
        self.path = path
        # 新文件（或空文件）才写表头；追加模式下不能靠 tell() 判断
        write_header = not os.path.exists(path) or os.path.getsize(path) == 0
        # newline="" 避免 Windows 下 csv 写出多余的空行
        self._file = open(path, "a", newline="", encoding="utf-8")
        self._writer = csv.DictWriter(self._file, fieldnames=CSV_HEADER)
        if write_header:
            self._writer.writeheader()

    def write(self, tick: dict) -> None:
        self._writer.writerow(tick)

    def flush(self) -> None:
        self._file.flush()

    def close(self) -> None:
        self._file.close()


async def run_stream(queue: asyncio.Queue) -> None:
    """生产者：维持连接，解析每条消息，打印 + 入队。断线自动重连。"""
    backoff = 1.0              # 重连等待秒数，指数退避
    count = 0
    while True:
        try:
            # ping_interval/ping_timeout 定期发心跳，用于探测死连接
            async with websockets.connect(
                WS_URL, ping_interval=20, ping_timeout=20
            ) as ws:
                print(f"[connected] {WS_URL}", flush=True)
                backoff = 1.0   # 连上后重置退避
                async for raw in ws:
                    tick = format_tick(json.loads(raw))
                    count += 1
                    if count % PRINT_EVERY_N == 0:
                        print(display_line(tick), flush=True)
                    await queue.put(tick)   # 队列满时会阻塞，天然背压
        except asyncio.CancelledError:
            raise                       # 正常取消，向上抛，不要吞掉
        except Exception as exc:
            print(f"[error] {exc!r} — {backoff:.1f}s 后重连", flush=True)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60.0)   # 1→2→4→…→封顶 60s


async def consume_writes(queue: asyncio.Queue, writer: TickWriter) -> None:
    """消费者：从队列批量取数写 CSV（一次只 flush 一次，效率更高）。"""
    while True:
        batch = [await queue.get()]        # 阻塞等第一笔
        while not queue.empty():           # 再把当前积压的一起捞走
            batch.append(queue.get_nowait())
        for tick in batch:
            writer.write(tick)
        writer.flush()


async def async_main() -> None:
    queue = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
    writer = TickWriter(CSV_PATH)
    producer = asyncio.create_task(run_stream(queue))
    consumer = asyncio.create_task(consume_writes(queue, writer))
    print(f"[started] 正在采集 {SYMBOL.upper()} → {CSV_PATH}（Ctrl+C 停止）", flush=True)
    try:
        await asyncio.gather(producer, consumer)   # 二者都永不自行结束
    finally:
        producer.cancel()
        consumer.cancel()
        await asyncio.gather(producer, consumer, return_exceptions=True)
        writer.close()
        print("[stopped] CSV 已关闭。", flush=True)


def main() -> None:
    # Windows 下 Python 默认可能用 GBK 输出，导致中文在 UTF-8 终端里乱码。
    # 这里把 stdout 固定成 UTF-8（现代终端：Windows Terminal / VS Code 均为 UTF-8）。
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        print("\n[stopped] 已收到 Ctrl+C，退出。", flush=True)


if __name__ == "__main__":
    main()
