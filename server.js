// server.js — backend for Sirat.
// Holds the Anthropic API key, now also handles Stripe payments and
// checking subscription status via Supabase.

const express = require('express');
const cors = require('cors');
const https = require('https');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(cors());

const API_KEY = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kadkemtrbvxwwqiekguy.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Where Stripe sends people back to after paying. Update these once the
// app is hosted somewhere real (e.g. Netlify) — for now they default to
// a placeholder so the server doesn't crash without them set.
const APP_SUCCESS_URL = process.env.APP_SUCCESS_URL || 'https://example.com/index.html?subscribed=1';
const APP_CANCEL_URL = process.env.APP_CANCEL_URL || 'https://example.com/index.html';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

app.get('/', (req, res) => {
  res.send(
    `Sirat backend is running. ` +
    `Anthropic key: ${API_KEY ? 'set' : 'MISSING'}. ` +
    `Stripe: ${stripe ? 'set' : 'MISSING'}. ` +
    `Supabase: ${supabaseAdmin ? 'set' : 'MISSING'}.`
  );
});

// --- A shared "client secret" that only your own app's HTML knows. ---
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'sirat-app-2026';
function checkClientSecret(req, res, next) {
  if (req.headers['x-sirat-client'] !== CLIENT_SECRET) {
    return res.status(403).json({ error: { message: 'Not authorized.' } });
  }
  next();
}

// --- Figure out who's asking: reads the Supabase login token (if any) ---
// --- sent by the frontend, and looks up whether they're subscribed.   ---
async function identifyUser(req, res, next) {
  req.user = null;
  req.isSubscribed = false;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ') && supabaseAdmin) {
    const token = authHeader.slice(7);
    try {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (!error && data.user) {
        req.user = data.user;
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('is_subscribed')
          .eq('id', data.user.id)
          .single();
        req.isSubscribed = !!(profile && profile.is_subscribed);
      }
    } catch (e) {
      console.error('Could not verify user token:', e.message);
    }
  }
  next();
}

// --- Daily limit per visitor — skipped entirely for subscribed users. ---
const DAILY_LIMIT = 40;
const usage = new Map();
function checkLimit(req, res, next) {
  if (req.isSubscribed) return next(); // unlimited for subscribers
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = usage.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 24 * 60 * 60 * 1000 };
  }
  entry.count++;
  usage.set(ip, entry);
  if (entry.count > DAILY_LIMIT) {
    return res.status(429).json({ error: { message: "You've reached today's free question limit. Sign in and subscribe for unlimited questions." } });
  }
  next();
}

function callClaude(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Could not parse Claude response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// --- Stripe webhook: Stripe calls this itself when a payment happens. ---
// --- Must read the RAW body (not JSON-parsed) to verify the signature. ---
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET || !supabaseAdmin) {
    return res.status(500).send('Webhook not configured.');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      if (userId) {
        await supabaseAdmin.from('profiles').update({
          is_subscribed: true,
          stripe_customer_id: session.customer
        }).eq('id', userId);
        console.log('Marked user as subscribed:', userId);
      }
    } else if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const isActive = sub.status === 'active' || sub.status === 'trialing';
      await supabaseAdmin.from('profiles').update({ is_subscribed: isActive }).eq('stripe_customer_id', sub.customer);
      console.log('Updated subscription status for customer:', sub.customer, isActive);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Error handling webhook:', err.message);
    res.status(500).send('Webhook handler error.');
  }
});

// Everything below this line reads JSON normally.
app.use(express.json());

// --- Starts a Stripe Checkout session — the frontend redirects the ---
// --- person here to actually pay.                                  ---
app.post('/create-checkout-session', checkClientSecret, identifyUser, async (req, res) => {
  if (!stripe || !STRIPE_PRICE_ID) {
    return res.status(500).json({ error: { message: 'Payments are not set up yet.' } });
  }
  if (!req.user) {
    return res.status(401).json({ error: { message: 'Please sign in first.' } });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: req.user.id,
      customer_email: req.user.email,
      success_url: APP_SUCCESS_URL,
      cancel_url: APP_CANCEL_URL
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Error creating checkout session:', err.message);
    res.status(500).json({ error: { message: 'Could not start checkout.' } });
  }
});

app.post('/ask', checkClientSecret, identifyUser, checkLimit, async (req, res) => {
  console.log('Received a question at', new Date().toISOString(), '| subscribed:', req.isSubscribed);

  const ALLOWED_MODELS = ['claude-sonnet-4-6'];
  const model = ALLOWED_MODELS.includes(req.body.model) ? req.body.model : ALLOWED_MODELS[0];
  const max_tokens = Math.min(Number(req.body.max_tokens) || 700, 1000);
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  const payload = { model, max_tokens, messages };
  if (req.body.system) payload.system = String(req.body.system).slice(0, 4000);

  try {
    const data = await callClaude(payload);
    res.json(data);
  } catch (err) {
    console.error('Server error while asking Claude:', err.message);
    res.status(500).json({ error: 'Something went wrong reaching Claude.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sirat backend running on port ${PORT}`));
