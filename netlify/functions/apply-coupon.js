/* ══════════════════════════════════════════════════════════════════
   netlify/functions/apply-coupon.js

   Called by checkout.html when the visitor clicks "Apply" (or "Remove")
   next to the promo code field.

   Why this function exists:
   This checkout uses a PaymentIntent + custom Stripe Elements Payment
   Element — NOT a hosted Stripe Checkout Session. Stripe's built-in
   "Add promotion code" box only exists on Checkout Sessions, Invoices,
   and Subscriptions. For a PaymentIntent built by hand like this one,
   promo codes have to be looked up and applied manually, which is what
   this function does:

     action "apply"  → looks up the Stripe Promotion Code by its human
                        -readable code (e.g. "FRIENDS20"), recalculates
                        the order total server-side (never trust a
                        client-sent discount), and updates the existing
                        PaymentIntent's amount + metadata.
     action "remove" → resets the PaymentIntent back to the base $49.

   The Payment Element is already mounted client-side against this
   PaymentIntent's clientSecret. After this function updates the
   amount, the client calls elements.fetchUpdates() to pull the new
   amount into the already-mounted Payment Element — no remount needed.

   NETLIFY ENV VARS REQUIRED (Site → Environment variables):
     STRIPE_SECRET_KEY  →  sk_live_xxxxxxxxxxxxxxxxxxxx
     (same key create-payment-intent.js already uses)
   ══════════════════════════════════════════════════════════════════ */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const BASE_AMOUNT = 4900;   // $49.00 in cents — MUST match create-payment-intent.js
const CURRENCY    = 'usd';
const MIN_CHARGE  = 50;     // Stripe's practical minimum chargeable amount for USD

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}

  const paymentIntentId = body.paymentIntentId;
  const action           = body.action || 'apply';
  const code              = (body.code || '').trim().toUpperCase();

  if (!paymentIntentId) {
    return json(400, { error: 'Missing paymentIntentId' });
  }

  try {
    /* ── REMOVE: reset back to full price ─────────────────────────── */
    if (action === 'remove') {
      const updated = await stripe.paymentIntents.update(paymentIntentId, {
        amount: BASE_AMOUNT,
        metadata: { promoCode: '', promotionCodeId: '', promoDiscountCents: '' },
      });
      return json(200, { newAmount: updated.amount, discountCents: 0, currency: CURRENCY });
    }

    /* ── APPLY: look up the promo code, compute discount ──────────── */
    if (!code) {
      return json(400, { error: 'Enter a promo code' });
    }

    const list  = await stripe.promotionCodes.list({ code: code, active: true, limit: 1 });
    const promo = list.data[0];

    if (!promo) {
      return json(400, { error: 'Invalid or expired code' });
    }

    const coupon = promo.coupon;

    if (!coupon || coupon.valid === false) {
      return json(400, { error: 'This code is no longer valid' });
    }

    // amount_off coupons carry a currency — reject if it doesn't match this order
    if (coupon.amount_off && coupon.currency && coupon.currency !== CURRENCY) {
      return json(400, { error: 'This code is not valid for this order' });
    }

    // Minimum order amount restriction configured on the promotion code
    if (promo.restrictions && promo.restrictions.minimum_amount &&
        BASE_AMOUNT < promo.restrictions.minimum_amount) {
      return json(400, { error: 'This order does not meet the minimum amount for this code' });
    }

    let discountCents = 0;
    if (coupon.percent_off) {
      discountCents = Math.round(BASE_AMOUNT * (coupon.percent_off / 100));
    } else if (coupon.amount_off) {
      discountCents = coupon.amount_off;
    }

    let newAmount = Math.max(MIN_CHARGE, BASE_AMOUNT - discountCents);
    discountCents = BASE_AMOUNT - newAmount; // re-derive in case of clamping at MIN_CHARGE

    const updated = await stripe.paymentIntents.update(paymentIntentId, {
      amount: newAmount,
      metadata: {
        promoCode:          code,
        promotionCodeId:    promo.id,
        promoDiscountCents: String(discountCents),
      },
    });

    return json(200, {
      newAmount:     updated.amount,
      discountCents: discountCents,
      currency:      CURRENCY,
      percentOff:    coupon.percent_off || null,
      amountOff:     coupon.amount_off  || null,
    });

  } catch (err) {
    console.error('apply-coupon error:', err.message);
    return json(500, { error: err.message });
  }
};

function json(statusCode, data) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}
