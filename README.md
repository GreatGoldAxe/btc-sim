# btc-sim

A paper trading system and a 1-minute backtester for Binance spot. I built them to test whether a short-horizon momentum strategy can make money after trading fees.

Short answer: in this setup, no. Almost all of the loss is fees. The price moves themselves net out to roughly zero.

## Motivation

I came across a viral post claiming that an AI trading bot turned $68 into $750K. I wanted to check for myself whether this kind of high-frequency strategy can work.

## Hypothesis

A simple momentum strategy that buys after a short price rise and exits within about a minute can stay profitable after paying Binance spot fees (0.1% per side).

## Experiment

**Live paper trader (`hft/`)**
- **Market data**: Binance public WebSocket, trades and best bid/ask on one combined stream, with automatic reconnect. No API key needed.
- **Simulated account**: 1,000 USDT starting cash, 100 USDT per trade, one position at a time, 0.1% fee on both buy and sell. Buys fill at the best ask and sells at the best bid.
- **Strategy**:
  - Entry: buy when the last trade price has risen more than 0.01% within 30 seconds.
  - Exit at whichever comes first: +0.3% take profit, −0.15% stop loss, or 60 seconds.
- **Output**: every fill is written to `trades.csv`, and a summary is written to `summary.txt` at the end.

**Backtest (`backtest/`)**
- **Data**: 1-minute klines from Binance's public REST API.
- **Strategy**: the same logic in bars. Momentum over 1 bar, same 0.01% threshold and same +0.3% / −0.15% exits, maximum hold of 1 bar.
- **No look-ahead**: decisions are made at the close of bar *i* and filled at the open of bar *i+1*.
- **Shared accounting**: uses the same account code as the live trader, so fees and P&L are computed identically.

**How the parameters got here.** The first version (5 s window, +0.05% threshold, +0.1% take profit) almost never traded on BTC. Its take profit was also smaller than the 0.2% round-trip fee, so every winning trade would still lose money. After widening the parameters, BTC trades all ended by timeout. I then switched to DOGE, the only coin whose 1-minute moves regularly reached the exit levels (see the tables below). The records of these two earlier runs were not kept.

## Findings

Full analysis: [FINDINGS.md](FINDINGS.md). Raw data for the live run: [results/](results/).

### Volatility: weekend vs weekday (BTC, 60 s window)

| Sample | Median move | Max move |
|---|---|---|
| Weekend (240 s sample, 2,642 trades) | 0.0069% | 0.0235% |
| Weekday (180 s sample) | 0.025% | 0.179% |

### Volatility by coin (weekday, 60 s window, 180 s sample)

| Symbol | Median move | Max move | Hits −0.15% stop | Hits +0.3% target |
|---|---|---|---|---|
| BTCUSDT | 0.025% | 0.179% | 1.7% | 0.0% |
| ETHUSDT | 0.023% | 0.183% | 1.9% | 0.0% |
| SOLUSDT | 0.049% | 0.230% | 13.8% | 0.0% |
| DOGEUSDT | 0.083% | 0.466% | 44.8% | 27.7% |

These two tables come from samples only 3–4 minutes long, and the raw data was not kept, so they cannot be re-checked. They only explain why I moved from BTC to DOGE and are not evidence for the conclusion.

### Live paper trading: DOGEUSDT, 90 minutes

| Metric | Value |
|---|---|
| Round trips | 68 |
| Win rate | 5 / 68 = 7.4% |
| Net P&L | −15.19 USDT (−1.52% of capital) |
| Fees on the 68 round trips | 13.60 USDT (89.5% of the loss) |
| P&L before fees | −1.59 USDT |
| Final equity | 984.66 USDT |

| Exit reason | Count | Share | Avg P&L per trade (after fees) |
|---|---|---|---|
| Timeout | 48 | 70.6% | −0.182 USDT |
| Stop loss | 18 | 26.5% | −0.372 USDT |
| Take profit | 2 | 2.9% | +0.107 USDT |

