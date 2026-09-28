"""主程序：把行情、账户、策略接起来，跑纸面交易。

运行：
    python bot.py                  # 手动 Ctrl+C 停止
    python bot.py --minutes 3      # 3 分钟后自动停止并打印/保存总结
停止：Ctrl+C 或 --minutes 到点，都会打印总结并保存到 summary.txt
"""

import argparse
import asyncio
import csv
import sys
from collections import Counter

from market import MarketData
from account import Account
from strategy import (
    Strategy, BUY_NOTIONAL, MOMENTUM_WINDOW, MOMENTUM_THRESHOLD,
    TAKE_PROFIT, STOP_LOSS, MAX_HOLD_SECONDS,
)

# 交易对（小写）。实测 60s 最大波动：BTC/ETH ~0.18%、SOL 0.23% 都触不到 0.3% 止盈，
# 只有 DOGE ~0.47% 能真正触发止盈/止损。想回 BTC 就改成 "btcusdt"。
SYMBOL = "dogeusdt"

TRADES_CSV = "trades.csv"
TRADES_HEADER = ["time_utc", "side", "price", "qty", "fee", "pnl"]
SUMMARY_TXT = "summary.txt"


def _quiet_ws_noise(loop, context):
    """忽略 websockets 17.x 在连接被重置时的已知无害噪音。

    现象：连接被 RST 重置时，connection_lost 会访问尚未初始化的
    recv_messages，抛 AttributeError 打印 traceback。重连与交易功能
    不受影响，这里只过滤掉这条噪音，其余异常照常交给默认处理器。
    """
    exc = context.get("exception")
    if isinstance(exc, AttributeError) and "recv_messages" in str(exc):
        return
    loop.default_exception_handler(context)


def make_fill_writer(path):
    """返回 (写入函数, 文件句柄)。写入函数每收到一笔成交就立即落盘。"""
    f = open(path, "w", newline="", encoding="utf-8")
    w = csv.DictWriter(f, fieldnames=TRADES_HEADER)
    w.writeheader()

    def write(fill):
        w.writerow({k: fill[k] for k in TRADES_HEADER})
        f.flush()

    return write, f


def print_summary(account, market, summary_path=None):
    """打印交易总结；若给定 summary_path，同时把总结保存到该文件。"""
    closed = account.closed_trades
    n = len(closed)
    wins = sum(1 for t in closed if t["pnl"] > 0)
    win_rate = wins / n * 100 if n else 0.0
    reasons = Counter(t["reason"] for t in closed)
    mark = market.last_price or account.entry_price or 0.0
    equity = account.equity(mark)
    base = market.symbol.upper().replace("USDT", "")

    lines = [
        "\n" + "=" * 46,
        "  交易总结",
        "=" * 46,
        f"完整交易次数（一买一卖）: {n}",
        f"胜率: {wins}/{n} = {win_rate:.1f}%",
        "平仓原因: " + ", ".join(f"{k}={v}" for k, v in sorted(reasons.items())),
        f"总盈亏: {account.realized_pnl:+,.4f} USDT",
        f"手续费合计: {account.total_fees:,.4f} USDT",
        f"期末权益: {equity:,.4f} USDT（初始 {account.initial_cash:,.2f}）",
    ]
    if account.has_position:
        upnl = (mark - account.entry_price) * account.position_qty
        lines.append(f"[未平仓] 持仓 {account.position_qty:.8f} {base}，浮动盈亏 {upnl:+,.4f} USDT")
    lines.append("=" * 46)
    text = "\n".join(lines)
    print(text, flush=True)
    if summary_path:
        with open(summary_path, "w", encoding="utf-8") as f:
            f.write(text + "\n")


async def main(args):
    asyncio.get_running_loop().set_exception_handler(_quiet_ws_noise)
    # 运行时长（秒）；未传 --minutes 时为 None，表示无限运行直到 Ctrl+C
    run_seconds = args.minutes * 60 if args.minutes is not None else None
    market = MarketData(SYMBOL)
    write_fill, trades_file = make_fill_writer(TRADES_CSV)
    account = Account(on_fill=write_fill)
    strategy = Strategy(market, account)

    print(f"[start] {market.symbol.upper()} 纸面交易 · 初始 {account.initial_cash:,.0f} USDT", flush=True)
    print(f"       买入 {BUY_NOTIONAL:,.0f} USDT/次 · 动量 {MOMENTUM_WINDOW:.0f}s内涨>{MOMENTUM_THRESHOLD*100:.2f}% · "
          f"止盈{TAKE_PROFIT*100:.2f}% / 止损{STOP_LOSS*100:.2f}% / 超时{MAX_HOLD_SECONDS:.0f}s", flush=True)
    print(f"       成交写入 {TRADES_CSV}，总结写入 {SUMMARY_TXT}", flush=True)
    if args.minutes is not None:
        print(f"       {args.minutes:g} 分钟后自动停止\n", flush=True)
    else:
        print(f"       （Ctrl+C 停止并打印总结）\n", flush=True)

    try:
        # asyncio.timeout(None) 表示不限时；到点抛 TimeoutError 退出循环
        async with asyncio.timeout(run_seconds):
            async for kind, data in market.events():
                if kind == "trade":
                    strategy.on_trade(float(data["p"]))
                elif kind == "book":
                    strategy.on_book()
    except TimeoutError:
        print(f"\n[stopped] 已运行 {args.minutes:g} 分钟，自动停止。", flush=True)
    except asyncio.CancelledError:
        pass
    finally:
        trades_file.close()
        print_summary(account, market, SUMMARY_TXT)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="纸面交易器：连币安公开行情，跑动量策略，记录纸面成交。"
    )
    parser.add_argument(
        "--minutes", type=float, default=None,
        help="运行 N 分钟后自动停止并打印/保存总结（支持小数，如 2.5；不传则 Ctrl+C 手动停止）",
    )
    args = parser.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        print("[stopped] 已收到 Ctrl+C。", flush=True)
