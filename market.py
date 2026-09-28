"""行情模块：订阅币安公开 WebSocket，提供逐笔成交 + 最优买卖价。

对外用法：
    market = MarketData()
    async for kind, data in market.events():
        if kind == "trade": ...   # data 含 p(价)/q(量)/T(时间)/m(方向)
        elif kind == "book": ...  # data 含 b(买一价)/a(卖一价)

同时 market.best_bid / best_ask / last_price 会被实时更新。
断线自动重连，对上层透明。
"""

import asyncio
import json

import websockets


class MarketData:
    def __init__(self, symbol="btcusdt"):
        self.symbol = symbol.lower()
        # 合并流：一个连接同时收两路数据，比开两个连接更省事
        self.url = (
            "wss://stream.binance.com:9443/stream"
            f"?streams={self.symbol}@trade/{self.symbol}@bookTicker"
        )
        self.best_bid = None    # 买一价（卖出时的成交价）
        self.best_ask = None    # 卖一价（买入时的成交价）
        self.last_price = None  # 最近一笔成交价

    async def events(self):
        """异步迭代器：逐条产出 ("trade", data) / ("book", data)，自动重连。"""
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(
                    self.url, ping_interval=20, ping_timeout=20
                ) as ws:
                    backoff = 1.0
                    async for raw in ws:
                        msg = json.loads(raw)
                        stream = msg.get("stream", "")
                        data = msg.get("data", msg)
                        if stream.endswith("@trade"):
                            self._on_trade(data)
                            yield ("trade", data)
                        elif stream.endswith("@bookTicker"):
                            self._on_book(data)
                            yield ("book", data)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                print(f"[market] 连接异常 {exc!r}，{backoff:.1f}s 后重连", flush=True)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    def _on_trade(self, d):
        self.last_price = float(d["p"])

    def _on_book(self, d):
        self.best_bid = float(d["b"])
        self.best_ask = float(d["a"])