Only 2 of the 5 winning trades actually reached the take-profit level. The other 3 were timeouts where the price had moved just enough to cover fees.

### Backtest: 90 days of 1-minute bars (129,600 bars, ending 2026-09-29)

Starting capital is 100,000 USDT with 100 USDT per trade.

| Symbol | Round trips | Win rate | Net P&L | Fees | Net P&L + fees | Return |
|---|---|---|---|---|---|---|
| BTCUSDT | 31,603 | 0.5% | −6,273.45 USDT | 6,320.75 USDT | ≈ +47 USDT | −6.27% |
| DOGEUSDT | 39,836 | 1.8% | −7,941.91 USDT | 7,967.23 USDT | ≈ +25 USDT | −7.94% |

Exits:
- BTC: 31,320 timeouts, 238 stop losses, 45 take profits.
- DOGE: 38,303 timeouts, 1,295 stop losses, 238 take profits.

Both symbols lost about 0.20 USDT per 100 USDT trade, which equals the round-trip fee.

### Expected value per trade

The table below uses the exit mix and per-trade averages from the live run:

```
EV = 0.706 × (−0.182) + 0.265 × (−0.372) + 0.029 × (+0.107)
   ≈ −0.224 USDT per 100 USDT trade (−0.22%)
```

The actual result is −15.19 / 68 = −0.223. The small gap comes from rounding the averages. It breaks down as:

| Component | Per trade |
|---|---|
| Fees (13.60 / 68) | −0.200 USDT |
| Price movement (−1.59 / 68) | −0.023 USDT |

For the exits to break even, a take profit (+0.107) has to offset a stop loss (−0.372). That needs a take-profit share of 0.372 / (0.107 + 0.372) ≈ 78% among trades that hit either level. The observed share was 2 / 20 = 10%.

## Conclusion & Limitations

**Conclusion.** Both the 90-minute live run and the 90-day backtest show the same thing: the strategy has close to zero edge in price direction, and the 0.2% round-trip fee turns that into a steady loss. Switching to limit orders would not help. Binance spot's base tier (VIP0) charges 0.10% for both maker and taker orders, and a paper simulation would also overstate how often limit orders get filled.

**Limitations.**
- **Small live sample**: one coin, one day, 90 minutes, 68 round trips. That is not enough for statistical conclusions.
- **Overfitting risk**: parameters and the traded symbol were changed several times based on short samples, which makes it easy to fit noise.
- **Optimistic paper fills**: the simulation assumes every order fills instantly at the best bid/ask. Real results would likely be worse.
- **Backtest simplifications**:
  - Fills at the bar open, with no spread or slippage.
  - Exits are checked only at bar close, so moves inside a bar are missed.
  - The shortest momentum window is 1 bar (60 s), while the live trader uses 30 s.
- **One test period**: the backtest covers a single 90-day window.
- **Unverifiable tables**: the volatility tables above cannot be reproduced.

## How to Run

Requires Python 3.11+.

```bash
pip install -r hft/requirements.txt -r backtest/requirements.txt

# Live paper trading: stops after 3 minutes and prints a summary.
# Writes trades.csv and summary.txt to the current directory.
cd hft
python bot.py --minutes 3
cd ..

# Backtest BTC + DOGE (the first run downloads 1-minute klines into backtest/data/)
python backtest/run_backtest.py --all --days 7    # quick check
python backtest/run_backtest.py --all --days 90   # full run
```

Backtest numbers will differ from the table above if you run it on a different date, because the 90-day window ends at the time of the run.

## About

This is a learning project, built with the help of [Claude Code](https://claude.com/claude-code).

**Disclaimer:** paper trading only. No real money or exchange account is involved. Nothing here is investment advice.

## Contact

greatgoldaxe.dev@gmail.com, or open an issue in this repository.

## License

[MIT](LICENSE)
