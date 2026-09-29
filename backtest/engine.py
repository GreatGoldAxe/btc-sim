"""逐根 K 线回放引擎。

核心约定（防前视偏差）：
    - 决策在「第 i 根收盘」时做，只看 i 及之前的数据；
    - 成交在「第 i+1 根开盘」价，而不是信号那根的价格。
这样就不会偷偷用到未来信息。

复用 hft/account.py 的记账（现金/持仓/手续费/盈亏），保证和实盘口径一致。
"""

import csv
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hft.account import Account
import strategy


def load_bars(csv_path):
    """读 K 线 CSV -> list[dict]，按时间升序。"""
    bars = []
    with open(csv_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            bars.append({
                "ts": int(row["timestamp_ms"]),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
            })
    return bars


def _ts_str(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def run(bars, params, initial_cash=100_000.0):
    """回放所有 K 线，返回 (account, equity_curve)。

    equity_curve: list[(ts_ms, 权益)]，每根 K 线收盘时的权益（按收盘价计价）。
    """
    acct = Account(initial_cash=initial_cash)
    position = None    # {"entry_price", "entry_idx", "qty"}
    pending = None     # "buy" 或 "sell:<reason>"
    equity_curve = []

    for i, bar in enumerate(bars):
        open_p = bar["open"]

        # 1) 执行上一根收盘时挂起的动作（本根开盘价成交）
        if pending == "buy":
            fill = acct.buy(open_p, params["notional"], _ts_str(bar["ts"]))
            if fill is not None:
                position = {"entry_price": fill["price"], "entry_idx": i, "qty": fill["qty"]}
            pending = None
        elif pending is not None and pending.startswith("sell:"):
            reason = pending.split(":", 1)[1]
            acct.sell(open_p, _ts_str(bar["ts"]), reason=reason)
            position = None
            pending = None

        # 2) 本根收盘做决策（只用 i 及之前的数据）
        if position is None:
            if strategy.entry_signal(bars, i, params):
                pending = "buy"
        else:
            reason = strategy.exit_signal(bar, position["entry_price"],
                                          position["entry_idx"], i, params)
            if reason:
                pending = f"sell:{reason}"

        equity_curve.append((bar["ts"], acct.equity(bar["close"])))

    return acct, equity_curve
