// POST /api/checkout  →  { url }
//   shop order:  { type: 'order', piece, size, name, email, phone? }
//   commission:  { type: 'commission', piece, edge, size, name, email, phone, notes? }   ($5 deposit)
// Creates a Stripe Checkout session and returns the page to send the buyer to.
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

// Commissions: a flat deposit holds the buyer's place; the rest is quoted after the sketch.
const DEPOSIT = 500;
const COMMISSION_PIECES = ['Necklace', 'Earrings', 'Bracelet', 'A set'];
const EDGES = ['Soft', 'Sharp', 'Feral'];

// the size choices offered by the order form (FITS in index.html)
const NECK = ['36 cm', '40 cm', '45 cm', 'Not sure'];
const EARS = ['4 cm', '7 cm', '11 cm', 'Not sure'];
const WRIST = ['15 cm', '17 cm', '19 cm', 'Not sure'];
const SIZES = {
  Necklaces: NECK, Necklace: NECK, Earrings: EARS, Bracelets: WRIST, Bracelet: WRIST,
  'A set': ['Petite', 'Standard', 'Generous', 'Not sure']
};

const CURRENCY = 'aud';
const SHIP_TO = ['AU'];              // countries Checkout will accept a shipping address from
const TAX_CODE = 'txcd_30060007';    // Stripe tax category: Jewelry

const json = (body, status) => new Response(JSON.stringify(body), {
  status: status || 200,
  headers: { 'content-type': 'application/json' }
});
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

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
  b = b || {};
  const commission = b.type === 'commission';
  const name = str(b.name, 120);
  const email = str(b.email, 200);
  const phone = str(b.phone, 40);
  const size = str(b.size, 40);
  if (name.length < 2) return json({ error: 'Add your name.' }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Add a valid email.' }, 400);
  const phoneOk = /^[+\d\s().-]+$/.test(phone) && phone.replace(/\D/g, '').length >= 8 && phone.replace(/\D/g, '').length <= 15;
  if ((commission || phone) && !phoneOk) return json({ error: 'Add a valid phone number.' }, 400);

  // Netlify sets URL to the site's main address; fall back to wherever this request came in
  const site = (process.env.URL || new URL(req.url).origin).replace(/\/$/, '');
  let item, meta, extra = {};

  if (commission) {
    const piece = str(b.piece, 40), edge = str(b.edge, 20), notes = str(b.notes, 450);
    if (COMMISSION_PIECES.indexOf(piece) === -1) return json({ error: 'Pick what we are making.' }, 400);
    if (EDGES.indexOf(edge) === -1) return json({ error: 'Pick how sharp.' }, 400);
    if (SIZES[piece].indexOf(size) === -1) return json({ error: 'Pick a size.' }, 400);
    item = { quantity: 1, price_data: { currency: CURRENCY, unit_amount: DEPOSIT, product_data: {
      name: 'Commission deposit: ' + piece,
      description: edge + ' · ' + size + ' · holds your place; the piece is quoted after the sketch',
      tax_code: TAX_CODE
    } } };
    meta = { type: 'commission', piece: piece, edge: edge, size: size, name: name, phone: phone, notes: notes };
  } else {
    const piece = CATALOG[b.piece];
    if (!piece) return json({ error: 'That piece is not available.' }, 400);
    if (SIZES[piece.kind].indexOf(size) === -1) return json({ error: 'Pick a size.' }, 400);
    const product = { name: b.piece, description: 'Size: ' + size + ' · made to order', tax_code: TAX_CODE };
    if (site.startsWith('https://')) product.images = [site + '/' + piece.image];
    item = { quantity: 1, price_data: { currency: CURRENCY, unit_amount: piece.amount, product_data: product } };
    meta = { type: 'order', piece: b.piece, size: size, name: name, phone: phone };
    extra = { shipping_address_collection: { allowed_countries: SHIP_TO } };
  }

  try {
    const stripe = new Stripe(key);
    const session = await stripe.checkout.sessions.create(Object.assign({
      mode: 'payment',
      line_items: [item],
      customer_email: email,
      metadata: meta,
      payment_intent_data: { metadata: meta },
      success_url: site + '/?paid={CHECKOUT_SESSION_ID}',
      cancel_url: site + '/?cancelled=1'
    }, extra));
    return json({ url: session.url });
  } catch (e) {
    console.error('stripe checkout failed:', e && e.message);
    return json({ error: 'Checkout is unavailable right now. Please try again shortly.' }, 502);
  }
};

export const config = { path: '/api/checkout' };
