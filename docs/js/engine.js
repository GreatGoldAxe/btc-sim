// 回测引擎：hft/account.py + backtest/strategy.py + backtest/engine.py 的逐行移植。
// 口径必须和 Python 版一致（改这里前先改 Python，再同步过来）：
//   - 第 i 根收盘时决策，第 i+1 根开盘价成交（防前视）
//   - 同一时间只持有一笔；手续费双边收；sell 的 pnl 已扣开仓费和平仓费

export const DEFAULT_PARAMS = {
  momentum_bars: 1,
  momentum_threshold: 0.0001,
  take_profit: 0.003,
  stop_loss: 0.0015,
  hold_bars: 1,
  notional: 100.0,
  fee_rate: 0.001,
};

export const INITIAL_CASH = 100_000.0;

class Account {
  constructor(initialCash, feeRate) {
    this.initialCash = initialCash;
    this.cash = initialCash;
    this.feeRate = feeRate;
    this.positionQty = 0.0;
    this.entryPrice = null;
    this.entryFee = 0.0;
    this.totalFees = 0.0;
    this.realizedPnl = 0.0;
    this.closedTrades = [];
  }

  get hasPosition() {
    return this.positionQty > 0;
  }

  buy(price, notional) {
    if (this.hasPosition) return null;
    const qty = notional / price;
    const fee = notional * this.feeRate;
    if (this.cash < notional + fee) return null;
    this.cash -= notional + fee;
    this.positionQty = qty;
    this.entryPrice = price;
    this.entryFee = fee;
    this.totalFees += fee;
    return { price, qty, fee };
  }

  sell(price, reason, entryIdx, exitIdx) {
    if (!this.hasPosition) return null;
    const qty = this.positionQty;
    const notional = price * qty;
    const fee = notional * this.feeRate;
    const pricePnl = (price - this.entryPrice) * qty;
    const pnl = pricePnl - this.entryFee - fee;
    this.cash += notional - fee;
    this.totalFees += fee;
    this.realizedPnl += pnl;
    this.closedTrades.push({ pnl, pricePnl, fees: this.entryFee + fee, reason, entryIdx, exitIdx });
    this.positionQty = 0.0;
    this.entryPrice = null;
    this.entryFee = 0.0;
    return { price, qty, fee, pnl };
  }

  equity(markPrice) {
    return this.cash + this.positionQty * markPrice;
  }
}

function entrySignal(close, i, p) {
  const n = p.momentum_bars;
  if (i < n) return false;
  const base = close[i - n];
  if (base <= 0) return false;
  return (close[i] - base) / base > p.momentum_threshold;
}

function exitSignal(c, entryPrice, entryIdx, i, p) {
  if (c >= entryPrice * (1 + p.take_profit)) return "take_profit";
  if (c <= entryPrice * (1 - p.stop_loss)) return "stop_loss";
  if (i - entryIdx + 1 >= p.hold_bars) return "timeout";
  return null;
}

/**
 * bars: { open: Float64Array, close: Float64Array, ts: Float64Array }
 * 返回 { acct, equity: Float64Array（含费）, fees: Float64Array（累计手续费） }
 * 不扣费的权益 = equity + fees（信号与手续费无关，所以成交序列完全相同）。
 */
export function run(bars, params, initialCash = INITIAL_CASH) {
  const { open, close } = bars;
  const n = close.length;
  const acct = new Account(initialCash, params.fee_rate);
  const equity = new Float64Array(n);
  const fees = new Float64Array(n);
  let hasPos = false;
  let entryPrice = 0;
  let entryIdx = 0;
  let pending = null; // "buy" 或平仓原因

  for (let i = 0; i < n; i++) {
    // 1) 执行上一根收盘时挂起的动作（本根开盘价成交）
    if (pending === "buy") {
      const fill = acct.buy(open[i], params.notional);
      if (fill !== null) {
        hasPos = true;
        entryPrice = fill.price;
        entryIdx = i;
      }
      pending = null;
    } else if (pending !== null) {
      acct.sell(open[i], pending, entryIdx, i);
      hasPos = false;
      pending = null;
    }

    // 2) 本根收盘做决策（只用 i 及之前的数据）
    if (!hasPos) {
      if (entrySignal(close, i, params)) pending = "buy";
    } else {
      const reason = exitSignal(close[i], entryPrice, entryIdx, i, params);
      if (reason) pending = reason;
    }

    equity[i] = acct.equity(close[i]);
    fees[i] = acct.totalFees;
  }
  return { acct, equity, fees };
}

/** backtest/metrics.py 里网页用得到的那部分，外加「扣费前」拆分。 */
export function summarize(acct, equity, initialCash = INITIAL_CASH) {
  const closed = acct.closedTrades;
  const n = closed.length;
  let wins = 0;
  let pricePnl = 0;
  const reasons = {
    take_profit: { count: 0, pnl: 0, pricePnl: 0 },
    stop_loss: { count: 0, pnl: 0, pricePnl: 0 },
    timeout: { count: 0, pnl: 0, pricePnl: 0 },
  };
  for (const t of closed) {
    if (t.pnl > 0) wins++;
    pricePnl += t.pricePnl;
    const r = reasons[t.reason];
    r.count++;
    r.pnl += t.pnl;
    r.pricePnl += t.pricePnl;
  }
  // 期末未平仓那笔的开仓费不属于已平仓来回（同 metrics.py）
  const closedFees = acct.totalFees - (acct.hasPosition ? acct.entryFee : 0);
  const finalEquity = equity.length ? equity[equity.length - 1] : initialCash;
  return {
    roundTrips: n,
    wins,
    winRate: n ? wins / n : 0,
    realizedPnl: acct.realizedPnl,
    closedFees,
    totalFees: acct.totalFees,
    pricePnl,
    totalReturn: (finalEquity - initialCash) / initialCash,
    reasons,
  };
}

/** 保本所需止盈率（只看触及止盈或止损的交易）。按每笔 100 USDT、不计价差。 */
export function breakEven(takeProfit, stopLoss, feeRate, notional = 100) {
  const cost = notional * (1 + feeRate);
  const win = notional * (1 + takeProfit) * (1 - feeRate) - cost;
  const loss = notional * (1 - stopLoss) * (1 - feeRate) - cost;
  const flat = notional * (1 - feeRate) - cost; // 价格不动就平仓（超时）
  const required = win > 0 ? -loss / (win - loss) : null; // null = 止盈也赔钱，不可能保本
  return { win, loss, flat, required };
}
