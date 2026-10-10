"""核对网页回测（docs/js/engine.js）和 Python 回测（backtest/）结果是否逐位一致。

两边读同一份内置数据（docs/data/*_1m_90d.json），跑几组不同参数（含不同手续费），
比较笔数、盈利笔数、平仓原因、已实现盈亏、总手续费、期末权益。浮点数要求完全相等。

改了 hft/account.py、backtest/strategy.py、backtest/engine.py 或 docs/js/engine.js 之后跑一次。
需要 Node.js（跑 JS 那一半）。不联网。

用法（在仓库根目录）：
    python tools/check_parity.py
"""

import functools
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "backtest"))

import engine
import strategy
from hft.account import Account

SYMBOLS = ["BTCUSDT", "DOGEUSDT"]
INITIAL_CASH = 100_000.0
# (名字, 覆盖的策略参数, 单边手续费)
CASES = [
    ("default", {}, 0.001),
    ("no_fee", {}, 0.0),
    ("bnb_fee", {}, 0.00075),
    ("wide", {"take_profit": 0.02, "stop_loss": 0.01, "hold_bars": 120}, 0.001),
    ("picky", {"momentum_bars": 5, "momentum_threshold": 0.003, "take_profit": 0.01,
               "stop_loss": 0.005, "hold_bars": 30}, 0.001),
]

JS = r"""
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const [root, casesJson] = process.argv.slice(1);
const { run, DEFAULT_PARAMS } = await import(pathToFileURL(root + "/docs/js/engine.js").href);
const { decodeKlines } = await import(pathToFileURL(root + "/docs/js/data.js").href);
const out = {};
for (const sym of ["BTCUSDT", "DOGEUSDT"]) {
  const bars = decodeKlines(JSON.parse(fs.readFileSync(`${root}/docs/data/${sym}_1m_90d.json`, "utf8")));
  for (const [name, over, fee] of JSON.parse(casesJson)) {
    const { acct, equity } = run(bars, { ...DEFAULT_PARAMS, ...over, fee_rate: fee });
    const reasons = {};
    let wins = 0;
    for (const t of acct.closedTrades) {
      reasons[t.reason] = (reasons[t.reason] || 0) + 1;
      if (t.pnl > 0) wins++;
    }
    out[`${sym}/${name}`] = {
      round_trips: acct.closedTrades.length, wins, reasons,
      realized_pnl: acct.realizedPnl, total_fees: acct.totalFees, final_equity: equity[equity.length - 1],
    };
  }
}
console.log(JSON.stringify(out));
"""


def load_bars(symbol):
    """解码内置快照，和 docs/js/data.js 的 decodeKlines 同一套规则。"""
    with open(os.path.join(ROOT, "docs", "data", f"{symbol}_1m_90d.json"), encoding="utf-8") as f:
        j = json.load(f)
    scale = 10 ** j["decimals"]
    gaps = {i: ts for i, ts in j["gaps"]}
    bars = []
    prev_close = 0
    t = j["start"]
    for i in range(j["count"]):
        if i in gaps:
            t = gaps[i]
        elif i > 0:
            t += 60_000
        o = prev_close + j["open"][i]
        c = o + j["close"][i]
        # 整数 / 10^d 是正确舍入的除法，和 float("0.09541") 得到同一个浮点数
        bars.append({"ts": t, "open": o / scale, "close": c / scale})
        prev_close = c
    return bars


def run_python():
    out = {}
    original = engine.Account
    try:
        for sym in SYMBOLS:
            bars = load_bars(sym)
            for name, over, fee in CASES:
                engine.Account = functools.partial(Account, fee_rate=fee)
                params = dict(strategy.DEFAULT_PARAMS, **over)
                acct, eq = engine.run(bars, params, initial_cash=INITIAL_CASH)
                reasons = {}
                for t in acct.closed_trades:
                    reasons[t["reason"]] = reasons.get(t["reason"], 0) + 1
                out[f"{sym}/{name}"] = {
                    "round_trips": len(acct.closed_trades),
                    "wins": sum(1 for t in acct.closed_trades if t["pnl"] > 0),
                    "reasons": reasons,
                    "realized_pnl": acct.realized_pnl,
                    "total_fees": acct.total_fees,
                    "final_equity": eq[-1][1],
                }
    finally:
        engine.Account = original
    return out


def run_js():
    node = shutil.which("node")
    if node is None:
        sys.exit("找不到 node：需要安装 Node.js 才能跑 JS 那一半。")
    r = subprocess.run(
        [node, "--input-type=module", "-e", JS, ROOT, json.dumps(CASES)],
        capture_output=True, text=True, encoding="utf-8",
    )
    if r.returncode != 0:
        sys.exit(f"node 运行失败：\n{r.stderr}")
    return json.loads(r.stdout)


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # Windows cp950 下中文报错会乱码
        except Exception:
            pass
    py = run_python()
    js = run_js()
    failed = 0
    for key in py:
        a, b = py[key], js.get(key)
        diffs = [k for k in a if b is None or a[k] != b.get(k)]
        if diffs:
            failed += 1
            print(f"[不一致] {key}")
            for k in diffs:
                print(f"    {k}: python={a[k]!r}  js={None if b is None else b.get(k)!r}")
        else:
            print(f"[一致]   {key}  {a['round_trips']} 笔  盈亏 {a['realized_pnl']:+.2f}  手续费 {a['total_fees']:.2f}")
    print()
    if failed:
        sys.exit(f"{failed}/{len(py)} 组不一致：网页和 Python 的回测口径已经分叉。")
    print(f"全部 {len(py)} 组逐位一致。")
