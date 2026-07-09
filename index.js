/**
 * Doctorians MDCAT Guide - Quiz Sending Service
 * -------------------------------------------------
 * Sends native WhatsApp Channel Quizzes (question + options + correct answer,
 * with the real red-X/green-check/confetti UI) using the Baileys library.
 *
 * Session persistence:
 * Instead of relying on local disk (which some free hosts wipe on every
 * restart/spin-down), this service can export its login session as a base64
 * string that you save as an environment variable. On startup it reloads
 * from that variable, so you do NOT need to re-scan the QR code every day.
 *
 * ENDPOINTS
 * GET  /qr                     -> shows QR code to scan (only needed once)
 * GET  /session?key=ADMIN_KEY  -> returns the session string to save as SESSION_DATA
 * POST /send-quiz              -> sends one quiz to your channel
 *      headers: x-api-key: API_KEY
 *      body (JSON): { "question": "...", "options": ["...","...","...","..."], "correctIndex": 1 }
 * GET  /health                 -> simple status check
 */

const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  initAuthCreds,
  BufferJSON,
  makeCacheableSignalKeyStore,
} = require('@itsliaaa/baileys');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'change-me';
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-too';
const CHANNEL_ID = process.env.CHANNEL_ID || ''; // e.g. 120363xxxxxxxxxx@newsletter
const SESSION_DATA = process.env.SESSION_DATA || '';

const app = express();
app.use(express.json());

let sock = null;
let latestQR = null;
let isConnected = false;
let inMemoryKeys = {};
let inMemoryCreds = null;

// ---------------- Custom auth state (env-var backed, not disk-backed) ----------------
function loadInitialState() {
  if (SESSION_DATA) {
    try {
      const json = Buffer.from(SESSION_DATA, 'base64').toString('utf-8');
      const parsed = JSON.parse(json, BufferJSON.reviver);
      inMemoryCreds = parsed.creds;
      inMemoryKeys = parsed.keys || {};
      console.log('✅ Loaded existing session from SESSION_DATA env var');
      return;
    } catch (e) {
      console.error('⚠️ Failed to parse SESSION_DATA, starting fresh:', e.message);
    }
  }
  inMemoryCreds = initAuthCreds();
  inMemoryKeys = {};
  console.log('ℹ️ No valid SESSION_DATA found - a fresh QR scan will be needed at /qr');
}

function exportSession() {
  const json = JSON.stringify({ creds: inMemoryCreds, keys: inMemoryKeys }, BufferJSON.replacer);
  return Buffer.from(json).toString('base64');
}

function buildAuthState() {
  const keyStore = {
    get: async (type, ids) => {
      const data = {};
      for (const id of ids) {
        let value = inMemoryKeys[`${type}-${id}`];
        if (value) data[id] = value;
      }
      return data;
    },
    set: async (data) => {
      for (const category in data) {
        for (const id in data[category]) {
          const value = data[category][id];
          const key = `${category}-${id}`;
          if (value) {
            inMemoryKeys[key] = value;
          } else {
            delete inMemoryKeys[key];
          }
        }
      }
    },
  };

  return {
    state: {
      creds: inMemoryCreds,
      keys: makeCacheableSignalKeyStore(keyStore, pino({ level: 'silent' })),
    },
    saveCreds: async () => {
      // creds object is mutated in place by Baileys; nothing else to do here
    },
  };
}

// ---------------- Connect to WhatsApp ----------------
async function connect() {
  loadInitialState();
  const { state, saveCreds } = buildAuthState();

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Doctorians Quiz Bot', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      latestQR = qr;
      isConnected = false;
      console.log('📱 New QR code generated - visit /qr to scan it');
    }

    if (connection === 'open') {
      isConnected = true;
      latestQR = null;
      console.log('✅ Connected to WhatsApp');
      console.log('👉 Visit /session?key=YOUR_ADMIN_KEY to get your session string');
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('❌ Connection closed. Status code:', statusCode);
      // 401 = logged out on the phone side, needs fresh QR. Anything else, retry.
      if (statusCode !== 401) {
        setTimeout(connect, 5000);
      } else {
        console.log('🔒 Logged out - clear SESSION_DATA and rescan QR at /qr');
      }
    }
  });
}

