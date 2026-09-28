/* ══════════════════════════════════════════════════════════════════
   netlify/functions/lib/constants.js

   Single source of truth for the $49 one-time audit's base price.
   Previously this was hardcoded separately in create-payment-intent.js
   AND apply-coupon.js AND checkout.html (three places that had to be
   kept in sync by hand). Now every server-side function imports it
   from here. checkout.html still keeps its own copy for the pre-load
   display before the server responds, but every number that actually
   drives a charge comes from the server.
   ══════════════════════════════════════════════════════════════════ */

module.exports = {
  BASE_AMOUNT: 4900,  // $49.00 in cents
  CURRENCY: 'usd',
};
