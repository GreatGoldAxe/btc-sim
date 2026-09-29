# btc-sim

My first coding project: a paper trading bot and a backtester for Binance, built to answer one question —

**Can a simple high-frequency trading bot actually make money after fees?**

Short answer: no. At least not this one. And the reason turned out to be more interesting than I expected.

## Why I made this

I saw a viral post on X claiming a student built a trading bot with AI in 2 days and turned **$68 into $750K**. It had all the usual signs of engagement bait ("comment 'Setup' and I'll DM you"), but it made me curious: *is the idea behind it even possible?*

So instead of asking for the "setup", I decided to build my own version and test it — with fake money only.

## What I built

**1. A live paper trader (`hft/`)**
- Connects to Binance's public price stream (no account or API key needed)
- Starts with 1,000 fake USDT and trades 100 USDT at a time
- Buys at the ask price, sells at the bid price, and pays a 0.1% fee each way — like a real trade would
- Strategy: if the price rises more than 0.01% in 30 seconds, buy. Then sell at +0.3% (take profit), −0.15% (stop loss), or after 60 seconds, whichever comes first
- Logs every trade to `trades.csv` and writes a summary at the end

**2. A backtester (`backtest/`)**
- Replays 90 days of 1-minute price data to test the same idea on a much bigger sample
- Uses the same account code as the live trader, so fees are calculated the same way
- Makes decisions at the close of one bar and fills at the open of the next, so it can't "see the future"

## What happened

### Attempt 1: nothing happened

My first settings (buy if BTC rises 0.05% in 5 seconds) ran for 6 minutes on a Sunday morning and made **zero trades**. I thought it was a bug. It wasn't — BTC just barely moved. In a 4-minute sample, the biggest 60-second move was only about 0.02%.

I also realized my take profit (+0.1%) was smaller than the round-trip fee (0.2%). So even a "winning" trade would lose money. Oops.

### Attempt 2: weekday + a more volatile coin

Weekdays turned out to be much more active than weekends (in my short samples, the biggest 60-second BTC move went from ~0.02% to ~0.18%). But BTC still almost never reached +0.3%. I compared a few coins and only DOGE moved enough to hit my targets, so I switched to DOGE.

*(These volatility samples were only 3–4 minutes long and I didn't save the raw data, so treat them as rough.)*

### Attempt 3: 90 minutes of live paper trading on DOGE

| | |
|---|---|
| Trades | 68 |
| Win rate | 7.4% (5 / 68) |
| Total result | **−15.19 USDT** |
| Fees paid | 13.60 USDT |
| Result before fees | −1.59 USDT |

About **90% of the loss was fees**. Without fees, the strategy was basically break-even — which means the "signal" had no real predictive power. It was like flipping a coin and paying 0.2% every time.

Most trades (71%) just timed out after 60 seconds because the price didn't go anywhere. Only 2 trades actually hit the take-profit.

### Attempt 4: 90-day backtest

To make sure the 90 minutes weren't just bad luck, I ran the same logic over 90 days of 1-minute data:

| Coin | Trades | Result | Fees | Result before fees |
|---|---|---|---|---|
| BTC | 31,603 | −6.27% | 6,320.75 USDT | ≈ +47 USDT |
| DOGE | 39,836 | −7.94% | 7,967.23 USDT | ≈ +25 USDT |

Same story, much bigger sample: before fees, almost exactly zero. After fees, a steady loss of about 0.2% per trade.

## The math that explains it

Using the exit mix from the live run:

```
Expected value per trade
= 71% × (−0.182)  [timeouts]
+ 26% × (−0.372)  [stop losses]
+  3% × (+0.107)  [take profits]
≈ −0.22 USDT per 100 USDT trade
```

The actual result was −15.19 / 68 = **−0.223** per trade. The math matched reality almost exactly, which honestly was the most satisfying part of this project.

To break even, the bot would need to hit its take-profit about 78% of the time (among trades that hit either target). It hit it 10% of the time.

## What I learned

- **Fees matter more than anything.** If typical price moves are smaller than your trading costs, no clever entry rule will save you.
- **Measure before you guess.** When the bot didn't trade, measuring real volatility told me more than tweaking settings would have.
- **Expected value is a great sanity check.** A few lines of math predicted the result before I even finished the run.
- **Be careful with tuning.** I changed settings several times based on short samples. That's a good way to fool yourself (overfitting).
- **Viral "I made $750K" posts deserve skepticism.** Real edges in trading are small, hard to find, and usually competed away quickly.

## Limitations

- The live test was one coin, one day, 90 minutes — not enough for strong conclusions.
- Paper trading assumes every order fills instantly at the best price. Real trading would probably be worse.
- The backtest uses 1-minute bars, so it can't see price moves inside each minute, and it ignores spread and slippage.
- The backtest covers only one 90-day period.
- Binance's base spot fee is 0.1% for both maker and taker orders (as far as I could check), so switching to limit orders wouldn't fix this.

## What's next

Part 2: instead of reacting to 30-second moves, I want to try **machine learning on longer timeframes** (like predicting the next hour) and see if a model can find an edge that survives fees. My guess is it won't — but I want to find out properly.

## How to run it

Requires Python 3.11+.

```bash
pip install -r hft/requirements.txt -r backtest/requirements.txt

# Live paper trading for 3 minutes (writes trades.csv and summary.txt)
cd hft
python bot.py --minutes 3
cd ..

# Backtest BTC + DOGE (first run downloads data into backtest/data/)
python backtest/run_backtest.py --all --days 7    # quick check
python backtest/run_backtest.py --all --days 90   # full run
```

Raw data from my 90-minute run is in [`results/`](results/). A more detailed write-up is in [`FINDINGS.md`](FINDINGS.md).

## About

This is a learning project. I wrote most of the code with the help of [Claude Code](https://claude.com/claude-code) — I decided what to test, ran the experiments, and worked through the results (and plenty of mistakes) along the way.

**Disclaimer:** paper trading only. No real money or exchange account was used. Nothing here is investment advice.

## Contact

greatgoldaxe.dev@gmail.com, or open an issue.

## License

[MIT](LICENSE)