connect().catch((e) => console.error('Fatal connect error:', e));

// ---------------- HTTP endpoints ----------------

app.get('/health', (req, res) => {
  res.json({ ok: true, connected: isConnected });
});

app.get('/qr', async (req, res) => {
  res.send(`
    <html><body style="text-align:center;font-family:sans-serif;padding-top:40px;">
      <h2 id="statusHeading">Scan with WhatsApp → Linked Devices</h2>
      <div id="qrBox"><p>⏳ Loading QR code...</p></div>
      <p style="color:#666;font-size:13px;">This page updates automatically - keep it open while scanning.</p>
      <script>
        let lastQR = null;
        async function poll() {
          try {
            const res = await fetch('/qr-data');
            const data = await res.json();

            if (data.connected) {
              document.getElementById('statusHeading').textContent = '✅ Connected!';
              document.getElementById('qrBox').innerHTML = '<p>Your WhatsApp is linked. You can close this page.</p>';
              return; // stop polling once connected
            }

            if (data.qr && data.qr !== lastQR) {
              lastQR = data.qr;
              document.getElementById('qrBox').innerHTML =
                '<img src="' + data.qr + '" style="width:300px;height:300px;" />';
            } else if (!data.qr) {
              document.getElementById('qrBox').innerHTML = '<p>⏳ Waiting for QR code...</p>';
            }
          } catch (e) {
            // network hiccup, just try again next tick
          }
          setTimeout(poll, 3000);
        }
        poll();
      </script>
    </body></html>
  `);
});

app.get('/qr-data', async (req, res) => {
  if (isConnected) {
    return res.json({ connected: true });
  }
  if (!latestQR) {
    return res.json({ connected: false, qr: null });
  }
  const dataUrl = await QRCode.toDataURL(latestQR);
  res.json({ connected: false, qr: dataUrl });
});

app.get('/session', (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: 'Invalid admin key' });
  }
  if (!isConnected) {
    return res.status(400).json({ ok: false, error: 'Not connected yet - scan the QR at /qr first' });
  }
  res.json({ ok: true, sessionData: exportSession() });
});

app.get('/channel-id', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: 'Invalid admin key' });
  }
  if (!isConnected) {
    return res.status(400).json({ ok: false, error: 'Not connected yet - scan the QR at /qr first' });
  }
  const invite = req.query.invite;
  if (!invite) {
    return res.status(400).json({ ok: false, error: 'Add ?invite=YOUR_INVITE_CODE (the part after whatsapp.com/channel/)' });
  }
  try {
    const metadata = await sock.newsletterMetadata('invite', invite);
    res.json({ ok: true, channelId: metadata.id, name: metadata.name });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/send-quiz', async (req, res) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(403).json({ ok: false, error: 'Invalid API key' });
  }
  if (!isConnected) {
    return res.status(503).json({ ok: false, error: 'WhatsApp not connected right now' });
  }
  if (!CHANNEL_ID) {
    return res.status(500).json({ ok: false, error: 'CHANNEL_ID env var not set' });
  }

  const { question, options, correctIndex } = req.body;
  if (!question || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ ok: false, error: 'question and at least 2 options required' });
  }

  try {
    const pollPayload = {
      name: question,
      values: options,
      selectableCount: 1,
    };
    if (typeof correctIndex === 'number' && correctIndex >= 0 && options[correctIndex]) {
      pollPayload.correctAnswer = options[correctIndex];
    }

    const sent = await sock.sendMessage(CHANNEL_ID, { poll: pollPayload });
    res.json({ ok: true, messageId: sent?.key?.id || null });
  } catch (e) {
    console.error('Send error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Quiz service listening on port ${PORT}`);
});
