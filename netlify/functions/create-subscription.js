// netlify/functions/create-subscription.js
//
// Backend for checkout-boost.html ($999/mo BroDop Boost AI subscription).
// Creates:
//   1. A Stripe Customer (or reuses an existing one — see idempotency note below)
//   2. A Subscription on that customer, using your $999/mo Price
//   3. Returns the clientSecret of the first invoice's PaymentIntent, which
//      is what checkout-boost.html uses with stripe.confirmPayment()
//
// Required environment variables (Netlify → Site settings → Environment variables):
//   STRIPE_SECRET_KEY      -> sk_live_... (Developers → API keys → Secret key)
//   STRIPE_BOOST_PRICE_ID  -> price_...  (the recurring $999/mo Price you create
//                                          in Stripe Dashboard → Product catalog →
//                                          "BroDop Boost AI" → add a recurring price)
//
// ── IDEMPOTENCY ────────────────────────────────────────────────────
// Without a guard, every page load / retry (e.g. a refresh during Amex
// 3D Secure friction, or the person hitting back/forward) would create a
// BRAND NEW Customer + Subscription every time. That leaves stray
// "Incomplete" subscriptions sitting in Stripe, and can make it look like
// a payment never went through when in fact an EARLIER attempt for the
// same person already succeeded and fired the webhook — which is exactly
// what produces "Clay shows Confirmed but Stripe shows Incomplete": you're
// looking at two different subscription objects.
//
// Fix: look up the customer by email first. If they already have an
// "incomplete" subscription open on this exact price, reuse it (and its
// existing invoice/clientSecret) instead of creating a new one.

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

    // Metadata gets stamped on the customer + subscription so your webhook
    // can read lead info back (via the customer record), same as the $49
    // flow does today via PaymentIntent metadata.
    const metadata = {
      firstName: firstName,
      business:  business,
      phone:     phone,
      city:      city,
      website:   website,
      product:   'BroDop Boost AI',
    };

    // 1. Find or create the customer
    let customer;
    const existingCustomers = await stripe.customers.list({ email: email, limit: 1 });

    if (existingCustomers.data.length > 0) {
      customer = await stripe.customers.update(existingCustomers.data[0].id, {
        name: firstName + ' ' + business,
        phone: phone || undefined,
        metadata: metadata,
      });
    } else {
      customer = await stripe.customers.create({
        email: email,
        name: firstName + ' ' + business,
        phone: phone || undefined,
        metadata: metadata,
      });
    }

    // 2. Reuse an existing "incomplete" subscription for this customer/price
    //    if one is already open (see idempotency note above), otherwise
    //    create a fresh one.
    let subscription;
    const existingSubs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'incomplete',
      price: priceId,
      limit: 1,
    });

    if (existingSubs.data.length > 0) {
      console.log('[create-subscription] Reusing existing incomplete subscription for', email);
      subscription = await stripe.subscriptions.retrieve(existingSubs.data[0].id, {
        expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payment_intent'],
      });
    } else {
      console.log('[create-subscription] Creating new subscription for', email);
      subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: priceId }],
        payment_behavior: 'default_incomplete',
        payment_settings: {
          save_default_payment_method: 'on_subscription',
          payment_method_types: ['card'],
        },
        // NOTE: Stripe has two ways an invoice exposes its client secret,
        // depending on your account's API version:
        //   - Newer accounts: invoice.confirmation_secret.client_secret
        //   - Older accounts: invoice.payment_intent.client_secret
        // We expand both and use whichever is present.
        expand: ['latest_invoice.confirmation_secret', 'latest_invoice.payment_intent'],
        metadata: metadata,
      });
    }

    const clientSecret = extractClientSecret(subscription);

    if (!clientSecret) {
      console.error('[create-subscription] No client secret found on invoice:', JSON.stringify(subscription.latest_invoice));
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Could not retrieve a payment client secret from the invoice.' }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        clientSecret:   clientSecret,
        subscriptionId: subscription.id,
        customerId:     customer.id,
      }),
    };

  } catch (err) {
    console.error('[create-subscription] error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
