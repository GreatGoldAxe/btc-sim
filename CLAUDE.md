# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

学习用的币安 **纸面交易** 系统（不接真实资金、不需要 API Key）。两个子系统共用一套记账：

- `hft/` —— 实时纸面交易器：订阅币安公开 WebSocket，逐笔跑动量策略。
- `backtest/` —— 1m K 线回测：同一套动量思路搬到 K 线上，用历史数据验证。
- `docs/` —— 网站（GitHub Pages 从 main 分支的 `docs/` 发布）：浏览器里跑回测、保本计算、回放那次 90 分钟实盘，中英双语。

`FINDINGS.md` 是实验结论（手续费摩擦吃掉约 90% 亏损、动量方向 edge≈0、VIP0 下 maker 与 taker 同为 0.1% 所以「改挂限价单降费」不成立）。改策略或手续费逻辑前先读它，避免重走已被否定的方向。

## 环境与命令

Python 3.14（至少 3.11，`bot.py` 用了 `asyncio.timeout`）。没有测试套件、lint 配置或构建步骤。

```bash
pip install -r hft/requirements.txt       # websockets
pip install -r backtest/requirements.txt  # requests

# 实时纸面交易（产物写到当前目录，所以在 hft/ 里运行，见「注意事项」）
cd hft && python bot.py --minutes 3   # 到点自动停，打印总结并写 summary.txt
cd hft && python btc_price_stream.py  # 独立的 BTC 逐笔采集器 -> btc_usdt_ticks.csv

# 回测 —— 可以在任意目录运行
python backtest/run_backtest.py --all --days 7   # 冒烟测试：BTC + DOGE 各 7 天
python backtest/run_backtest.py --all --days 90  # 完整回测
python backtest/run_backtest.py --symbol DOGEUSDT --days 90 --force  # 忽略缓存重新拉数据

# 网站 —— 纯静态，没有构建步骤
python -m http.server 8000 --directory docs        # 本地预览
python tools/build_site_data.py --end 2026-10-10    # 重建 docs/data/ 内置数据（窗口截至该日 UTC 零点）
```

## 架构

**`hft/`：事件驱动的异步流水线**
`MarketData.events()`（market.py）通过一个合并流连接同时收 `@trade` 和 `@bookTicker`，并实时更新 `best_bid` / `best_ask` / `last_price`，断线指数退避重连 → `bot.py` 的主循环把 trade 分发给 `Strategy.on_trade`，book 分发给 `Strategy.on_book`（book 推送频率高，也充当超时平仓检查的心跳）→ `Strategy` 调 `Account.buy/sell`。
- **信号用 `last_price`，成交用盘口**：买按卖一价（ask），卖按买一价（bid）。
- 策略参数是 `hft/strategy.py` 顶部的模块常量；交易对是 `hft/bot.py` 里的 `SYMBOL`（目前是 `dogeusdt`）。
- 每笔成交经 `Account(on_fill=...)` 回调立即写入 trades.csv，包括平仓原因 `reason` 列。

**`hft/account.py` 是两边共用的记账核心。** 同一时间只允许一笔多头仓位（有仓位时 `buy` 返回 `None`），手续费按双边收，`sell` 返回的 `pnl` 已经扣掉开仓费和平仓费。改这里会同时影响实盘和回测的口径。

**`backtest/`：纯函数策略 + 逐根回放引擎**
- `strategy.py` 只有两个纯函数 `entry_signal` / `exit_signal`，参数放在 `DEFAULT_PARAMS` 字典里（「秒」换算成「K 线根数」）。换策略或扫参数就改这里。
- `engine.run` 的防前视约定：**在第 i 根收盘时决策，在第 i+1 根开盘价成交**。所以在第 i 根收盘时已持有 `i - entry_idx + 1` 根，`hold_bars=1` 对应实盘的 60 秒超时。
- 和实盘的已知差异（是建模选择，不是 bug）：回测按开盘价成交，没有买卖价差；平仓判断只看收盘价，不看 high/low，所以根内触及止盈/止损不会被识别；动量窗口最短只能是 1 根（60 秒收盘到收盘），实盘是 30 秒。
- `engine.py` 把仓库根目录加进 `sys.path`，再 `from hft.account import Account`（`hft` 按命名空间包导入，没有 `__init__.py`）。
- 两个模块都叫 `strategy`：`backtest/` 里的 `import strategy` 能拿到 `backtest/strategy.py`，是因为脚本所在目录排在 `sys.path` 前面。别在仓库根目录新建 `strategy.py`。
- 回测初始资金是 100,000 USDT（每笔 100），这样手续费不会中途耗尽本金，能跑出完整曲线。夏普按 UTC 日收益年化。

**`docs/`：静态网站（原生 ES module，无依赖、无后端）**
- `js/engine.js` 是 `hft/account.py` + `backtest/strategy.py` + `backtest/engine.py` 的逐行移植，结果必须和 Python 逐位一致。**改 Python 回测口径时要同步改这里**，并用同一份数据核对两边的笔数、realized_pnl、total_fees、期末权益。`tools/build_site_data.py` 会顺带写出 `backtest/data/{SYMBOL}_1m_site.csv`，方便 Python 端用同一份数据跑。
- 网页的手续费是参数（`fee_rate`），Python 端固定读 `hft/account.py` 的 `FEE_RATE`。「扣费前」曲线 = 含费权益 + 累计手续费（信号与手续费无关，成交序列不变）。
- `docs/data/*.json`：价格按最小价位转成整数再差分存储，网页端用「整数 / 10^decimals」还原，和 Python `float("0.09541")` 是同一个浮点数。`live_run.json` 是 `results/trades.csv` 的逐笔成交 + 同时段 DOGE 1s K 线。
- 回放的平仓原因是推断的（trades.csv 是旧格式、没有 reason 列）：持仓 ≥58 秒算超时，其余按价差方向，与 FINDINGS.md 的口径一致，推断结果 48/18/2 与 summary.txt 吻合。
- 「从币安下载最新」直接在浏览器里请求 `data-api.binance.vision`（它返回 `Access-Control-Allow-Origin: *`）。ETH/SOL 没有内置数据，只能现拉。
- 文案在 `js/i18n.js`（en / zh），带 `data-i18n` 的元素切换语言时自动替换；颜色全部是 `css/style.css` 里的 token，深色模式单独取值。

## 注意事项

- **数据缓存**：文件是 `backtest/data/{SYMBOL}_1m_{days}d.csv`，内容是截至最后一根已收盘 K 线的精确 `days` 天窗口，`--force` 会重新拉。下载失败会直接报错，不会写残缺缓存。不带天数的旧文件 `{SYMBOL}_1m.csv` 已不再被读取。
- 拉 K 线用的是 `data-api.binance.vision`（`api.binance.com` 在部分网络下被屏蔽）。
- 运行产物（`*.csv`、`summary.txt`）已被 gitignore，并写到**当前工作目录**。`bot.py` 在任何目录都能跑（脚本所在目录会自动进 `sys.path`），但**不要在 `results/` 里运行**：`results/trades.csv` 和 `results/summary.txt` 是 FINDINGS.md 的原始依据，在 .gitignore 里单独放行、随仓库发布，运行会覆盖它们。
- **Windows cp950 编码**：每个入口都在 `argparse` 和第一次 print 中文之前调用 `sys.stdout.reconfigure(encoding="utf-8")`。新脚本也要这么做。
- 在自动化 shell 里，SIGINT/Ctrl+C 往往送不到 Python 子进程（`finally` 里的总结就不会打印）。所以运行 `bot.py` 时用 `--minutes`，不要靠中断停止。
