// Pump.fun Replay Sprint Bot - Momentum & Dip Strategy
// Targets: 20+ distinct mints, max 50% DD, >0 net PnL after fees
// Strategy: Buy early momentum, sell on fade or profit target, manage risk

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n;        // 0.05 SOL per position
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 200n;    // 0.005 SOL minimum
const MAX_SLIPPAGE_BPS = 5000;                       // 50% slippage tolerance
const PROFIT_TARGET_BPS = 2000;                      // 20% profit target
const STOP_LOSS_BPS = 1500;                          // 15% stop loss
const TRAILING_STOP_BPS = 1000;                      // 10% trailing stop
const MAX_HOLD_SLOTS = 120;                          // Max hold ~120 slots (~2 min)
const MIN_REAL_RESERVE_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL real reserve to consider

interface CoinState {
  entryPrice?: bigint;      // Average entry price (lamports per token)
  entrySlot: number;
  peakPrice: bigint;        // Peak price since entry
  bought: boolean;
  sold: boolean;
}

const coinStates = new Map<string, CoinState>();

// Deterministic RNG from seed (for any randomness needed)
function mulberry32(seed: number) {
  return function() {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 0x1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 0x61 | t)) | 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

await runBot({
  onHello(state) {
    // Initialize RNG from hello seed for deterministic behavior
    const seed = Number(BigInt(state.hello.seed) & 0xFFFFFFFFn);
    // Could use mulberry32(seed) for any randomness, but we avoid randomness for determinism
    console.error(`Bot initialized with seed: ${seed}`);
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const { caps, fees } = state.hello;
    const txFee = state.txFeeLamports();
    let freeCash = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();
    const orders: OrderInput[] = [];

    // Process events to update coin states
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        // New coin launched - track it
        coinStates.set(event.mint, {
          entrySlot: event.slot,
          peakPrice: 0n,
          bought: false,
          sold: false,
        });
      } else if (event.event === 'TradeEvent') {
        // Update peak price for held coins
        const coinState = coinStates.get(event.mint);
        if (coinState && coinState.bought && !coinState.sold) {
          const curve = state.curves.get(event.mint);
          if (curve && curve.real_quote_reserves > 0n && curve.real_token_reserves > 0n) {
            // Price = real_quote_reserves / real_token_reserves (SOL per token)
            const price = (curve.real_quote_reserves * LAMPORTS_PER_SOL) / curve.real_token_reserves;
            if (price > coinState.peakPrice) {
              coinState.peakPrice = price;
            }
          }
        }
      } else if (event.event === 'CompleteEvent') {
        // Curve completed - mark as sold if we held it
        const coinState = coinStates.get(event.mint);
        if (coinState) {
          coinState.sold = true;
        }
      }
    }

    // Check existing positions for exit conditions
    for (const [mint, holding] of state.positions) {
      if (holding.token_amount === 0n) continue;

      const coinState = coinStates.get(mint);
      const curve = state.curves.get(mint);
      if (!curve || curve.complete || !coinState || coinState.sold) continue;

      // Calculate current price
      if (curve.real_quote_reserves === 0n || curve.real_token_reserves === 0n) continue;
      const currentPrice = (curve.real_quote_reserves * LAMPORTS_PER_SOL) / curve.real_token_reserves;
      if (currentPrice === 0n) continue;

      const slotsHeld = batch.slot - coinState.entrySlot;
      let shouldSell = false;
      let sellReason = '';

      // Update peak
      if (currentPrice > coinState.peakPrice) {
        coinState.peakPrice = currentPrice;
      }

      // Profit target hit
      if (coinState.entryPrice && currentPrice >= (coinState.entryPrice * (10000n + BigInt(PROFIT_TARGET_BPS))) / 10000n) {
        shouldSell = true;
        sellReason = 'profit_target';
      }
      // Stop loss
      else if (coinState.entryPrice && currentPrice <= (coinState.entryPrice * (10000n - BigInt(STOP_LOSS_BPS))) / 10000n) {
        shouldSell = true;
        sellReason = 'stop_loss';
      }
      // Trailing stop from peak
      else if (coinState.peakPrice > 0n && currentPrice <= (coinState.peakPrice * (10000n - BigInt(TRAILING_STOP_BPS))) / 10000n) {
        shouldSell = true;
        sellReason = 'trailing_stop';
      }
      // Max hold time
      else if (slotsHeld >= MAX_HOLD_SLOTS) {
        shouldSell = true;
        sellReason = 'max_hold';
      }

      if (shouldSell) {
        console.error(`SELL ${mint.slice(0,8)}: ${sellReason}, price=${currentPrice}, held=${slotsHeld} slots`);
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        coinState.sold = true;
        // Note: freeCash and openSlots will be updated after fills arrive
      }
    }

    // Look for new buying opportunities
    for (const event of batch.events) {
      if (event.event !== 'CreateEvent') continue;
      const mint = event.mint;

      const coinState = coinStates.get(mint);
      if (!coinState || coinState.bought || coinState.sold) continue;

      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;

      // Need sufficient real reserve for meaningful trading
      if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;

      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;

      // Check if we have capacity
      if (orders.length >= caps.max_orders_per_batch || openSlots <= 0) break;
      if (freeCash < STAKE_LAMPORTS + txFee) break;

      // Buy!
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      const currentPrice = (curve.real_quote_reserves * LAMPORTS_PER_SOL) / curve.real_token_reserves;

      console.error(`BUY ${mint.slice(0,8)}: ${amount} lamports, price≈${currentPrice}, reserve=${curve.real_quote_reserves}`);
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });

      coinState.bought = true;
      coinState.entryPrice = currentPrice;
      coinState.peakPrice = currentPrice;
      freeCash -= amount + txFee;
      openSlots -= 1;
    }

    return orders;
  },

  onDone(state, done) {
    console.error(`Done: final cash=${done.account.cash_lamports}, positions=${done.account.positions.length}`);
    console.error(`Distinct mints traded: ${coinStates.size}`);
  },
});