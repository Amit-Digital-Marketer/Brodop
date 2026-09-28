/* ══════════════════════════════════════════════════════════════════
   netlify/functions/lib/pricing.js

   Shared discount math. apply-coupon.js (checkout page, "Apply" button)
   and claim-free-audit.js (free-audit claim) both need to agree — byte
   for byte — on how a Stripe coupon turns BASE_AMOUNT into a final
   chargeable amount. If those two functions each did their own math,
   a coupon could be treated as "$0 → free flow" in one place and
   "$0.50 → paid flow" in the other, which is exactly the kind of bug
   that caused the original $0 checkout issue. This is the one place
   that math happens.
   ══════════════════════════════════════════════════════════════════ */

const MIN_CHARGE = 50; // Stripe's practical minimum chargeable amount for USD

/**
 * @param {Stripe.Coupon} coupon
 * @param {number} baseAmount - cents
 * @returns {{ newAmount: number, discountCents: number }}
 */
function computeDiscount(coupon, baseAmount) {
  let discountCents = 0;

  if (coupon.percent_off) {
    discountCents = Math.round(baseAmount * (coupon.percent_off / 100));
  } else if (coupon.amount_off) {
    discountCents = coupon.amount_off;
  }

  // Never discount past $0, regardless of how the coupon is configured.
  discountCents = Math.min(discountCents, baseAmount);
  const rawAmount = baseAmount - discountCents;

  // A fully-discounted order stays exactly $0 — it never becomes a
  // PaymentIntent amount (Stripe won't accept $0 anyway; the free-audit
  // flow handles it instead). Anything that ISN'T fully covered gets
  // clamped up to Stripe's real minimum chargeable amount, so e.g. a
  // 99%-off coupon can't produce a PaymentIntent amount Stripe will reject.
  const newAmount = rawAmount === 0 ? 0 : Math.max(MIN_CHARGE, rawAmount);
  const finalDiscount = baseAmount - newAmount;

  return { newAmount, discountCents: finalDiscount };
}

module.exports = { computeDiscount, MIN_CHARGE };
