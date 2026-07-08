/* ══════════════════════════════════════════════════════════════════
   netlify/functions/stripe-boost-webhook.js

   Separate webhook endpoint for the $999/mo BroDop Boost AI subscription
   flow. Deliberately kept as its OWN file, OWN Stripe endpoint, and OWN
   signing secret — completely independent of stripe-webhook.js (the $49
   one-time flow) so nothing here can ever affect that pipeline.

   It fires the SAME two Zapier hooks the $49 flow uses (per your
   instruction — ZAP_BOOST_CONFIRM_WEBHOOK points at the same Zap URL as
   ZAP_CONFIRM_WEBHOOK), so both flows land in the same Clay table:

     ZAP_LEAD_WEBHOOK          → Zap 1  (Clay "Find or Create Row" by email)
     ZAP_BOOST_CONFIRM_WEBHOOK → Zap 2  (Clay "Find Row" by email →
                                  "Update Row" paymentStatus = Confirmed)
                                  ★ Same Zap URL as ZAP_CONFIRM_WEBHOOK ★

   WHY A SEPARATE FILE:
     Subscriptions confirm via Invoice events, not PaymentIntent events.
     invoice.payment_succeeded / invoice.payment_failed are structurally
     different payloads from payment_intent.succeeded, and importantly:
     invoice objects do NOT automatically inherit the metadata you set on
     the Subscription at creation time. So this file fetches the Customer
     record instead (where create-subscription.js also stamps the lead
     metadata) to reliably rebuild firstName / business / phone / city / website.

   NETLIFY ENV VARS REQUIRED (Site → Environment variables):
     STRIPE_SECRET_KEY           →  same key as the $49 flow, sk_live_...
     STRIPE_BOOST_WEBHOOK_SECRET →  whsec_...  (NEW — from this endpoint's
                                     own Stripe webhook setup, do NOT reuse
                                     the $49 endpoint's secret)
     ZAP_LEAD_WEBHOOK            →  same Zap 1 URL as the $49 flow
     ZAP_BOOST_CONFIRM_WEBHOOK   →  same URL as ZAP_CONFIRM_WEBHOOK (per your
                                     instruction — both flows confirm to the
                                     same Clay pipeline)

   STRIPE WEBHOOK SETUP (one-time, do this after deploying to Netlify):
     1. Stripe Dashboard → Developers → Webhooks → + Add endpoint
        (a SECOND, separate endpoint from the $49 one)
     2. Endpoint URL:  https://bias.brodop.ai/.netlify/functions/stripe-boost-webhook
     3. Select events: ✓ invoice.payment_succeeded
                       ✓ invoice.payment_failed
                       (optional, for future use: customer.subscription.deleted)
     4. Save → copy THIS endpoint's Signing secret (whsec_...) →
        add to Netlify as STRIPE_BOOST_WEBHOOK_SECRET (not the same value
        as STRIPE_WEBHOOK_SECRET — each endpoint has its own secret)
   ══════════════════════════════════════════════════════════════════ */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/* Server-side fetch to Zapier (unlike sendBeacon, this is guaranteed to complete) */
async function fireZapier(url, payload, label) {
  if (!url) {
    console.warn(`[stripe-boost-webhook] ${label} URL not set in env vars — skipping`);
    return;
  }
  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    console.log(`[stripe-boost-webhook] ${label} → Zapier responded ${resp.status}`);
  } catch (err) {
    console.error(`[stripe-boost-webhook] ${label} failed:`, err.message);
  }
}

/* Rebuild lead fields from the Customer record (metadata stamped in
   create-subscription.js at checkout time). Falls back to blanks if the
   customer lookup fails, so a bad lookup never crashes the webhook. */
