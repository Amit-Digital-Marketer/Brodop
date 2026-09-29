/* ══════════════════════════════════════════════════════════════════
   netlify/functions/lib/clay.js

   The Clay/Zapier confirmation pipeline — extracted out of
   stripe-webhook.js so it has exactly ONE implementation, shared by
   every path that can confirm an audit purchase:

     stripe-webhook.js    → paid orders ($49, or a partial-discount
                             amount like FRIENDS20) once Stripe confirms
                             payment_intent.succeeded
     claim-free-audit.js  → 100%-off orders (e.g. STARTUPLISBON) — no
                             Stripe charge ever happens for these, so
                             this is the ONLY confirmation signal Clay
                             gets for a free order

   Previously this logic lived only inside stripe-webhook.js. Duplicating
   it into claim-free-audit.js would have meant two copies that could
   quietly drift apart (e.g. one gets a field renamed and the other
   doesn't). Both now call confirmAuditLead().

   NETLIFY ENV VARS REQUIRED (unchanged from before):
     ZAP_LEAD_WEBHOOK     →  https://hooks.zapier.com/hooks/catch/27400579/43t6w40/
     ZAP_CONFIRM_WEBHOOK  →  https://hooks.zapier.com/hooks/catch/XXXXX/YYYYY/
   ══════════════════════════════════════════════════════════════════ */

/** Server-side fetch to Zapier (unlike sendBeacon, this is guaranteed to complete). */
async function fireZapier(url, payload, label) {
  if (!url) {
    console.warn(`[clay] ${label} URL not set in env vars — skipping`);
    return;
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log(`[clay] ${label} → Zapier responded ${resp.status}`);
  } catch (err) {
    console.error(`[clay] ${label} failed:`, err.message);
  }
}

/**
 * Fires both Clay Zaps for a confirmed purchase — paid OR free, audit OR boost.
 *
 * @param {object} lead - { firstName, business, email, phone, city, website }
 * @param {object} extra
 * @param {string} [extra.intent]   - 'audit' (default) or 'boost'
 * @param {string} extra.amountPaid - e.g. '49.00' or '0.00'
 * @param {string} extra.currency   - e.g. 'USD'
 * @param {string} [extra.promoCode]
 * @param {string} extra.paidAt     - ISO timestamp
 * @param {object} [extra.fields]   - extra product-specific keys merged into the
 *                                    Confirm payload (e.g. stripePaymentId,
 *                                    stripeSubscriptionId)
 */
async function confirmLead(lead, extra) {
  const intent = extra.intent || 'audit';
  const tag = intent === 'boost' ? '-Boost' : '';

  // ZAP 1 — upsert Clay row (mirrors the lander form's own Zap 1 call;
  // this is an idempotent "Find or Create Row by email" on the Clay side)
  await fireZapier(process.env.ZAP_LEAD_WEBHOOK, {
    ...lead,
    intent,
    paymentStatus: 'Pending',
    submittedAt: extra.paidAt,
  }, 'Zap1-Lead' + tag);

  // ZAP 2 — payment confirmed trigger. Clay watches this field to kick off
  // enrichment + delivery — same trigger whether the order was paid or
  // fully comped by a 100%-off promo code.
  await fireZapier(process.env.ZAP_CONFIRM_WEBHOOK, {
    ...lead,
    intent,
    paymentStatus: 'Confirmed',
    amountPaid: extra.amountPaid,
    currency: extra.currency,
    promoCode: extra.promoCode || '',
    paidAt: extra.paidAt,
    ...(extra.fields || {}),
  }, 'Zap2-Confirm' + tag);
}

/** $49 audit wrapper — keeps the original call signature used by stripe-webhook.js */
async function confirmAuditLead(lead, extra) {
  return confirmLead(lead, {
    intent: 'audit',
    amountPaid: extra.amountPaid,
    currency: extra.currency,
    promoCode: extra.promoCode,
    paidAt: extra.paidAt,
    fields: { stripePaymentId: extra.stripePaymentId },
  });
}

module.exports = { fireZapier, confirmLead, confirmAuditLead };
