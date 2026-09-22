/* ══════════════════════════════════════════════════════════════════
   netlify/functions/apply-coupon-subscription.js

   Called by checkout-boost.html when the visitor clicks "Apply" (or
   "Remove") next to the promo code field on the $999/mo Boost AI page.

   WHY THIS WORKS DIFFERENTLY FROM THE ONE-TIME ($49) FLOW
   ----------------------------------------------------------------------
   For the one-time audit, apply-coupon.js just lowers the amount on an
   already-created PaymentIntent — safe, because a PaymentIntent isn't
   tied to any recurring billing record.

   A subscription's first invoice is auto-finalized (and its PaymentIntent
   generated) the instant create-subscription.js creates the subscription.
   Once an invoice is finalized, Stripe locks its line items/total — you
   can't edit a finalized invoice's amount directly, and manually editing
   its PaymentIntent's amount out-of-band would desync Stripe's own
   invoicing/dunning records from what was actually charged.

   The Stripe-native way to discount a subscription is to attach a
   Promotion Code via the `discounts` param — but that only affects
   invoices generated AFTER the discount is attached, not one that's
   already finalized. So to discount TODAY's charge, this function:

     1. Cancels the customer's current "incomplete" subscription. Stripe
        automatically voids its already-finalized-but-unpaid first
        invoice when an incomplete subscription is canceled, so nothing
        is left half-billed or duplicated.
     2. Creates a brand-new Subscription for the same customer + price,
        this time with `discounts: [{ promotion_code }]` attached from
        the start, so the discount is baked into the first invoice's
        total the moment it's finalized — and, depending on the coupon's
        "duration" setting in Stripe (once / repeating / forever), will
        keep applying to future renewal invoices too.
     3. Returns the new invoice's real clientSecret + totals, read
        straight from Stripe's own computed invoice (never estimated
        client-side), so checkout-boost.html can remount the Payment
        Element against the new PaymentIntent.

   action "remove" does the same cancel + recreate, just without a
   discount attached, to cleanly restore full price.

   This never touches the Stripe Customer record (name/email/metadata),
   which is what stripe-boost-webhook.js reads lead info from — so the
   Zapier/Clay pipeline is completely unaffected by any of this.

   NETLIFY ENV VARS REQUIRED (same ones create-subscription.js uses):
     STRIPE_SECRET_KEY      →  sk_live_...
     STRIPE_BOOST_PRICE_ID  →  price_...  ($999/mo recurring Price)
   ══════════════════════════════════════════════════════════════════ */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

function extractClientSecret(subscription) {
  const invoice = subscription.latest_invoice;
  return (
    (invoice && invoice.confirmation_secret && invoice.confirmation_secret.client_secret) ||
    (invoice && invoice.payment_intent && invoice.payment_intent.client_secret) ||
    null
  );
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}

  const customerId        = body.customerId;
  const oldSubscriptionId = body.subscriptionId;
  const action             = body.action || 'apply';
  const code               = (body.code || '').trim().toUpperCase();

  if (!customerId) {
    return json(400, { error: 'Missing customerId' });
  }

  const priceId = process.env.STRIPE_BOOST_PRICE_ID;
  if (!priceId) {
    return json(500, { error: 'Server misconfigured: missing STRIPE_BOOST_PRICE_ID.' });
  }

  try {
    let promotionCodeId = null;
    let couponSummary    = null;

    if (action === 'apply') {
      if (!code) return json(400, { error: 'Enter a promo code' });

      const list  = await stripe.promotionCodes.list({ code: code, active: true, limit: 1 });
      const promo = list.data[0];
      if (!promo) return json(400, { error: 'Invalid or expired code' });

      const coupon = promo.coupon;
      if (!coupon || coupon.valid === false) {
        return json(400, { error: 'This code is no longer valid' });
      }

      promotionCodeId = promo.id;
      couponSummary = {
        percentOff:       coupon.percent_off || null,
        amountOff:        coupon.amount_off  || null,
        duration:         coupon.duration,               // 'once' | 'repeating' | 'forever'
        durationInMonths: coupon.duration_in_months || null,
      };
    }

    /* ── Cancel the existing incomplete subscription. Stripe auto-voids
          its unpaid first invoice, so nothing is left dangling. ── */
    if (oldSubscriptionId) {
      try {
        const existing = await stripe.subscriptions.retrieve(oldSubscriptionId);
        if (existing.status === 'incomplete') {
          await stripe.subscriptions.cancel(oldSubscriptionId);
        }
      } catch (e) {
        console.warn('[apply-coupon-subscription] Could not cancel old subscription (may already be gone):', e.message);
      }
    }

    /* ── Create the replacement subscription, discounted or not ── */
    const createParams = {
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
        payment_method_types: ['card'],
      },
      expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payment_intent'],
    };
    if (promotionCodeId) {
      createParams.discounts = [{ promotion_code: promotionCodeId }];
      createParams.metadata  = { promoCode: code, promotionCodeId: promotionCodeId };
    }

    const subscription = await stripe.subscriptions.create(createParams);
    const clientSecret  = extractClientSecret(subscription);

    if (!clientSecret) {
      console.error('[apply-coupon-subscription] No client secret found on invoice:', JSON.stringify(subscription.latest_invoice));
      return json(500, { error: 'Could not retrieve a payment client secret from the new invoice.' });
    }

    const invoice         = subscription.latest_invoice;
    const todayTotalCents = invoice.amount_due;
    const baseCents        = subscription.items.data[0].price.unit_amount;
    const discountCents    = Math.max(0, baseCents - todayTotalCents);

    return json(200, {
      clientSecret:    clientSecret,
      subscriptionId:  subscription.id,
      todayTotalCents: todayTotalCents,
      baseCents:       baseCents,
      discountCents:   discountCents,
      coupon:          couponSummary,   // null when action === 'remove'
    });

  } catch (err) {
    console.error('[apply-coupon-subscription] error:', err.message);
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
