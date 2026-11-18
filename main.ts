// Mean-reversion strategy for the make.fun cbBTC 24h race.
// Short-window z-score reversion on 1-minute bars, long only:
// buy a sharp down-move (z below -Z_ENTER), sell when price recovers to the
// rolling mean, or a stop/max-hold guard fires.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const MEAN_SPAN = 20;
const Z_ENTER = 2.2;
const MAX_SLIPPAGE_BPS = 200;
const STAKE_BPS = 9000n;
const STOP_DRAWDOWN = 0.02;
const MAX_HOLD_BARS = 30;

interface SymbolState {
  closes: number[];
  mean: number | null;
  std: number | null;
  entryCost: bigint | null;
  heldBars: number;
}

const book = new Map<string, SymbolState>();

function observe(symbol: string, close: number): SymbolState {
  let s = book.get(symbol);
  if (s === undefined) {
    s = { closes: [], mean: null, std: null, entryCost: null, heldBars: 0 };
    book.set(symbol, s);
  }
  s.closes.push(close);
  if (s.closes.length > MEAN_SPAN) s.closes.shift();
  if (s.closes.length === MEAN_SPAN) {
    const sum = s.closes.reduce((a, x) => a + x, 0);
    s.mean = sum / MEAN_SPAN;
    const sq = s.closes.reduce((a, x) => a + (x - s.mean!) * (x - s.mean!), 0);
    s.std = Math.sqrt(sq / MEAN_SPAN);
  }
  return s;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const fresh: string[] = [];
    for (const bar of batch.bars as Bar[]) {
      observe(bar.symbol, Number(bar.c));
      fresh.push(bar.symbol);
    }
    if (state.warmingUp) return [];

    const orders: (SellInput | BuyInput)[] = [];
    for (const symbol of fresh) {
      const s = book.get(symbol)!;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        s.heldBars++;
        const value = state.value(symbol, held.qty);
        const down = s.entryCost !== null && value * 100n <= s.entryCost * (100n - BigInt(Math.round(STOP_DRAWDOWN * 100)));
        const reverted = s.mean !== null && Number(bar.c) >= s.mean;
        if (reverted || down || s.heldBars >= MAX_HOLD_BARS) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.entryCost = null;
          s.heldBars = 0;
        }
        continue;
      }
      if (s.mean === null || s.std === null || s.std === 0) continue;
      const z = (Number(bar.c) - s.mean) / s.std;
      if (z < -Z_ENTER) {
        const stake = (STAKE_BPS * state.equity) / BPS;
        const spend = stake < state.cash ? stake : state.cash;
        if (spend >= BigInt(state.hello.fees.min_notional_quote_units)) {
          orders.push({ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.entryCost = spend;
          s.heldBars = 0;
        }
      }
    }
    return orders;
  },
});
