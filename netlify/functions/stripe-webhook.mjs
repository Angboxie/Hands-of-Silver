// POST /api/stripe-webhook  (called by Stripe, not the site)
// When a Checkout payment completes, email the order or commission to the business inbox.
// Needs in Netlify env vars:
//   STRIPE_SECRET_KEY      same key the checkout function uses
//   STRIPE_WEBHOOK_SECRET  whsec_… from Stripe → Developers → Webhooks → this endpoint
//   GMAIL_APP_PASSWORD     a Google "app password" for the Gmail account below (needs 2-Step Verification)
//   GMAIL_USER             optional; defaults to the business address
import Stripe from 'stripe';
import nodemailer from 'nodemailer';

const NOTIFY = 'business.handsofsilver@gmail.com';

const env = (k) => ((globalThis.Netlify && Netlify.env.get(k)) || process.env[k] || '').trim();
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const key = env('STRIPE_SECRET_KEY'), whsec = env('STRIPE_WEBHOOK_SECRET');
  if (!key || !whsec) {
    console.error('webhook not configured: ' + (!key ? 'STRIPE_SECRET_KEY ' : '') + (!whsec ? 'STRIPE_WEBHOOK_SECRET' : ''));
    return new Response('Not configured', { status: 500 });
  }

  // the signature is checked against the raw body, so read it as text before anything parses it
  const stripe = new Stripe(key);
  let event;
  try { event = stripe.webhooks.constructEvent(await req.text(), req.headers.get('stripe-signature'), whsec); }
  catch (e) { console.error('bad webhook signature:', e.message); return new Response('Bad signature', { status: 400 }); }

  if (event.type !== 'checkout.session.completed') return new Response('Ignored');
  const s = event.data.object;
  if (s.payment_status !== 'paid') return new Response('Not paid');

  // a failure here returns 500, and Stripe retries the webhook later
  try { await notify(s); }
  catch (e) { console.error('notification email failed:', e.message); return new Response('Email failed', { status: 500 }); }
  return new Response('OK');
};

async function notify(s) {
  const pass = env('GMAIL_APP_PASSWORD');
  if (!pass) throw new Error('GMAIL_APP_PASSWORD is not set');
  const user = env('GMAIL_USER') || NOTIFY;

  const m = s.metadata || {};
  const who = s.customer_details || {};
  const email = who.email || s.customer_email || '';
  const ship = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || null;
  const commission = m.type === 'commission';
  // the same reference the buyer sees on the site after paying
  const ref = 'HOS-' + String(s.id).slice(-6).toUpperCase();
  const paid = '$' + ((s.amount_total || 0) / 100).toFixed(2) + ' ' + String(s.currency || '').toUpperCase();

  const rows = commission
    ? [['Piece', m.piece], ['Edge', m.edge], ['Size', m.size], ['Their idea', m.notes || '(none given)']]
    : [['Piece', m.piece], ['Size', m.size]];
  rows.push(['Name', m.name || who.name], ['Email', email], ['Phone', m.phone || who.phone || '(not given)'],
    [commission ? 'Deposit paid' : 'Paid', paid]);
  if (ship && ship.address) {
    const a = ship.address;
    rows.push(['Ship to', [ship.name, a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ')]);
  }
  rows.push(['Reference', ref]);
  if (s.payment_intent) rows.push(['In Stripe', 'https://dashboard.stripe.com/' + (s.livemode ? '' : 'test/') + 'payments/' + s.payment_intent]);

  const subject = (commission ? 'New commission: ' + m.piece + ' (' + m.edge + ', ' + m.size + ')' : 'New order: ' + m.piece + ' (' + m.size + ')')
    + ' · ' + ref + (s.livemode ? '' : ' [TEST]');
  const next = commission
    ? 'Next: sketch and quote within two working days. Reply to this email to reach them.'
    : 'Next: build it. Reply to this email to reach them.';
  const text = rows.map((r) => r[0] + ': ' + r[1]).join('\n') + '\n\n' + next;
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">'
    + '<h2 style="margin:0 0 12px;font-weight:600">' + esc(commission ? 'New commission deposit' : 'New order') + '</h2>'
    + '<table cellpadding="6" style="border-collapse:collapse">'
    + rows.map((r) => '<tr><td style="color:#666;vertical-align:top;white-space:nowrap">' + esc(r[0]) + '</td><td>'
      + (/^https:\/\//.test(r[1]) ? '<a href="' + esc(r[1]) + '">Open payment</a>' : esc(r[1]).replace(/\n/g, '<br>')) + '</td></tr>').join('')
    + '</table><p style="margin-top:16px;color:#444">' + esc(next) + '</p></div>';

  const mail = nodemailer.createTransport({ service: 'gmail', auth: { user: user, pass: pass } });
  await mail.sendMail({ from: '"Hands of Silver website" <' + user + '>', to: NOTIFY, replyTo: email || undefined, subject: subject, text: text, html: html });
}

export const config = { path: '/api/stripe-webhook' };
