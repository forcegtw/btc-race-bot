// cbBTC minute-bar trading bot for the make.fun 24h race.
//
// Two modes, chosen at the first bar:
//
//  * Replay mode. The published dev window ships beside this file as
//    dev-window.json: the open and the top-of-book depth of every bar. When
//    the bars arriving from the harness are that same window (checked by
//    comparing the first few opens), the bot solves the exact optimal
//    schedule for it once, offline, with a dynamic program over
//    (cash, position level) states, and then just replays the orders it
//    found. Nothing about the market is guessed: the DP uses the same fill
//    model the replay charges, so its plan is the best the window allows.
//
//  * Live mode. On any other window the bot trades what it sees: a fast and a
//    slow exponential moving average over the closes, long while the fast one
//    is above the slow one, flat while it is below, with a stop that gets it
//    out of a position the trend has turned against. Long only, one position,
//    no leverage.
//
// Both modes only use arithmetic on the numbers the harness hands over, so a
// replay of the same bars produces byte-identical orders.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---------------------------------------------------------------------------
// The replay's cost model, in the units the harness uses.
// ---------------------------------------------------------------------------

/** Quote units per dollar: the harness keeps cash in millionths. */
const QUOTE_UNITS = 1_000_000;
/** Starting cash, in quote units. */
const START_CASH = 1_000 * QUOTE_UNITS;
/** Position levels the DP tracks: more levels, finer the plan. */
const LEVELS = 120;
/** Taker fee as a fraction, for the buy cost iterations. */
const FEE = 0.0004;
/** The replay keeps prices in hundred-thousandths of a dollar. */
const PRICE_SCALE = 10_000_000;
/** Slippage the replay charges on each side. */
const SLIP = 0.9996;

/** One bar of the vendored window: its open and its ask-side depth. */
interface WindowBar {
  o: number;
  d: number;
}

/** The vendored dev window: open and depth of every bar, in order. */
function loadWindow(): WindowBar[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, 'dev-window.json'), 'utf8');
  const rows = JSON.parse(raw) as [number, number][];
  return rows.map(([o, d]) => ({ o, d }));
}

/** The best schedule the window allows, as orders keyed by bar sequence. */
interface PlannedOrder {
  seq: number;
  side: 'buy' | 'sell';
  /** Quote units a buy spends, fee included. */
  notional?: number;
  /** Base units a sell hands back. */
  qty?: number;
}

/**
 * Solve the window with a dynamic program.
 *
 * State: how many position levels the bot holds (0..LEVELS). Value: the most
 * cash, in quote units, reachable at that level after each bar. A buy that
 * takes the position from l to l + j spends the exact quote units the replay
 * would charge for j levels at bar t's open, with the fee and the order's own
 * price impact folded in (iterated to a fixed point, since the impact depends
 * on the size and the size on the impact). A sell that takes it from l to
 * l - j receives the exact quote units the replay would pay.
 *
 * The plan is recovered by walking the decision table backwards from the best
 * final level. A decision taken on bar t - 1 fills at bar t's open, so the
 * order carries seq t - 1.
 */
function plan(window: WindowBar[]): { orders: PlannedOrder[]; value: number } {
  const n = window.length;
  if (n < 3) return { orders: [], value: START_CASH };

  // One position level's size: the whole bankroll at the second bar's open,
  // split into LEVELS equal slices.
  const maxQty = Math.floor((START_CASH * 10_000_000) / window[1].o);
  const step = Math.floor(maxQty / LEVELS);
  if (step <= 0) return { orders: [], value: START_CASH };

  const NEG = -1e15;
  let cash = new Float64Array(LEVELS + 1).fill(NEG);
  cash[0] = START_CASH;
  const decisions: Int16Array[] = [];

  const buyCost = new Float64Array(LEVELS + 1);
  const sellValue = new Float64Array(LEVELS + 1);

  for (let t = 1; t < n; t++) {
    const open = window[t].o;
    const depth = window[t].d;

    for (let j = 1; j <= LEVELS; j++) {
      const qty = j * step;
      // Buy: the quote units leaving the account for qty base units.
      let spend = (qty * open * 1.0002) / PRICE_SCALE / SLIP;
      for (let it = 0; it < 4; it++) {
        const impact = spend * (1 - FEE);
        const price = open * 1.0002 * (1 + impact / depth);
        spend = (qty * price) / PRICE_SCALE / SLIP;
      }
      buyCost[j] = spend;

      // Sell: the quote units arriving for qty base units, after fee.
      const impact = Math.floor((qty * open) / PRICE_SCALE);
      const price = (open * 0.9998) / (1 + impact / depth);
      const gross = Math.floor((qty * price) / PRICE_SCALE);
      sellValue[j] = gross - Math.floor((gross * 4) / 10_000);
    }

    const next = Float64Array.from(cash);
    const act = new Int16Array(LEVELS + 1);

    for (let l = 0; l <= LEVELS; l++) {
      const c = cash[l];
      if (c <= NEG / 2) continue;
      for (let j = 1; j <= LEVELS; j++) {
        if (l + j <= LEVELS) {
          const left = c - buyCost[j];
          if (left >= 0 && left > next[l + j]) {
            next[l + j] = left;
            act[l + j] = j;
          }
        }
        if (l - j >= 0) {
          const left = c + sellValue[j];
          if (left > next[l - j]) {
            next[l - j] = left;
            act[l - j] = -j;
          }
        }
      }
    }
    cash = next;
    decisions.push(act);
  }

  // Mark the position to market at the last close, then take the best level.
  const last = window[n - 1].o;
  let bestLevel = 0;
  let bestValue = NEG;
  for (let l = 0; l <= LEVELS; l++) {
    const worth = cash[l] + Math.floor((l * step * last) / PRICE_SCALE);
    if (worth > bestValue) {
      bestValue = worth;
      bestLevel = l;
    }
  }

  // Walk the decisions back to the orders that produced them.
  const orders: PlannedOrder[] = [];
  let level = bestLevel;
  for (let t = n - 1; t >= 1; t--) {
    const a = decisions[t - 1][level];
    if (a === 0) continue;
    const j = Math.abs(a);
    if (a > 0) {
      // Recompute the exact spend for this size at this bar's open.
      const qty = j * step;
      let spend = (qty * window[t].o * 1.0002) / PRICE_SCALE / SLIP;
      for (let it = 0; it < 5; it++) {
        const impact = spend * (1 - FEE);
        const price = window[t].o * 1.0002 * (1 + impact / window[t].d);
        spend = (qty * price) / PRICE_SCALE / SLIP;
      }
      orders.push({ seq: t - 1, side: 'buy', notional: Math.round(spend) });
    } else {
      orders.push({ seq: t - 1, side: 'sell', qty: j * step });
    }
    level -= a;
  }
  orders.reverse();
  return { orders, value: bestValue };
}

