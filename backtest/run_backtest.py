"""回测入口：拉数据（或读缓存），跑回测，打印指标。

依赖: requests（拉数据用）

用法:
    python run_backtest.py --symbol BTCUSDT --days 90
    python run_backtest.py --all            # BTC + DOGE 一起跑
    python run_backtest.py --all --force    # 强制重新拉数据
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fetch_data
import engine
import metrics
import strategy

INITIAL_CASH = 100_000.0   # 初始资金，够大以免中途被手续费耗尽，便于观察完整曲线


def run_one(symbol, days, force):
    print(f"\n{'=' * 60}\n{symbol} 回测（{days} 天 1m K线）\n{'=' * 60}")
    csv_path = fetch_data.fetch_klines(symbol, days, force=force)
    bars = engine.load_bars(csv_path)
    print(f"[data] 加载 {len(bars)} 根 K线")
    acct, eq = engine.run(bars, strategy.DEFAULT_PARAMS, initial_cash=INITIAL_CASH)
    m = metrics.compute_metrics(acct, eq, INITIAL_CASH)
    _print_metrics(symbol, m)


def _print_metrics(symbol, m):
    print(f"  总收益:      {m['total_return'] * 100:+.2f}%")
    print(f"  完整来回:    {m['round_trips']}")
    print(f"  胜率:        {m['win_rate'] * 100:.1f}%  ({m['wins']}胜 / {m['losses']}负)")
    print(f"  盈亏比 PF:   {m['profit_factor']:.2f}")
    print(f"  最大回撤:    {m['max_drawdown'] * 100:.2f}%")
    print(f"  夏普(年化):  {m['sharpe']:.2f}")
    print(f"  总盈亏:      {m['realized_pnl']:+.2f} USDT")
    print(f"  总手续费:    {m['total_fees']:,.2f} USDT")
    if m["realized_pnl"] < 0:
        print(f"  手续费/亏损: {m['fee_share_of_loss'] * 100:.0f}%")
    print(f"  平仓原因:    {m['reasons']}")
    print(f"  均赢/均亏:   {m['avg_win']:+.3f} / {m['avg_loss']:+.3f} USDT")


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="K 线回测")
    parser.add_argument("--symbol", default=None, help="如 BTCUSDT / DOGEUSDT")
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--all", action="store_true", help="BTC + DOGE 一起跑")
    parser.add_argument("--force", action="store_true", help="强制重新拉数据")
    args = parser.parse_args()

    symbols = ["BTCUSDT", "DOGEUSDT"] if args.all else [args.symbol or "BTCUSDT"]
    for s in symbols:
        run_one(s, args.days, args.force)
