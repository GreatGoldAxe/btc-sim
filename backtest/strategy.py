"""K 线版动量策略（纯决策函数，无 I/O）。

和 hft/strategy.py 是同一套动量思路，只是把「秒」换成「K 线根数」：
    - 30 秒动量窗口  -> momentum_bars 根（默认 1）
    - 60 秒持仓上限  -> hold_bars 根（默认 1）
止盈 / 止损 / 阈值百分比不变。

这里只提供两个纯函数，供回测引擎调用，方便之后换策略或扫参数。
"""

DEFAULT_PARAMS = {
    "momentum_bars": 1,          # 动量回看根数
    "momentum_threshold": 0.0001,  # 涨超过 0.01% 触发买入
    "take_profit": 0.003,        # 止盈 +0.3%
    "stop_loss": 0.0015,         # 止损 -0.15%
    "hold_bars": 1,              # 最长持有 1 根 K 线
    "notional": 100.0,           # 每笔金额 USDT
}


def entry_signal(bars, i, params):
    """在第 i 根收盘时判断是否入场（只用 i 及之前的数据，无前视）。"""
    n = params["momentum_bars"]
    if i < n:
        return False
    base = bars[i - n]["close"]
    cur = bars[i]["close"]
    if base <= 0:
        return False
    return (cur - base) / base > params["momentum_threshold"]


def exit_signal(bar, entry_price, entry_idx, i, params):
    """在第 i 根收盘时判断是否平仓，返回原因字符串或 None。"""
    close = bar["close"]
    if close >= entry_price * (1 + params["take_profit"]):
        return "take_profit"
    if close <= entry_price * (1 - params["stop_loss"]):
        return "stop_loss"
    if i - entry_idx >= params["hold_bars"]:
        return "timeout"
    return None