async function getLeadFromCustomer(customerId, fallbackEmail) {
  let m = {};
  let customerEmail = fallbackEmail || '';

  try {
    const customer = await stripe.customers.retrieve(customerId);
    m = customer.metadata || {};
    customerEmail = customer.email || customerEmail;
  } catch (err) {
    console.error('[stripe-boost-webhook] Could not retrieve customer:', err.message);
  }

  return {
    firstName: m.firstName || '',
    business:  m.business  || '',
    email:     customerEmail,
    phone:     m.phone     || '',
    city:      m.city      || '',
    website:   m.website   || '',
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  /* Verify this request genuinely came from Stripe — uses this endpoint's
     OWN secret, separate from the $49 flow's STRIPE_WEBHOOK_SECRET */
  const sig    = event.headers['stripe-signature'];
  const secret = process.env.STRIPE_BOOST_WEBHOOK_SECRET;
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, secret);
  } catch (err) {
    console.error('[stripe-boost-webhook] Signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook error: ${err.message}` };
  }

  /* ── SUBSCRIPTION PAYMENT SUCCEEDED (first charge or monthly renewal) ── */
  if (stripeEvent.type === 'invoice.payment_succeeded') {
    const invoice = stripeEvent.data.object;
    const lead = await getLeadFromCustomer(invoice.customer, invoice.customer_email);

    const isFirstInvoice = invoice.billing_reason === 'subscription_create';

    console.log(`[stripe-boost-webhook] ✓ Boost AI payment succeeded (${isFirstInvoice ? 'first charge' : 'renewal'}): ${lead.email} — $${(invoice.amount_paid/100).toFixed(2)} ${invoice.currency.toUpperCase()}`);

    /* ZAP 1 — update Clay row (same hook as lander form / $49 flow, matched by email) */
    await fireZapier(process.env.ZAP_LEAD_WEBHOOK, {
      ...lead,
      intent:        'boost',
      paymentStatus: 'Pending',   /* Clay upsert — row already exists from modal submit */
      submittedAt:   new Date(invoice.created * 1000).toISOString(),
    }, 'Zap1-Lead-Boost');

    /* ZAP 2 — payment confirmed. Only fire "Confirmed" on the FIRST invoice
       (subscription_create) so monthly renewals don't re-trigger onboarding /
       enrichment in Clay. Renewals are still logged above for visibility. */
    if (isFirstInvoice) {
      await fireZapier(process.env.ZAP_CONFIRM_WEBHOOK, {
        ...lead,
        intent:               'boost',
        paymentStatus:        'Confirmed',
        amountPaid:           (invoice.amount_paid / 100).toFixed(2),
        currency:             invoice.currency.toUpperCase(),
        stripeSubscriptionId: invoice.subscription,
        stripeInvoiceId:      invoice.id,
        paidAt:               new Date(invoice.created * 1000).toISOString(),
      }, 'Zap2-Confirm-Boost');
    } else {
      console.log(`[stripe-boost-webhook] Renewal payment — not re-firing Confirmed status for ${lead.email}`);
    }
  }

  /* ── SUBSCRIPTION PAYMENT FAILED ─────────────────────────────── */
  if (stripeEvent.type === 'invoice.payment_failed') {
    const invoice = stripeEvent.data.object;
    const lead = await getLeadFromCustomer(invoice.customer, invoice.customer_email);
    const reason = (invoice.last_finalization_error && invoice.last_finalization_error.message) || 'Unknown';

    console.log(`[stripe-boost-webhook] ✗ Boost AI payment failed: ${lead.email} — ${reason}`);

    await fireZapier(process.env.ZAP_CONFIRM_WEBHOOK, {
      ...lead,
      intent:               'boost',
      paymentStatus:        'Failed',
      failReason:           reason,
      stripeSubscriptionId: invoice.subscription,
      stripeInvoiceId:      invoice.id,
      failedAt:             new Date().toISOString(),
    }, 'Zap2-Failed-Boost');
  }

  /* ── SUBSCRIPTION CANCELED (optional — logged only, no Clay action yet) ── */
  if (stripeEvent.type === 'customer.subscription.deleted') {
    const sub = stripeEvent.data.object;
    console.log(`[stripe-boost-webhook] Subscription canceled: ${sub.id} (customer ${sub.customer})`);
    /* Not wired to Zapier yet — add a fireZapier(...) call here later if
       you want Clay to reflect cancellations. */
  }

  /* Always return 200 so Stripe doesn't retry */
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
