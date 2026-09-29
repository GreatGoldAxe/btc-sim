"""绩效指标计算。"""

import math
from collections import Counter, OrderedDict


def _daily_equities(equity_curve):
    """把 (ts_ms, equity) 按 UTC 日聚合，取每日最后一笔权益。"""
    daily = OrderedDict()
    for ts, eq in equity_curve:
        day = ts // (24 * 3600 * 1000)      # 毫秒 -> UTC 天
        daily[day] = eq                      # 后写覆盖，保留每日最后一笔
    return list(daily.values())


def compute_metrics(acct, equity_curve, initial_cash):
    closed = acct.closed_trades
    n = len(closed)
    wins = sum(1 for t in closed if t["pnl"] > 0)
    losses = sum(1 for t in closed if t["pnl"] < 0)
    gross_profit = sum(t["pnl"] for t in closed if t["pnl"] > 0)
    gross_loss = sum(t["pnl"] for t in closed if t["pnl"] < 0)

    final_equity = equity_curve[-1][1] if equity_curve else initial_cash
    total_return = (final_equity - initial_cash) / initial_cash

    # 最大回撤
    peak = initial_cash
    max_dd = 0.0
    for _, eq in equity_curve:
        peak = max(peak, eq)
        dd = (peak - eq) / peak if peak > 0 else 0.0
        max_dd = max(max_dd, dd)

    # 夏普：按日收益率年化（比 1m 逐根更稳定、更有意义）
    daily = _daily_equities(equity_curve)
    sharpe = 0.0
    if len(daily) > 1:
        rets = [daily[k + 1] / daily[k] - 1 for k in range(len(daily) - 1)]
        mean_r = sum(rets) / len(rets)
        var = sum((r - mean_r) ** 2 for r in rets) / (len(rets) - 1)
        std_r = math.sqrt(var)
        if std_r > 0:
            sharpe = mean_r / std_r * math.sqrt(365)

    reasons = dict(Counter(t["reason"] for t in closed))

    return {
        "total_return": total_return,
        "round_trips": n,
        "win_rate": wins / n if n else 0.0,
        "wins": wins,
        "losses": losses,
        "profit_factor": gross_profit / abs(gross_loss) if gross_loss != 0 else float("inf"),
        "max_drawdown": max_dd,
        "sharpe": sharpe,
        "total_fees": acct.total_fees,
        "realized_pnl": acct.realized_pnl,
        "fee_share_of_loss": acct.total_fees / abs(acct.realized_pnl) if acct.realized_pnl < 0 else 0.0,
        "reasons": reasons,
        "avg_win": gross_profit / wins if wins else 0.0,
        "avg_loss": gross_loss / losses if losses else 0.0,
    }
