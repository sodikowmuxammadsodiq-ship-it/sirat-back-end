// server.js — backend for Sirat.
const express = require('express');
const cors = require('cors');
const https = require('https');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(cors());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kadkemtrbvxwwqiekguy.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_SUCCESS_URL = process.env.APP_SUCCESS_URL || 'https://example.com/index.html?subscribed=1';
const APP_CANCEL_URL = process.env.APP_CANCEL_URL || 'https://example.com/index.html';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

app.get('/', (req, res) => {
  res.send(`Sirat backend running. Gemini: ${GEMINI_API_KEY ? 'set' : 'MISSING'}.`);
});

const CLIENT_SECRET = process.env.CLIENT_SECRET || 'sirat-app-2026';
function checkClientSecret(req, res, next) {
  if (req.headers['x-sirat-client'] !== CLIENT_SECRET) {
    return res.status(403).json({ error: { message: 'Not authorized.' } });
  }
  next();
}

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
    } catch (e) {}
  }
  next();
}

const DAILY_LIMIT = 40;
const usage = new Map();
function checkLimit(req, res, next) {
  if (req.isSubscribed) return next();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = usage.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 24 * 60 * 60 * 1000 };
  }
  entry.count++;
  usage.set(ip, entry);
  if (entry.count > DAILY_LIMIT) {
    return res.status(429).json({ error: { message: "You've reached today's free limit." } });
  }
  next();
}

function callGemini(systemPrompt, messages) {
  return new Promise((resolve, reject) => {
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    }));

    const geminiPayload = { contents };
    if (systemPrompt) {
      geminiPayload.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const body = JSON.stringify(geminiPayload);
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message || 'Gemini busy'));
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "I couldn't generate an answer.";
          resolve({ content: [{ type: 'text', text }] });
        } catch (e) {
          reject(new Error('Response parse error'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  res.json({ received: true });
});

app.use(express.json());

app.post('/create-checkout-session', checkClientSecret, identifyUser, async (req, res) => {
  if (!stripe || !STRIPE_PRICE_ID) return res.status(500).json({ error: { message: 'Not setup' } });
  if (!req.user) return res.status(401).json({ error: { message: 'Sign in first' } });
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
    res.status(500).json({ error: { message: 'Error checkout' } });
  }
});

app.post('/ask', checkClientSecret, identifyUser, checkLimit, async (req, res) => {
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  const systemPrompt = req.body.system ? String(req.body.system).slice(0, 4000) : '';

  try {
    const data = await callGemini(systemPrompt, messages);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message || 'Error reaching AI.' } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
