/* netlify/functions/create-payment-intent.js
   
   This runs server-side on Netlify — your Stripe SECRET key stays safe here,
   it is never exposed to the browser.

   SETUP:
   1. In Netlify dashboard → Site → Environment variables, add:
        STRIPE_SECRET_KEY  =  sk_live_xxxxxxxxxxxxxxxx   (your Stripe secret key)
   2. Deploy — Netlify auto-detects files in /netlify/functions/ and deploys them.
*/

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async function(event) {
  /* Only allow POST */
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let email = '';
  try {
    const body = JSON.parse(event.body || '{}');
    email = body.email || '';
  } catch(e) {}

  try {
    /* Create a PaymentIntent for $49 USD */
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 4900,          /* amount in CENTS — 4900 = $49.00 */
      currency: 'usd',       /* change to 'aud' if you want AUD */
      automatic_payment_methods: { enabled: true },
      receipt_email: email || undefined,
      metadata: { product: 'BroDop BiAS AI Audit' },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientSecret: paymentIntent.client_secret }),
    };
  } catch (err) {
    console.error('Stripe error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
