/* ══════════════════════════════════════════════════════════════════
   netlify/functions/stripe-webhook.js

   Stripe calls this endpoint server-to-server when a payment clears.
   It fires the shared Clay/Zapier confirmation pipeline (see
   lib/clay.js) — the SAME pipeline claim-free-audit.js uses for
   100%-off orders that never touch Stripe at all:

     ZAP_LEAD_WEBHOOK     → Zap 1  (same hook the lander form fires)
                            Action: Clay "Find or Create Row" by email
                            Keeps the row updated with full lead data

     ZAP_CONFIRM_WEBHOOK  → Zap 2  (replaces old "Checkout Session Completed")
                            Action: Clay "Find Row" by email →
                                    "Update Row" set paymentStatus = Confirmed
                            ★ This is what kicks off Clay enrichment & audit ★

   PROMO REDEMPTION TRACKING (new):
   If the PaymentIntent that just succeeded had a promo code applied
   (metadata.promotionCodeId — set by apply-coupon.js), this records one
   redemption against that code and deactivates it on Stripe if that push-
   es it to its configured max_redemptions. See lib/promo-validate.js and
   lib/promo-store.js for why this bookkeeping has to happen ourselves.

   NETLIFY ENV VARS REQUIRED (Site → Environment variables):
     STRIPE_SECRET_KEY      →  sk_live_xxxxxxxxxxxxxxxxxxxx
     STRIPE_WEBHOOK_SECRET  →  whsec_xxxxxxxxxxxxxxxxxxxx  (from Stripe webhook setup)
     ZAP_LEAD_WEBHOOK       →  https://hooks.zapier.com/hooks/catch/27400579/43t6w40/
     ZAP_CONFIRM_WEBHOOK    →  https://hooks.zapier.com/hooks/catch/XXXXX/YYYYY/
                               ↑ Create a NEW "Catch Hook" trigger in Zapier for Zap 2

   STRIPE WEBHOOK SETUP (one-time, do this after deploying to Netlify):
     1. Stripe Dashboard → Developers → Webhooks → + Add endpoint
     2. Endpoint URL:  https://bias.brodop.ai/.netlify/functions/stripe-webhook
     3. Select events: ✓ payment_intent.succeeded
                       ✓ payment_intent.payment_failed
     4. Save → copy the Signing secret (whsec_...) → add to Netlify env vars above
   ══════════════════════════════════════════════════════════════════ */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { fireZapier, confirmAuditLead } = require('./lib/clay');
const { recordAndMaybeDeactivate } = require('./lib/promo-validate');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  /* Verify this request genuinely came from Stripe */
  const sig    = event.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, secret);
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook error: ${err.message}` };
  }

  /* ── PAYMENT SUCCEEDED ───────────────────────────────────────── */
  if (stripeEvent.type === 'payment_intent.succeeded') {
    const pi = stripeEvent.data.object;

    /* GUARD: payment_intent.succeeded fires account-wide — including for
       PaymentIntents Stripe creates behind the scenes for Boost AI
       subscription invoices (handled separately by stripe-boost-webhook.js).
       If this PaymentIntent belongs to an invoice, it's a subscription
       payment, not a one-time $49 audit purchase — skip it so the shared
       Confirm Zap never fires twice for the same payment. */
    if (pi.invoice) {
      console.log(`[stripe-webhook] Skipping ${pi.id} — belongs to invoice ${pi.invoice} (handled by stripe-boost-webhook.js)`);
      return { statusCode: 200, body: JSON.stringify({ received: true, skipped: 'subscription invoice payment' }) };
    }

    const m  = pi.metadata || {};

    /* Rebuild full lead from metadata stored at checkout load time */
    const lead = {
      firstName: m.firstName || '',
      business:  m.business  || '',
      email:     m.email     || pi.receipt_email || '',
      phone:     m.phone     || '',
      city:      m.city      || '',
      website:   m.website   || '',
    };

    console.log(`[stripe-webhook] ✓ Payment succeeded: ${lead.email} — $${(pi.amount_received/100).toFixed(2)} ${pi.currency.toUpperCase()}`);

    /* If a promo code was applied to this order (e.g. FRIENDS20), record
       the redemption and deactivate the code on Stripe if this pushes it
       to its limit. This never runs for 100%-off codes — those never
       reach this webhook at all, since no PaymentIntent is ever confirmed
       for them (see claim-free-audit.js, which does its own tracking). */
    if (m.promotionCodeId) {
      try {
        const promo = await stripe.promotionCodes.retrieve(m.promotionCodeId);
        await recordAndMaybeDeactivate(stripe, event, promo, pi.id);
      } catch (err) {
        console.error('[stripe-webhook] Promo redemption tracking failed:', err.message);
      }
    }

    /* Fire the shared Clay/Zapier confirmation pipeline — same one
       claim-free-audit.js uses for $0 orders. */
    await confirmAuditLead(lead, {
      amountPaid:      (pi.amount_received / 100).toFixed(2),
      currency:        pi.currency.toUpperCase(),
      stripePaymentId: pi.id,
      promoCode:       m.promoCode || '',
      paidAt:          new Date(pi.created * 1000).toISOString(),
    });
  }

  /* ── PAYMENT FAILED ──────────────────────────────────────────── */
  if (stripeEvent.type === 'payment_intent.payment_failed') {
    const pi     = stripeEvent.data.object;
    const m      = pi.metadata || {};
    const reason = (pi.last_payment_error && pi.last_payment_error.message) || 'Unknown';

    console.log(`[stripe-webhook] ✗ Payment failed: ${m.email} — ${reason}`);

    /* Notify Zap 2 with Failed status so Clay can log it or trigger
       a follow-up / abandoned-checkout sequence */
    await fireZapier(process.env.ZAP_CONFIRM_WEBHOOK, {
      firstName:       m.firstName || '',
      business:        m.business  || '',
      email:           m.email     || '',
      phone:           m.phone     || '',
      city:            m.city      || '',
      website:         m.website   || '',
      intent:          'audit',
      paymentStatus:   'Failed',
      failReason:      reason,
      stripePaymentId: pi.id,
      failedAt:        new Date().toISOString(),
    }, 'Zap2-Failed');
  }

  /* Always return 200 so Stripe doesn't retry */
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
