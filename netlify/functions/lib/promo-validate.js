/* ══════════════════════════════════════════════════════════════════
   netlify/functions/lib/promo-validate.js

   Single source of truth for "is this promo code valid right now, and
   what does it do to this order" — used by:

     apply-coupon.js      → FIRST validation, when the visitor clicks
                             "Apply" on the checkout page
     claim-free-audit.js  → SECOND, authoritative validation, at the
                             moment a 100%-off code is actually claimed
                             (never trust the first check alone — the
                             code could get exhausted by someone else
                             in between)
     stripe-webhook.js    → uses recordAndMaybeDeactivate() once a paid
                             order with a promo code actually clears

   ══════════════════════════════════════════════════════════════════ */

const { computeDiscount } = require('./pricing');
const { getRedemptionCount, recordRedemption } = require('./promo-store');

/**
 * @param {Stripe} stripe
 * @param {object} event - the Netlify function event (needed for Blobs)
 * @param {string} code
 * @param {number} baseAmount - cents
 * @returns {Promise<
 *   {ok:true, promo:Stripe.PromotionCode, coupon:Stripe.Coupon, newAmount:number, discountCents:number} |
 *   {ok:false, status:number, error:string}
 * >}
 */
async function validatePromoCode(stripe, event, code, baseAmount) {
  if (!code) {
    return { ok: false, status: 400, error: 'Enter a promo code' };
  }

  const list = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
  const promo = list.data[0];

  if (!promo) {
    return { ok: false, status: 400, error: 'Invalid or expired code' };
  }

  const coupon = promo.coupon;

  if (!coupon || coupon.valid === false) {
    return { ok: false, status: 400, error: 'This code is no longer valid' };
  }

  // amount_off coupons carry a currency — reject if it doesn't match this order
  if (coupon.amount_off && coupon.currency && coupon.currency !== 'usd') {
    return { ok: false, status: 400, error: 'This code is not valid for this order' };
  }

  // Minimum order amount restriction configured on the promotion code
  if (promo.restrictions && promo.restrictions.minimum_amount &&
      baseAmount < promo.restrictions.minimum_amount) {
    return { ok: false, status: 400, error: 'This order does not meet the minimum amount for this code' };
  }

  // Redemption limit — Stripe's `max_redemptions` is the source of truth for
  // the LIMIT, but (see promo-store.js) Stripe never auto-increments the
  // COUNT for this hand-built-PaymentIntent flow, so the count comes from
  // our own server-side tracker.
  if (typeof promo.max_redemptions === 'number') {
    const used = await getRedemptionCount(event, promo.id);
    if (used >= promo.max_redemptions) {
      // Belt-and-suspenders: make sure Stripe agrees it's dead, in case an
      // earlier deactivation attempt failed (network blip, etc).
      await deactivateIfNeeded(stripe, promo);
      return { ok: false, status: 400, error: 'This code has reached its redemption limit' };
    }
  }

  const { newAmount, discountCents } = computeDiscount(coupon, baseAmount);

  return { ok: true, promo, coupon, newAmount, discountCents };
}

/** Deactivates a Stripe Promotion Code (no-op if already inactive). */
async function deactivateIfNeeded(stripe, promo) {
  if (!promo.active) return;
  try {
    await stripe.promotionCodes.update(promo.id, { active: false });
    console.log(`[promo-validate] Deactivated promotion code ${promo.id} (${promo.code}) — redemption limit reached`);
  } catch (err) {
    console.error('[promo-validate] Failed to deactivate promotion code', promo.id, err.message);
  }
}

/**
 * Records one redemption against `promo`, and deactivates it on Stripe if
 * that redemption pushed it to (or past) its configured max_redemptions.
 * Call this ONLY at the moment a redemption actually, truly happens:
 *   - claim-free-audit.js: once the free audit is being granted
 *   - stripe-webhook.js:   once payment_intent.succeeded fires for an
 *                           order that had a promo code applied
 *
 * @param {string} idempotencyKey - something stable per real-world order
 *   (e.g. the PaymentIntent id, or `${email}:${code}` for free claims) so
 *   retries/redeliveries can't double-count the same redemption.
 * @returns {Promise<number>} the redemption count after this call
 */
async function recordAndMaybeDeactivate(stripe, event, promo, idempotencyKey) {
  const { count } = await recordRedemption(event, promo.id, idempotencyKey);
  if (typeof promo.max_redemptions === 'number' && count >= promo.max_redemptions) {
    await deactivateIfNeeded(stripe, promo);
  }
  return count;
}

module.exports = { validatePromoCode, deactivateIfNeeded, recordAndMaybeDeactivate };