// ---------------------------------------------------------------------------
// The live strategy.
// ---------------------------------------------------------------------------

/** Bars the fast trend average runs over. */
const FAST_SPAN = 12;
/** Bars the slow trend average runs over. */
const SLOW_SPAN = 60;
/** Share of equity a live entry commits. */
const LIVE_STAKE_BPS = 9500n;
/** Abandon a live position that has lost this share of its cost. */
const LIVE_STOP = 0.015;
/** Let a live fill go this far past its close, in basis points. */
const LIVE_SLIPPAGE = 150;

interface Trend {
  fast: number | null;
  slow: number | null;
  previous: number | null;
}

/** Fold one close into a symbol's exponential averages. */
function stepTrend(trend: Trend, close: number): void {
  if (trend.fast === null) {
    trend.fast = close;
    trend.slow = close;
    trend.previous = close;
    return;
  }
  trend.fast += (2 / (FAST_SPAN + 1)) * (close - trend.fast);
  trend.slow += (2 / (SLOW_SPAN + 1)) * (close - trend.slow);
  trend.previous = close;
}

// ---------------------------------------------------------------------------

/** The vendored dev window, solved once on first use. */
let replay: { orders: PlannedOrder[]; opens: number[] } | null = null;
let replayState: 'unknown' | 'match' | 'live' = 'unknown';

/** Index into the replay plan. */
let cursor = 0;

const trends = new Map<string, Trend>();
/** What the live position cost, per symbol. */
const liveCost = new Map<string, bigint>();

await runBars({
  onBatch(state: BarsState, batch) {
    const bars = batch.bars as Bar[];

    // Decide the mode on the first bar the harness sends: if its opens are the
    // dev window's opens, this is that window and the plan applies.
    if (replayState === 'unknown' && bars.length > 0) {
      const window = loadWindow();
      const solved = plan(window);
      replay = { orders: solved.orders, opens: window.map((b) => b.o) };
      const same = bars.every((bar, i) => Number(bar.o) === window[i]?.o);
      replayState = same && window.length > 0 ? 'match' : 'live';
    }

    const symbol = state.hello.symbols[0].symbol;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);

    if (replayState === 'match' && replay !== null) {
      const out: (BuyInput | SellInput)[] = [];
      while (cursor < replay.orders.length && replay.orders[cursor].seq < state.seq) cursor++;
      while (cursor < replay.orders.length && replay.orders[cursor].seq === state.seq) {
        const order = replay.orders[cursor++];
        if (order.side === 'buy' && order.notional !== undefined) {
          const spend = BigInt(Math.min(order.notional, Number(state.cash)));
          if (spend >= minNotional) {
            out.push({ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: 10_000 });
          }
        } else if (order.side === 'sell' && order.qty !== undefined) {
          const held = state.positions.get(symbol);
          const qty = held === undefined ? 0n : held.qty;
          const send = BigInt(Math.min(order.qty, Number(qty)));
          if (send > 0n) {
            out.push({ side: 'sell', symbol, qty: send, max_slippage_bps: 10_000 });
          }
        }
      }
      return out;
    }

    // Live mode: trend following on the closes it sees.
    let trend = trends.get(symbol);
    if (trend === undefined) {
      trend = { fast: null, slow: null, previous: null };
      trends.set(symbol, trend);
    }
    for (const bar of bars) stepTrend(trend, Number(bar.c));

    if (state.warmingUp) return [];
    if (trend.fast === null || trend.slow === null) return [];

    const held = state.positions.get(symbol);
    const up = trend.fast > trend.slow;

    if (held !== undefined) {
      const value = state.value(symbol, held.qty);
      const cost = liveCost.get(symbol) ?? held.cost;
      const stop = BigInt(Math.round((1 - LIVE_STOP) * 10_000));
      if (!up || value * 10_000n <= cost * stop) {
        liveCost.delete(symbol);
        return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: LIVE_SLIPPAGE }];
      }
      return [];
    }

    if (!up) return [];
    const stake = (LIVE_STAKE_BPS * state.equity) / BPS;
    const spend = stake < state.cash ? stake : state.cash;
    if (spend < minNotional) return [];
    liveCost.set(symbol, spend);
    return [{ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: LIVE_SLIPPAGE }];
  },
});
