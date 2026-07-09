/* ══════════════════════════════════════════════════════════════════
   netlify/functions/stripe-webhook.js

   Stripe calls this endpoint server-to-server when a payment clears.
   It fires TWO Zapier webhooks that exactly mirror your original flow:

     ZAP_LEAD_WEBHOOK     → Zap 1  (same hook the lander form fires)
                            Action: Clay "Find or Create Row" by email
                            Keeps the row updated with full lead data

     ZAP_CONFIRM_WEBHOOK  → Zap 2  (replaces old "Checkout Session Completed")
                            Action: Clay "Find Row" by email →
                                    "Update Row" set paymentStatus = Confirmed
                            ★ This is what kicks off Clay enrichment & audit ★

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

/* Server-side fetch to Zapier (unlike sendBeacon, this is guaranteed to complete) */
async function fireZapier(url, payload, label) {
  if (!url) {
    console.warn(`[stripe-webhook] ${label} URL not set in env vars — skipping`);
    return;
  }
  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    console.log(`[stripe-webhook] ${label} → Zapier responded ${resp.status}`);
  } catch (err) {
    console.error(`[stripe-webhook] ${label} failed:`, err.message);
  }
}

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

    /* ZAP 1 — update Clay row (same webhook as lander form, matched by email)
       Clay: "Find or Create Row" where email = lead.email → update all fields */
    await fireZapier(process.env.ZAP_LEAD_WEBHOOK, {
      ...lead,
      intent:        'audit',
      paymentStatus: 'Pending',   /* Clay upsert — row already exists from form submit */
      submittedAt:   new Date(pi.created * 1000).toISOString(),
    }, 'Zap1-Lead');

    /* ZAP 2 — payment confirmed trigger (replaces "Checkout Session Completed")
       Clay: "Find Row" where email = lead.email → "Update Row" paymentStatus = Confirmed
       ★ This status change is what kicks off Clay enrichment and the audit pipeline ★ */
    await fireZapier(process.env.ZAP_CONFIRM_WEBHOOK, {
      ...lead,
      intent:          'audit',
      paymentStatus:   'Confirmed',        /* ← Clay watches this field to trigger enrichment */
      amountPaid:      (pi.amount_received / 100).toFixed(2),
      currency:        pi.currency.toUpperCase(),
      stripePaymentId: pi.id,              /* useful reference for receipts / Clay record */
      paidAt:          new Date(pi.created * 1000).toISOString(),
    }, 'Zap2-Confirm');
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
