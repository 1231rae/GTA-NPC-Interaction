const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
// Set your Gemini API key as an Environment Variable on onrender.com
// Dashboard > your service > Environment > Add Variable: GEMINI_API_KEY
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY environment variable is not set!');
  console.error('Go to onrender.com > your service > Environment > add GEMINI_API_KEY');
}

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Simple rate limiting (in-memory, per IP)
const requestCounts = {};
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_MINUTE = 30;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!requestCounts[ip]) {
    requestCounts[ip] = { count: 1, resetAt: now + RATE_LIMIT_WINDOW };
  } else {
    if (now > requestCounts[ip].resetAt) {
      requestCounts[ip] = { count: 1, resetAt: now + RATE_LIMIT_WINDOW };
    } else {
      requestCounts[ip].count++;
      if (requestCounts[ip].count > MAX_REQUESTS_PER_MINUTE) {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      }
    }
  }
  next();
}

// --- ROUTES ---

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Gemini proxy is running' });
});

// Main proxy endpoint: POST /gemini
// Body: { "contents": [...], "generationConfig": {...} }
// (same format as Gemini API generateContent)
app.post('/gemini', rateLimit, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server API key not configured' });
    }

    // The model to use (default: gemini-2.0-flash)
    const model = req.body.model || 'gemini-2.0-flash';
    
    // Build the Gemini API URL
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    
    // Forward the request body (contents, generationConfig, etc.)
    const requestBody = {
      contents: req.body.contents || [],
      generationConfig: req.body.generationConfig || { temperature: 0.9, maxOutputTokens: 2048 }
    };
    
    // Add systemInstruction if provided
    if (req.body.systemInstruction) {
      requestBody.systemInstruction = req.body.systemInstruction;
    }
    
    // Add safetySettings if provided
    if (req.body.safetySettings) {
      requestBody.safetySettings = req.body.safetySettings;
    }

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini API error:', data);
      return res.status(response.status).json({ 
        error: 'Gemini API request failed', 
        details: data 
      });
    }

    // Extract the text response
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    res.json({ 
      text: text,
      raw: data 
    });

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Streaming endpoint: POST /gemini/stream
// Returns the response as it streams from Gemini (Server-Sent Events)
app.post('/gemini/stream', rateLimit, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server API key not configured' });
    }

    const model = req.body.model || 'gemini-2.0-flash';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${GEMINI_API_KEY}&alt=sse`;
    
    const requestBody = {
      contents: req.body.contents || [],
      generationConfig: req.body.generationConfig || { temperature: 0.9, maxOutputTokens: 2048 }
    };
    
    if (req.body.systemInstruction) {
      requestBody.systemInstruction = req.body.systemInstruction;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errData = await response.json();
      return res.status(response.status).json({ error: 'Gemini API error', details: errData });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }
    res.end();

  } catch (err) {
    console.error('Stream error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Gemini proxy server running on port ${PORT}`);
});
