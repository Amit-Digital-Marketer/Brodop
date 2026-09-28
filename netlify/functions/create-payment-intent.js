/* ══════════════════════════════════════════════════════════════════
   netlify/functions/create-payment-intent.js

   Called by checkout.html on page load, AND again by checkout.html if
   the visitor removes a 100%-off promo code after applying it (that
   earlier PaymentIntent gets canceled by apply-coupon.js — see below —
   so a fresh one has to be created to go back to a paid checkout).

   Creates a Stripe PaymentIntent and stores ALL lead fields in its
   metadata so stripe-webhook.js can read them back when payment
   succeeds — even if the browser closed before the thank-you redirect.

   NETLIFY ENV VARS REQUIRED (Site → Environment variables):
     STRIPE_SECRET_KEY  →  sk_live_xxxxxxxxxxxxxxxxxxxx
   ══════════════════════════════════════════════════════════════════ */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { BASE_AMOUNT, CURRENCY } = require('./lib/constants');

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) {}

  const { email, firstName, business, phone, city, website } = body;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount:   BASE_AMOUNT,
      currency: CURRENCY,
      automatic_payment_methods: { enabled: true },
      receipt_email: email || undefined,

      /* ALL lead fields stored here — stripe-webhook.js reads these back
         on payment_intent.succeeded and sends them to both Zapier hooks */
      metadata: {
        product:   'BroDop Bias AI Audit',
        firstName: firstName || '',
        business:  business  || '',
        email:     email     || '',
        phone:     phone     || '',
        city:      city      || '',
        website:   website   || '',
      },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      /* paymentIntentId is returned alongside clientSecret so the client can
         later call apply-coupon.js against this same PaymentIntent when the
         visitor enters a promo code. `amount` is returned too so the client
         never has to hardcode/guess the base price — it's always whatever
         the server actually charges. */
      body: JSON.stringify({
        clientSecret:    paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount:          paymentIntent.amount,
        currency:        paymentIntent.currency,
      }),
    };

  } catch (err) {
    console.error('Stripe PaymentIntent error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
