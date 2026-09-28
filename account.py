"""账户模块：纸面资金、持仓、手续费与盈亏记账（不接真实资金/接口）。

成交规则（配合行情盘口）：
    买入按“卖一价”成交，卖出按“买一价”成交；
    手续费 0.1% 双边（买、卖各收一次）。
"""

INITIAL_CASH = 1000.0     # 初始 USDT
FEE_RATE = 0.001          # 0.1% 每笔


class Account:
    def __init__(self, initial_cash=INITIAL_CASH, fee_rate=FEE_RATE, on_fill=None):
        self.initial_cash = initial_cash
        self.cash = initial_cash
        self.fee_rate = fee_rate
        self.on_fill = on_fill      # 可选回调(fill)，用于把成交即时写入 CSV

        # 持仓状态
        self.position_qty = 0.0     # BTC 数量
        self.entry_price = None     # 开仓价
        self.entry_fee = 0.0        # 开仓手续费（算盈亏用）

        # 统计
        self.total_fees = 0.0
        self.realized_pnl = 0.0
        self.fills = []             # 每笔成交记录
        self.closed_trades = []     # 每次平仓：{"pnl", "reason"}

    @property
    def has_position(self):
        return self.position_qty > 0

    def buy(self, price, notional, time_utc):
        """以 price（卖一价）买入 notional 美元的 BTC；返回成交记录或 None。"""
        if self.has_position:
            return None                     # 简化：同时只持有一笔仓位
        qty = notional / price
        fee = notional * self.fee_rate
        if self.cash < notional + fee:
            return None                     # 现金不足
        self.cash -= notional + fee
        self.position_qty = qty
        self.entry_price = price
        self.entry_fee = fee
        self.total_fees += fee
        fill = {"time_utc": time_utc, "side": "BUY", "price": price,
                "qty": qty, "fee": fee, "pnl": 0.0}
        self._record(fill)
        return fill

    def sell(self, price, time_utc, reason=None):
        """以 price（买一价）卖出全部持仓；返回含盈亏的成交记录或 None。"""
        if not self.has_position:
            return None
        qty = self.position_qty
        notional = price * qty
        fee = notional * self.fee_rate
        # 已实现盈亏 = 价差收益 - 开仓费 - 平仓费
        pnl = (price - self.entry_price) * qty - self.entry_fee - fee

        self.cash += notional - fee
        self.total_fees += fee
        self.realized_pnl += pnl
        self.closed_trades.append({"pnl": pnl, "reason": reason})

        fill = {"time_utc": time_utc, "side": "SELL", "price": price,
                "qty": qty, "fee": fee, "pnl": pnl}
        self._record(fill)

        self.position_qty = 0.0
        self.entry_price = None
        self.entry_fee = 0.0
        return fill

    def equity(self, mark_price=None):
        """权益 = 现金 + 持仓市值。mark_price 缺省用开仓价。"""
        if mark_price is None:
            mark_price = self.entry_price or 0.0
        return self.cash + self.position_qty * mark_price

    def _record(self, fill):
        self.fills.append(fill)
        if self.on_fill is not None:
            self.on_fill(fill)
