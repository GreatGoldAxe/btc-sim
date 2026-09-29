# btc-sim

币安现货的**纸面交易器 + K 线回测**，一个学习项目。它用一次实盘纸面测试和一次 90 天回测回答了同一个问题：

> 在 0.1% 手续费下，秒级到分钟级的动量策略能不能赚钱？
> **不能。亏损几乎全部来自手续费，价格方向上的盈亏接近零。**

*A learning project: a live paper trader and a 1-minute backtester for Binance spot. Both show that a short-horizon momentum strategy under 0.1% taker fees loses almost exactly its fees. The price edge is ≈ 0.*

> ⚠️ 不接真实资金，不需要 API Key，只用币安公开行情。**不构成任何投资建议。**

---

## 结果

### 实盘纸面测试（DOGEUSDT，90 分钟，68 笔来回）

| 指标 | 值 |
|---|---|
| 总盈亏 | −15.19 USDT（本金 1000，每笔 100） |
| 其中手续费 | 13.60 USDT，**占亏损 89.5%** |
| 不计手续费的价差盈亏 | −1.59 USDT |
| 胜率 | 5/68 = 7.4%（真正触及止盈的只有 2 笔） |
| 平仓原因 | 超时 48 · 止损 18 · 止盈 2 |

完整分析、推导过程和局限性见 [FINDINGS.md](FINDINGS.md)。

### 回测（1m K 线，90 天，截至 2026-09-29）

| 标的 | 来回次数 | 总盈亏 | 手续费 | 不计手续费的价差盈亏 | 每笔平均 |
|---|---|---|---|---|---|
| BTCUSDT | 31,603 | −6,273 USDT | 6,321 USDT | ≈ +47 USDT | −0.20% |
| DOGEUSDT | 39,836 | −7,942 USDT | 7,967 USDT | ≈ +25 USDT | −0.20% |

每笔 100 USDT，平均每笔亏 0.20%，正好是买卖双边各 0.1% 的手续费。三万多笔交易下来，价格方向贡献的盈亏几乎为零。回测结果和实盘测试的结论一致。

---

## 项目结构

```
hft/                  实时纸面交易
  market.py           币安 WebSocket 合并流（逐笔成交 + 最优买卖价），断线指数退避重连
  strategy.py         动量策略：30s 涨幅 > 0.01% 入场；止盈 0.3% / 止损 0.15% / 60s 超时
  account.py          记账：现金、持仓、双边 0.1% 手续费、已实现盈亏（回测也用它）
  bot.py              主程序，成交逐笔写 trades.csv，结束时写 summary.txt
  btc_price_stream.py 独立的 BTC 逐笔成交采集器

backtest/             K 线回测
  fetch_data.py       从币安公开 REST 拉 1m K 线并缓存
  strategy.py         同一套动量逻辑的纯函数版本（入场 / 离场信号）
  engine.py           逐根回放引擎
  metrics.py          收益、胜率、盈亏比、最大回撤、夏普、手续费占比
  run_backtest.py     入口

FINDINGS.md           实验记录与分析
```

## 快速开始

需要 Python 3.11 及以上。

```bash
pip install -r hft/requirements.txt -r backtest/requirements.txt

# 实时纸面交易：跑 3 分钟后自动停止并打印总结
cd hft && python bot.py --minutes 3

# 回测：BTC + DOGE，7 天冒烟测试 / 90 天完整回测（首次运行会下载数据）
python backtest/run_backtest.py --all --days 7
python backtest/run_backtest.py --all --days 90
```

## 设计要点

- **撮合规则**：用最新成交价判断信号，用盘口价成交：买按卖一价（ask），卖按买一价（bid）。
- **实盘与回测共用记账**：`backtest/engine.py` 直接调用 `hft/account.py`，两边手续费和盈亏的算法完全一样。
- **防前视偏差**：回测在第 i 根 K 线收盘时决策，在第 i+1 根开盘价成交，决策时只用得到当时已有的数据。
- **数据缓存**：K 线按「交易对 + 天数」缓存，窗口截至最后一根已收盘的 K 线。下载失败会直接报错，不会写残缺数据。

## 局限性

- 实盘测试只有 90 分钟、68 笔、单一标的，不足以下任何统计结论。
- 回测按开盘价成交，**没有买卖价差和滑点**，所以回测结果偏乐观，而它已经是亏损的。
- 回测只在 K 线收盘时判断止盈止损，K 线内部触及的不会被识别；动量窗口最短是 1 根（60s），实盘是 30s。
- 纸面撮合假设 100% 成交。

## 开发记录

初版代码由 AI 生成。之后又做了一轮完整审查，修复了 9 个问题，其中 3 个会影响回测结论的可信度：
- 回测持仓时长多算了一根 K 线；
- `--days` 参数被缓存静默忽略，「90 天」BTC 回测实际只用了 7.6 天；
- FINDINGS 里有些数字对不上总数。

每个修复都是单独的提交，可以在 [提交历史](../../commits/main) 里逐个查看。

## License

[MIT](LICENSE)
