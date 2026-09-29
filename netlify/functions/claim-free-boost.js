/* ══════════════════════════════════════════════════════════════════
   netlify/functions/claim-free-boost.js   (NEW)

   Boost AI ($999/mo) counterpart of claim-free-audit.js.

   Called by checkout-boost.html when the visitor clicks "Get my free
   Boost AI" — only shown after apply-coupon-subscription.js has told
   the client that the applied promo code brings today's total to $0
   (in which case it cancels the incomplete Stripe subscription rather
   than creating a $0 subscription with no card behind it).

   This function does NOT create a Stripe Subscription, Invoice or
   PaymentIntent. It:

     1. Re-validates the promo code from scratch, server-side (active,
        fully covers the price, still under its redemption limit).
     2. Records the redemption (idempotently) and deactivates the Stripe
        Promotion Code once its max_redemptions is reached.
     3. Fires the same Clay/Zapier confirmation the paid webhook uses
        (lib/clay.js, intent = 'boost') so onboarding starts identically.

   ⚠ BILLING NOTE: because no card is collected and no Stripe
   subscription exists, a free Boost claim is a fully comped order that
   will NOT auto-convert to $999/mo. Use 100%-off codes only for
   deliberately free access (e.g. partner/startup programme).

   NETLIFY ENV VARS: STRIPE_SECRET_KEY, STRIPE_BOOST_PRICE_ID,
   ZAP_LEAD_WEBHOOK, ZAP_CONFIRM_WEBHOOK (all already in use).
   ══════════════════════════════════════════════════════════════════ */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { validatePromoCode, recordAndMaybeDeactivate } = require('./lib/promo-validate');
const { confirmLead } = require('./lib/clay');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}

  const code      = (body.code || '').trim().toUpperCase();
  const firstName = (body.firstName || '').trim();
  const business  = (body.business  || '').trim();
  const email     = (body.email     || '').trim();
  const phone     = (body.phone     || '').trim();
  const city      = (body.city      || '').trim();
  const website   = (body.website   || '').trim();

  if (!firstName || !business || !email) {
    return json(400, { error: 'Please fill in your name, business name, and email.' });
  }
  if (!EMAIL_RE.test(email)) {
    return json(400, { error: 'Please enter a valid email address.' });
  }
  if (!code) {
    return json(400, { error: 'Missing promo code' });
  }

  const priceId = process.env.STRIPE_BOOST_PRICE_ID;
  if (!priceId) {
    return json(500, { error: 'Server misconfigured: missing STRIPE_BOOST_PRICE_ID.' });
  }

  try {
    /* Authoritative price comes from Stripe, never from the client */
    const price = await stripe.prices.retrieve(priceId);
    const baseCents = price.unit_amount;

    /* 1. Re-validate the code, right now */
    const validation = await validatePromoCode(stripe, event, code, baseCents);
    if (!validation.ok) {
      return json(validation.status, { error: validation.error });
    }
    if (validation.newAmount !== 0) {
      return json(400, {
        error: 'This code offers a discount, not a free plan — please complete payment above.',
      });
    }

    /* 2. Record redemption (idempotent) + deactivate if now exhausted */
    const idempotencyKey = `boost:${email.toLowerCase()}:${code}`;
    await recordAndMaybeDeactivate(stripe, event, validation.promo, idempotencyKey);

    /* 3. Same Clay/Zapier pipeline as paid Boost orders */
    await confirmLead({ firstName, business, email, phone, city, website }, {
      intent:     'boost',
      amountPaid: '0.00',
      currency:   (price.currency || 'usd').toUpperCase(),
      promoCode:  code,
      paidAt:     new Date().toISOString(),
      fields: {
        stripeSubscriptionId: null,   // no Stripe subscription exists for a free claim
        stripeInvoiceId:      null,
      },
    });

    console.log(`[claim-free-boost] ✓ Free Boost AI granted: ${email} — code ${code}`);
    return json(200, { success: true });

  } catch (err) {
    console.error('claim-free-boost error:', err.message);
    return json(500, { error: 'Something went wrong claiming your free plan. Please try again.' });
  }
};

function json(statusCode, data) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}
