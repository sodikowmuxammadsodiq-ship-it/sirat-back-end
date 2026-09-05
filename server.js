// server.js — a small, simple backend for Sirat.
// This is the ONLY safe place to put your Anthropic API key.
// Your app talks to this server. This server talks to Claude.

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());              // lets your app's HTML talk to this server
app.use(express.json());      // lets this server read JSON messages

// Put your real key in an environment variable — never type it directly here.
const API_KEY = process.env.ANTHROPIC_API_KEY;

app.post('/ask', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body) // forwards whatever your app sent (system prompt, messages, etc.)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong reaching Claude.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sirat backend running on port ${PORT}`));
