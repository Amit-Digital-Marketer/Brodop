// netlify/functions/create-subscription.js
//
// Backend for checkout-boost.html ($999/mo BroDop Boost AI subscription).
// Mirrors the pattern of your existing create-payment-intent.js, but instead
// of a one-off PaymentIntent it creates:
//   1. A Stripe Customer (so recurring billing has somewhere to attach to)
//   2. A Subscription on that customer, using your $999/mo Price
//   3. Returns the clientSecret of the first invoice's PaymentIntent, which
//      is what checkout-boost.html uses with stripe.confirmPayment()
//
// Required environment variables (set in Netlify: Site settings → Environment variables):
//   STRIPE_SECRET_KEY   -> sk_live_... (Developers → API keys → Secret key)
//   STRIPE_BOOST_PRICE_ID -> price_...  (the recurring $999/mo Price you create
//                                        in Stripe Dashboard → Product catalog →
//                                        "BroDop Boost AI" → add a recurring price)
//
// NOTE: You must create the $999/mo recurring Price in Stripe first (Dashboard
// → Product catalog → New product → "BroDop Boost AI" → Recurring → $999 / month).
// Copy its Price ID (starts with "price_") into STRIPE_BOOST_PRICE_ID.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const email     = (body.email || '').trim();
    const firstName = (body.firstName || '').trim();
    const business   = (body.business || '').trim();
    const phone      = (body.phone || '').trim();
    const city       = (body.city || '').trim();
    const website    = (body.website || '').trim();

    if (!email || !firstName || !business) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
    }

    const priceId = process.env.STRIPE_BOOST_PRICE_ID;
    if (!priceId) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured: missing STRIPE_BOOST_PRICE_ID.' }) };
    }

    // Metadata gets stamped on the customer + subscription + invoice's
    // PaymentIntent so your webhook can read lead info back, same as the
    // $49 flow does today.
    const metadata = {
      firstName: firstName,
      business:  business,
      phone:     phone,
      city:      city,
      website:   website,
      product:   'BroDop Boost AI',
    };

    // 1. Create (or reuse) the customer
    const customer = await stripe.customers.create({
      email: email,
      name: firstName + ' ' + business,
      phone: phone || undefined,
      metadata: metadata,
    });

    // 2. Create the subscription in "incomplete" state — Stripe generates the
    //    first invoice, which the Payment Element on the front end will confirm.
    //
    //    NOTE: Stripe has two ways an invoice exposes its client secret,
    //    depending on your account's API version:
    //      - Newer accounts: invoice.confirmation_secret.client_secret
    //      - Older accounts: invoice.payment_intent.client_secret
    //    We expand both and use whichever is present so this keeps working
    //    regardless of which API version your Stripe account is pinned to.
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
        payment_method_types: ['card'],
      },
      expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payment_intent'],
      metadata: metadata,
    });

    const invoice = subscription.latest_invoice;
    const clientSecret =
      (invoice && invoice.confirmation_secret && invoice.confirmation_secret.client_secret) ||
      (invoice && invoice.payment_intent && invoice.payment_intent.client_secret);

    if (!clientSecret) {
      console.error('No client secret found on invoice:', JSON.stringify(invoice));
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Could not retrieve a payment client secret from the invoice.' }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        clientSecret:    clientSecret,
        subscriptionId:  subscription.id,
        customerId:      customer.id,
      }),
    };

  } catch (err) {
    console.error('create-subscription error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
