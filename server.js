// server.js — a small, simple backend for Sirat.
// This is the ONLY safe place to put your Anthropic API key.
// Your app talks to this server. This server talks to Claude.

const express = require('express');
const cors = require('cors');
const https = require('https');
const app = express();

app.use(cors());
app.use(express.json());

const API_KEY = process.env.ANTHROPIC_API_KEY;

app.get('/', (req, res) => {
  res.send(`Sirat backend is running. API key is ${API_KEY ? 'set' : 'MISSING'}.`);
});

// --- A shared "client secret" that only your own app's HTML knows. This  ---
// --- is NOT real authentication (anyone could read it from your app's   ---
// --- source code) — but it stops random scripts and scanners that never ---
// --- looked at your app from hitting this endpoint at all. Combined     ---
// --- with the daily limit below, it meaningfully raises the bar.        ---
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'sirat-app-2026';

function checkClientSecret(req, res, next) {
  if (req.headers['x-sirat-client'] !== CLIENT_SECRET) {
    return res.status(403).json({ error: { message: 'Not authorized.' } });
  }
  next();
}

// --- Simple daily limit per visitor, to stop one person or a bot from ---
// --- burning through your API credits. Resets naturally after 24h.   ---
const DAILY_LIMIT = 40; // max questions per visitor per day — raise/lower as you like
const usage = new Map(); // ip -> { count, resetAt }

function checkLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = usage.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 24 * 60 * 60 * 1000 };
  }
  entry.count++;
  usage.set(ip, entry);
  if (entry.count > DAILY_LIMIT) {
    return res.status(429).json({ error: { message: "You've reached today's question limit. Please try again tomorrow." } });
  }
  next();
}

// Uses Node's built-in https module directly, instead of fetch() —
// more reliable for outbound HTTPS calls on some free hosting platforms.
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

app.post('/ask', checkClientSecret, checkLimit, async (req, res) => {
  console.log('Received a question at', new Date().toISOString());

  // Don't blindly trust the client — only forward the fields Sirat actually
  // needs, with sane limits, so a modified/malicious request can't rack up
  // cost by asking for a huge token count or an unapproved model.
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
