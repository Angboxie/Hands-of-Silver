// POST /api/checkout  { piece, size, name, email }  →  { url }
// Creates a Stripe Checkout session for one ready-to-order piece and returns the page to send the buyer to.
// Needs STRIPE_SECRET_KEY set in Netlify (Site configuration → Environment variables).
import Stripe from 'stripe';

// Prices are kept here, on the server, so nobody can change what they pay from their browser.
// Keep this in step with ALL in index.html: same names, amounts in cents.
const CATALOG = {
  'Spike Collar':  { amount: 34000, kind: 'Necklaces', image: 'assets/spike-collar.png' },
  'Dagger Drops':  { amount: 12000, kind: 'Earrings',  image: 'assets/daggers.png' },
  'Sanguine':      { amount: 14500, kind: 'Earrings',  image: 'assets/sanguine.png' },
  'Nocturne':      { amount: 11000, kind: 'Earrings',  image: 'assets/spiral3.png' },
  'Double Dagger': { amount: 16500, kind: 'Earrings',  image: 'assets/double-dagger.png' },
  'Seraph':        { amount: 29500, kind: 'Necklaces', image: 'assets/seraph.png' }
};

// the size choices offered by the order form (FITS in index.html)
const SIZES = {
  Necklaces: ['36 cm', '40 cm', '45 cm', 'Not sure'],
  Earrings:  ['4 cm', '7 cm', '11 cm', 'Not sure'],
  Bracelets: ['15 cm', '17 cm', '19 cm', 'Not sure']
};

const CURRENCY = 'aud';
const SHIP_TO = ['AU'];              // countries Checkout will accept a shipping address from
const TAX_CODE = 'txcd_30060007';    // Stripe tax category: Jewelry

const json = (body, status) => new Response(JSON.stringify(body), {
  status: status || 200,
  headers: { 'content-type': 'application/json' }
});

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const key = ((globalThis.Netlify && Netlify.env.get('STRIPE_SECRET_KEY')) || process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) {
    // name the Stripe-looking variables this function can see (never their values), to spot typos and scope problems
    const seen = Object.keys(process.env).filter((k) => /stripe/i.test(k));
    console.error('STRIPE_SECRET_KEY missing; context=' + process.env.CONTEXT + '; stripe-like vars: ' + (seen.join(', ') || 'none'));
    return json({ error: 'Checkout is not set up yet.', debug: { context: process.env.CONTEXT || null, stripeVarsVisible: seen } }, 500);
  }
  if (!/^(sk|rk)_(test|live)_/.test(key)) {
    console.error('STRIPE_SECRET_KEY does not look like a secret key (starts ' + key.slice(0, 3) + ')');
    return json({ error: 'Checkout is not set up yet.', debug: { problem: 'STRIPE_SECRET_KEY is set but is not a secret key (should start sk_test_ or sk_live_)' } }, 500);
  }

  let b;
  try { b = await req.json(); } catch (e) { return json({ error: 'Bad request.' }, 400); }
  const piece = CATALOG[b && b.piece];
  const size = String((b && b.size) || '');
  const name = String((b && b.name) || '').trim().slice(0, 120);
  const email = String((b && b.email) || '').trim();
  if (!piece) return json({ error: 'That piece is not available.' }, 400);
  if (SIZES[piece.kind].indexOf(size) === -1) return json({ error: 'Pick a size.' }, 400);
  if (name.length < 2) return json({ error: 'Add your name.' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return json({ error: 'Add a valid email.' }, 400);

  // Netlify sets URL to the site's main address; fall back to wherever this request came in
  const site = (process.env.URL || new URL(req.url).origin).replace(/\/$/, '');
  const product = { name: b.piece, description: 'Size: ' + size + ' · made to order', tax_code: TAX_CODE };
  if (site.startsWith('https://')) product.images = [site + '/' + piece.image];

  try {
    const stripe = new Stripe(key);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: CURRENCY, unit_amount: piece.amount, product_data: product } }],
      customer_email: email,
      shipping_address_collection: { allowed_countries: SHIP_TO },
      metadata: { piece: b.piece, size: size, name: name },
      payment_intent_data: { metadata: { piece: b.piece, size: size, name: name } },
      success_url: site + '/?paid={CHECKOUT_SESSION_ID}',
      cancel_url: site + '/?cancelled=1'
    });
    return json({ url: session.url });
  } catch (e) {
    console.error('stripe checkout failed:', e && e.message);
    return json({ error: 'Checkout is unavailable right now. Please try again shortly.' }, 502);
  }
};

export const config = { path: '/api/checkout' };
