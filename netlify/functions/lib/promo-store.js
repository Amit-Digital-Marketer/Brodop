/* ══════════════════════════════════════════════════════════════════
   netlify/functions/lib/promo-store.js

   Server-side redemption tracking for Stripe Promotion Codes.

   WHY THIS EXISTS:
   Stripe's own `max_redemptions` / `times_redeemed` counters are only
   incremented when a Promotion Code is redeemed through STRIPE'S OWN
   Checkout Session / Invoice / Subscription discount mechanism. This
   project applies promo codes by hand — looking the code up, computing
   the discount ourselves, and setting the amount on a manually-built
   PaymentIntent — so Stripe never actually "sees" a redemption happen.
   That means Stripe will never auto-deactivate a code once its limit
   is hit; nothing is tracking that at all today. This module is that
   tracking layer.

   Storage: Netlify Blobs (zero-config key/value storage bundled with
   every Netlify site, no external database to provision). One counter
   key per Promotion Code ID, plus one "seen" key per redemption attempt
   so retries (double-clicks, webhook redelivery) can never double-count.

   NETLIFY CONFIG REQUIRED:
     None — Netlify Blobs is automatically available on every Netlify
     site/function at runtime. You only need the `@netlify/blobs`
     package in package.json (already added).

     NOTE: These functions use the classic Lambda-compatible handler
     signature (`exports.handler = async function(event)`), so Blobs'
     environment must be wired up manually per-invocation via
     `connectLambda(event)` — done inside this module, callers don't
     need to think about it.
   ══════════════════════════════════════════════════════════════════ */

const { getStore, connectLambda } = require('@netlify/blobs');

const STORE_NAME = 'promo-redemptions';

function store(event) {
  if (event) connectLambda(event);
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

function counterKey(promotionCodeId) {
  return `count:${promotionCodeId}`;
}

function seenKey(promotionCodeId, idempotencyKey) {
  return `seen:${promotionCodeId}:${idempotencyKey}`;
}

/** Current redemption count we've recorded for this promotion code. */
async function getRedemptionCount(event, promotionCodeId) {
  const s = store(event);
  const data = await s.get(counterKey(promotionCodeId), { type: 'json' });
  return (data && typeof data.count === 'number') ? data.count : 0;
}

/**
 * Record one redemption for a promotion code, unless `idempotencyKey` has
 * already been recorded before — so a retried request (double-click on
 * "Get my free audit", a redelivered Stripe webhook) can never inflate
 * the count for the same underlying order.
 *
 * @returns {Promise<{count: number, isNew: boolean}>}
 */
async function recordRedemption(event, promotionCodeId, idempotencyKey) {
  const s = store(event);
  const sKey = seenKey(promotionCodeId, idempotencyKey);

  const already = await s.get(sKey);
  if (already) {
    const count = await getRedemptionCount(event, promotionCodeId);
    return { count, isNew: false };
  }

  const current = await getRedemptionCount(event, promotionCodeId);
  const next = current + 1;

  await s.setJSON(counterKey(promotionCodeId), {
    count: next,
    updatedAt: new Date().toISOString(),
  });
  await s.set(sKey, new Date().toISOString());

  return { count: next, isNew: true };
}

module.exports = { getRedemptionCount, recordRedemption };
