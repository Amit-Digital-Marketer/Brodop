/* ══════════════════════════════════════════════════════════════════
   netlify/functions/claim-free-audit.js   (NEW)

   Called by checkout.html when the visitor clicks "Get my free audit"
   — only shown after a 100%-off promo code (e.g. STARTUPLISBON) has
   been applied and apply-coupon.js has told the client the order is
   free (see apply-coupon.js, which cancels the PaymentIntent at that
   point rather than trying to charge $0).

   This function does NOT touch Stripe PaymentIntents/Charges at all.
   Per spec, a free order must never create or confirm a PaymentIntent.
   Instead it:

     1. Re-validates the promo code from scratch, server-side — the
        client's earlier "Apply" check is a UX convenience, not a
        source of truth. This is the authoritative check: is the code
        still active, still fully covers the order, and still under
        its redemption limit right now?
     2. Records the redemption (idempotently — see lib/promo-store.js)
        and deactivates the Stripe Promotion Code if this pushes it to
        its configured max_redemptions.
     3. Fires the SAME Clay/Zapier confirmation pipeline stripe-webhook.js
        uses for paid orders (lib/clay.js), so Clay enrichment and audit
        delivery kick off exactly the same way regardless of whether the
        order was paid or fully comped.

   The client then redirects to the thank-you page WITHOUT
   redirect_status=succeeded (that param only exists because Stripe adds
   it after a genuine charge), so Google Ads / Meta / OpenAI never record
   a paid conversion for a $0 order.

   NETLIFY ENV VARS REQUIRED (Site → Environment variables):
     STRIPE_SECRET_KEY    →  same key every other function here uses
                              (only used to look up/validate/deactivate
                              the Promotion Code — no charge is ever made)
     ZAP_LEAD_WEBHOOK      →  same Zap 1 URL used everywhere else
     ZAP_CONFIRM_WEBHOOK   →  same Zap 2 URL used everywhere else
   ══════════════════════════════════════════════════════════════════ */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { BASE_AMOUNT } = require('./lib/constants');
const { validatePromoCode, recordAndMaybeDeactivate } = require('./lib/promo-validate');
const { confirmAuditLead } = require('./lib/clay');

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

  // Optional — if the client still has the (now-canceled) PaymentIntent id
  // handy, we make a best-effort attempt to cancel it too, in case
  // apply-coupon.js's own cancel attempt didn't stick for some reason.
  // Never fatal — this endpoint's job is granting the free audit, not
  // PaymentIntent housekeeping.
  const paymentIntentId = body.paymentIntentId;

  if (!firstName || !business || !email) {
    return json(400, { error: 'Please fill in your name, business name, and email.' });
  }
  if (!EMAIL_RE.test(email)) {
    return json(400, { error: 'Please enter a valid email address.' });
  }
  if (!code) {
    return json(400, { error: 'Missing promo code' });
  }

  try {
    /* ── 1. Re-validate the promo code, authoritatively, right now ── */
    const validation = await validatePromoCode(stripe, event, code, BASE_AMOUNT);

    if (!validation.ok) {
      return json(validation.status, { error: validation.error });
    }

    if (validation.newAmount !== 0) {
      // This code gives a discount, not a free order — someone hit this
      // endpoint without going through the normal free-checkout UI flow.
      return json(400, {
        error: 'This code offers a discount, not a free audit — please complete payment above.',
      });
    }

    const { promo } = validation;

    /* Best-effort: make sure no PaymentIntent is left dangling for this order. */
    if (paymentIntentId) {
      try {
        await stripe.paymentIntents.cancel(paymentIntentId);
      } catch (err) {
        // Already canceled, already succeeded, or never existed — fine to ignore.
      }
    }

    /* ── 2. Record the redemption + deactivate the code if it's now exhausted ──
       Idempotency key = email + code, so a double-click or a retried request
       can't grant (or count) the same free audit twice. */
    const idempotencyKey = `${email.toLowerCase()}:${code}`;
    await recordAndMaybeDeactivate(stripe, event, promo, idempotencyKey);

    /* ── 3. Fire the same Clay/Zapier pipeline paid orders use ── */
    const lead = { firstName, business, email, phone, city, website };
    await confirmAuditLead(lead, {
      amountPaid:      '0.00',
      currency:        'USD',
      stripePaymentId: null,   // no Stripe charge exists for a free order
      promoCode:       code,
      paidAt:          new Date().toISOString(),
    });

    console.log(`[claim-free-audit] ✓ Free audit granted: ${email} — code ${code}`);

    return json(200, { success: true });

  } catch (err) {
    console.error('claim-free-audit error:', err.message);
    return json(500, { error: 'Something went wrong claiming your free audit. Please try again.' });
  }
};

function json(statusCode, data) {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}
