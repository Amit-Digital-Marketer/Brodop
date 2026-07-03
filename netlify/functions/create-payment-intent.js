/* ══════════════════════════════════════════════════════════════════
   netlify/functions/create-payment-intent.js

   Called by checkout.html on page load.
   Creates a Stripe PaymentIntent and stores ALL lead fields in its
   metadata so stripe-webhook.js can read them back when payment
   succeeds — even if the browser closed before the thank-you redirect.

   NETLIFY ENV VARS REQUIRED (Site → Environment variables):
     STRIPE_SECRET_KEY  →  sk_live_xxxxxxxxxxxxxxxxxxxx
   ══════════════════════════════════════════════════════════════════ */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) {}

  const { email, firstName, business, phone, city, website } = body;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount:   4900,    /* $49.00 in cents — change currency below if needed */
      currency: 'usd',   /* ← change to 'aud' for Australian dollars */
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
      body: JSON.stringify({ clientSecret: paymentIntent.client_secret }),
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
