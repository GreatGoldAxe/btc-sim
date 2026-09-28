"""策略模块：极简动量突破策略（纸面，学习用）。

入场：最近 MOMENTUM_WINDOW 秒内，成交价上涨超过 MOMENTUM_THRESHOLD，且无持仓，
      则以“卖一价”买入 BUY_NOTIONAL 美元。
离场（任一先到）：
      1) 现价 >= 开仓价 * (1 + TAKE_PROFIT)   -> 止盈
      2) 现价 <= 开仓价 * (1 - STOP_LOSS)     -> 止损
      3) 持有时间 >= MAX_HOLD_SECONDS          -> 超时平仓
      平仓按“买一价”成交。

价格判断用“最近成交价”，实际成交用盘口最优价（买 ask / 卖 bid），
这是纸面撮合里常见且够用的简化。
"""

import time
from collections import deque
from datetime import datetime, timezone

# ------------------------- 可调参数（改这里即可）---------------------------
BUY_NOTIONAL = 100.0         # 每次买入的 USDT 金额
MOMENTUM_WINDOW = 30.0       # 动量回看窗口（秒）—— 5 秒太短，低波动时段采集不到价格漂移
MOMENTUM_THRESHOLD = 0.0001  # 窗口内涨幅超过 0.01% 触发买入（30s 窗口约 P85，能规律触发）
TAKE_PROFIT = 0.003          # 止盈：+0.3%（必须 > 双边手续费 0.2% 才有净盈利）
STOP_LOSS = 0.0015           # 止损：-0.15%
MAX_HOLD_SECONDS = 60.0      # 最长持有秒数，超时强制平仓
# --------------------------------------------------------------------------


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _fmt_price(p):
    """按价格量级自适应小数位，避免低价币（DOGE≈0.097）被 :.2f 舍成 0.10。"""
    if p >= 1000:
        return f"{p:,.2f}"      # BTC 级
    if p >= 1:
        return f"{p:,.4f}"      # ETH 级
    return f"{p:.6f}"           # DOGE / SOL 级


def _fmt_qty(q):
    if q >= 1:
        return f"{q:,.4f}"
    return f"{q:.8f}"


class Strategy:
    def __init__(self, market, account):
        self.market = market
        self.account = account
        self.recent = deque()      # [(time.monotonic()秒, 成交价), ...] 算动量用
        self.entry_time = None     # 开仓时的 time.monotonic()
        self.entry_price = None    # 开仓价（= 当时卖一价）

    def on_trade(self, price):
        now = time.monotonic()
        self.recent.append((now, price))
        # 丢弃窗口之外的数据，保证窗口严格为 MOMENTUM_WINDOW 秒
        while self.recent and now - self.recent[0][0] > MOMENTUM_WINDOW:
            self.recent.popleft()
        self._update(now)

    def on_book(self):
        # bookTicker 频率很高，顺带当“心跳”用，触发超时平仓检查
        self._update(time.monotonic())

    def _update(self, now):
        ref = self.market.last_price
        if ref is None:
            return
        if self.account.has_position:
            self._maybe_exit(ref, now)
        else:
            self._maybe_enter(ref)

    def _maybe_enter(self, ref):
        if len(self.recent) < 2:
            return
        base = self.recent[0][1]           # 窗口起点价
        if base <= 0:
            return
        change = (ref - base) / base
        if change <= MOMENTUM_THRESHOLD:
            return
        ask = self.market.best_ask
        if ask is None:                    # 盘口还没数据，等下一笔
            return
        fill = self.account.buy(ask, BUY_NOTIONAL, _now_iso())
        if fill is None:
            return
        self.entry_time = time.monotonic()
        self.entry_price = fill["price"]
        print(f"[BUY ] {fill['time_utc']}  price={_fmt_price(ask)}  "
              f"qty={_fmt_qty(fill['qty'])}  notional={BUY_NOTIONAL:,.2f}  "
              f"fee={fill['fee']:,.4f}", flush=True)

    def _maybe_exit(self, ref, now):
        entry = self.entry_price
        reason = None
        if ref >= entry * (1 + TAKE_PROFIT):
            reason = "take_profit"
        elif ref <= entry * (1 - STOP_LOSS):
            reason = "stop_loss"
        elif now - self.entry_time >= MAX_HOLD_SECONDS:
            reason = "timeout"
        if reason is None:
            return
        bid = self.market.best_bid
        if bid is None:
            bid = ref
        fill = self.account.sell(bid, _now_iso(), reason=reason)
        if fill is None:
            return
        print(f"[SELL] {fill['time_utc']}  price={_fmt_price(bid)}  "
              f"qty={_fmt_qty(fill['qty'])}  pnl={fill['pnl']:+,.4f}  "
              f"({reason})", flush=True)
        self.entry_time = None
        self.entry_price = None
