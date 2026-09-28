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
                        -readable code (e.g. "FRIENDS20"), re-validates
                        it (redemption limit included — see lib/promo-
                        validate.js) and recalculates the order total
                        server-side (never trust a client-sent discount).

                        • Partial discount (e.g. FRIENDS20) → updates the
                          existing PaymentIntent's amount + metadata, same
                          as before.
                        • 100%-off discount (e.g. STARTUPLISBON) → the
                          order is now $0. Stripe will not accept a $0
                          PaymentIntent amount, and per spec we must not
                          create/confirm a PaymentIntent for a free order
                          at all — so instead this CANCELS the existing
                          PaymentIntent and tells the client the order is
                          free. The client then hides the card form and
                          shows "Get my free audit", which is claimed via
                          claim-free-audit.js (a completely separate,
                          non-Stripe-payment code path).

     action "remove" → resets the PaymentIntent back to the base amount.
                        If the PaymentIntent was canceled (because a
                        100%-off code had been applied), there is nothing
                        left to reset — this returns needsNewPaymentIntent:
                        true so the client creates a fresh PaymentIntent
                        via create-payment-intent.js instead.

   The Payment Element is already mounted client-side against this
   PaymentIntent's clientSecret. After this function updates the
   amount (partial-discount case), the client calls elements.fetchUpdates()
   to pull the new amount into the already-mounted Payment Element — no
   remount needed. The free case and the "PI was canceled" remove case
   both require a full remount against a new clientSecret instead.

   NETLIFY ENV VARS REQUIRED (Site → Environment variables):
     STRIPE_SECRET_KEY  →  sk_live_xxxxxxxxxxxxxxxxxxxx
     (same key create-payment-intent.js already uses)
   ══════════════════════════════════════════════════════════════════ */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { BASE_AMOUNT, CURRENCY } = require('./lib/constants');
const { validatePromoCode } = require('./lib/promo-validate');

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
      try {
        const updated = await stripe.paymentIntents.update(paymentIntentId, {
          amount: BASE_AMOUNT,
          metadata: { promoCode: '', promotionCodeId: '', promoDiscountCents: '' },
        });
        return json(200, { newAmount: updated.amount, discountCents: 0, currency: CURRENCY });
      } catch (err) {
        // If a 100%-off code was applied earlier, this PaymentIntent was
        // CANCELED (see the "apply" branch below) — there's nothing left
        // to reset. Tell the client to get a brand-new PaymentIntent.
        if (isCanceledPaymentIntentError(err)) {
          return json(200, { needsNewPaymentIntent: true, discountCents: 0, currency: CURRENCY });
        }
        throw err;
      }
    }

    /* ── APPLY: look up the promo code, compute discount ──────────── */
    const validation = await validatePromoCode(stripe, event, code, BASE_AMOUNT);

    if (!validation.ok) {
      return json(validation.status, { error: validation.error });
    }

    const { promo, newAmount, discountCents, coupon } = validation;

    /* 100%-off → this order is free. Do NOT create/confirm a Stripe
       PaymentIntent for $0 — cancel the placeholder one instead. The
       client switches to the free-audit flow (claim-free-audit.js),
       which re-validates this same code server-side before granting
       anything. */
    if (newAmount === 0) {
      try {
        await stripe.paymentIntents.cancel(paymentIntentId);
      } catch (err) {
        // Already canceled/succeeded is fine to ignore here — we're about
        // to tell the client this is a free order either way. Anything
        // else, surface it.
        if (!isCanceledPaymentIntentError(err)) {
          console.error('apply-coupon: failed to cancel PaymentIntent for free order:', err.message);
        }
      }

      return json(200, {
        free: true,
        newAmount: 0,
        discountCents: discountCents,
        currency: CURRENCY,
        promotionCodeId: promo.id,
        code: code,
      });
    }

    /* Partial discount → update the existing PaymentIntent's amount, same as before */
    const updated = await stripe.paymentIntents.update(paymentIntentId, {
      amount: newAmount,
      metadata: {
        promoCode:          code,
        promotionCodeId:    promo.id,
        promoDiscountCents: String(discountCents),
      },
    });

    return json(200, {
      free:          false,
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

/** True if a Stripe error is "you can't update/act on a canceled PaymentIntent". */
function isCanceledPaymentIntentError(err) {
  if (!err) return false;
  if (err.code === 'payment_intent_unexpected_state') return true;
  const msg = err.message || '';
  return msg.indexOf('canceled') !== -1 || msg.indexOf('cancelled') !== -1;
}

function json(statusCode, data) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}
