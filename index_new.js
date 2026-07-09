/**
 * Doctorians MDCAT Guide - WhatsApp Channel Quiz Service
 * ✅ Session persistence (scan ONCE, never again)
 * ✅ Auto channel ID detection
 * ✅ Stable QR code (WhatsApp compatible)
 * ✅ Native WhatsApp Channel Quizzes
 */

const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { 
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

// ==================== CONFIGURATION ====================
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'doctorians-quiz-2024';
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-secret-key';
const CHANNEL_ID = process.env.CHANNEL_ID || ''; // Will auto-detect if empty
const SESSION_DATA = process.env.SESSION_DATA || ''; // Base64 session string

const app = express();
app.use(express.json());

// ==================== GLOBAL STATE ====================
let sock = null;
let isConnected = false;
let qrCodeData = null;
let qrGeneratedAt = null;
let connectionAttempts = 0;
const MAX_RECONNECT = 10;

// Auth directories for persistence
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const SESSION_FILE = path.join(__dirname, 'session_backup.json');

// Ensure directories exist
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// ==================== SESSION PERSISTENCE ====================

/**
 * Save session to base64 string (for env variable)
 */
function exportSessionToBase64() {
  try {
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) return null;
    
    const credsData = fs.readFileSync(credsPath, 'utf8');
    const encoded = Buffer.from(credsData).toString('base64');
    
    // Also save local backup
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      encoded,
      timestamp: new Date().toISOString()
    }));
    
    return encoded;
  } catch (e) {
    console.error('❌ Session export error:', e.message);
    return null;
  }
}

/**
 * Load session from env variable or file
 */
function importSessionFromBase64() {
  try {
    // Try SESSION_DATA env var first
    if (SESSION_DATA && SESSION_DATA.length > 10) {
      const decoded = Buffer.from(SESSION_DATA, 'base64').toString('utf8');
      const credsPath = path.join(AUTH_DIR, 'creds.json');
      fs.writeFileSync(credsPath, decoded);
      console.log('✅ Session loaded from SESSION_DATA env var');
      return true;
    }
    
    // Try local backup file
    if (fs.existsSync(SESSION_FILE)) {
      const backup = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (backup.encoded) {
        const decoded = Buffer.from(backup.encoded, 'base64').toString('utf8');
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        fs.writeFileSync(credsPath, decoded);
        console.log('✅ Session loaded from local backup');
        console.log('📅 Backup from:', backup.timestamp);
        return true;
      }
    }
    
    return false;
  } catch (e) {
    console.error('❌ Session import error:', e.message);
    return false;
  }
}

// ==================== WHATSAPP CONNECTION ====================

async function connectToWhatsApp() {
  try {
    // Load saved session if available
    if (!importSessionFromBase64()) {
      console.log('ℹ️ No saved session found - fresh QR scan required');
    }
    
    // Initialize auth state (persists to disk)
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    // Get latest Baileys version
    const { version } = await fetchLatestBaileysVersion();
    console.log(`🔧 Baileys v${version.join('.')}`);

    // Create socket with optimized settings
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'warn' }),
      browser: Browsers.macOS('Chrome'),
      connectTimeoutMs: 60000,
      qrTimeout: 120000, // QR valid for 2 minutes
      defaultQueryTimeoutMs: 60000,
      generateHighQualityLinkPreview: true,
      markOnlineOnConnect: true,
      syncFullHistory: false,
    });

    // Handle connection events
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR Code received - display it
      if (qr) {
        qrCodeData = qr;
        qrGeneratedAt = Date.now();
        isConnected = false;
        console.log('📱 QR Code ready - visit /qr');
        console.log('⏰ Valid for 2 minutes');
        console.log('🔗 QR URL:', `http://localhost:${PORT}/qr`);
      }

      // Connection opened successfully
      if (connection === 'open') {
        isConnected = true;
        qrCodeData = null;
        connectionAttempts = 0;
        
        console.log('✅ WhatsApp Connected!');
        console.log('💾 Session saved to disk');
        
        // Export session for env var
        const sessionStr = exportSessionToBase64();
        if (sessionStr) {
          console.log('📋 SESSION_DATA (save this as env var):');
          console.log('─'.repeat(50));
          console.log(sessionStr.substring(0, 50) + '...');
          console.log('─'.repeat(50));
          console.log('👉 Visit /session?key=YOUR_ADMIN_KEY for full string');
        }
        
        // Auto-detect channel if not set
        if (!CHANNEL_ID) {
          await detectAndSetChannel();
        } else {
          console.log(`📢 Channel: ${CHANNEL_ID}`);
        }
      }

      // Connection closed
      if (connection === 'close') {
        isConnected = false;
        qrCodeData = null;
        
        const statusCode = lastDisconnect?.error instanceof Boom 
          ? lastDisconnect.error.output.statusCode 
          : undefined;
        
        console.log('❌ Disconnected - Status:', statusCode);

        // Logged out - clear session and restart
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('🔒 Logged out! Clearing session...');
          clearSession();
          console.log('🔄 Restarting with fresh QR...');
          setTimeout(connectToWhatsApp, 5000);
          return;
        }

        // Reconnect with exponential backoff
        if (connectionAttempts < MAX_RECONNECT) {
          connectionAttempts++;
          const delay = Math.min(1000 * Math.pow(2, connectionAttempts), 30000);
          console.log(`🔄 Reconnecting in ${delay/1000}s (${connectionAttempts}/${MAX_RECONNECT})`);
          setTimeout(connectToWhatsApp, delay);
        } else {
          console.log('❌ Max reconnection attempts reached');
        }
      }
    });

    // Save credentials automatically
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      // Auto-backup session every time creds update
      exportSessionToBase64();
    });

    // Log incoming messages for debugging
    sock.ev.on('messages.upsert', (m) => {
      const msg = m.messages[0];
      if (!msg.key.fromMe && m.type === 'notify') {
        console.log('📨 Message from:', msg.key.remoteJid);
      }
    });

  } catch (error) {
    console.error('❌ Connection error:', error.message);
    isConnected = false;
    qrCodeData = null;
    setTimeout(connectToWhatsApp, 10000);
  }
}

// ==================== CHANNEL DETECTION ====================

async function detectAndSetChannel() {
  if (!sock || !isConnected) return;
  
  try {
    console.log('🔍 Detecting your channels...');
    const newsletters = await sock.newsletterSubscribed();
    
    if (newsletters && newsletters.length > 0) {
      // Show all channels
      console.log('📢 Your Channels:');
      newsletters.forEach((ch, i) => {
        console.log(`  ${i + 1}. ${ch.name} - ${ch.id}`);
      });
      
      // If only one channel, suggest it
      if (newsletters.length === 1) {
        console.log('💡 Tip: Set env var CHANNEL_ID=' + newsletters[0].id);
        console.log('   Currently using first channel as default');
        process.env.CHANNEL_ID = newsletters[0].id;
      }
    } else {
      console.log('⚠️ No channels found. Create a WhatsApp Channel first!');
      console.log('   Then set CHANNEL_ID env var manually');
    }
  } catch (e) {
    console.error('⚠️ Channel detection error:', e.message);
    console.log('   Set CHANNEL_ID env var manually');
  }
}

function clearSession() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
    console.log('🗑️ Session cleared');
  } catch (e) {
    console.error('❌ Error clearing session:', e.message);
  }
}

// ==================== HTTP ENDPOINTS ====================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    ok: true, 
    connected: isConnected,
    channelId: CHANNEL_ID || process.env.CHANNEL_ID || 'NOT SET',
    uptime: Math.floor(process.uptime()),
    session: SESSION_DATA ? 'SAVED' : 'NONE'
  });
});

// QR Code page (STABLE - doesn't change every 5 seconds)
app.get('/qr', async (req, res) => {
  // Already connected
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Connected - Doctorians</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #0f2f5f 0%, #1e4a8a 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            text-align: center;
          }
          .card {
            background: white;
            padding: 50px 40px;
            border-radius: 24px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 400px;
            width: 90%;
          }
          .icon { font-size: 80px; margin-bottom: 20px; }
          h1 { color: #16a34a; font-size: 24px; margin-bottom: 10px; }
          p { color: #64748b; font-size: 15px; line-height: 1.6; }
          .info { 
            margin-top: 20px;
            padding: 15px;
            background: #f0fdf4;
            border-radius: 12px;
            font-size: 13px;
            color: #15803d;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✅</div>
          <h1>WhatsApp Connected!</h1>
          <p>Your quiz service is ready.<br>You can close this page.</p>
          <div class="info">
            Session saved — no need to scan again!<br>
            Start sending quizzes from your dashboard.
          </div>
        </div>
      </body>
      </html>
    `);
  }

  // Loading state (QR not generated yet)
  if (!qrCodeData) {
    const waitTime = connectionAttempts > 0 ? 'Reconnecting...' : 'Generating QR Code...';
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Loading QR - Doctorians</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Segoe UI', sans-serif;
            background: #f1f5f9;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
          }
          .card {
            background: white;
            padding: 40px;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            text-align: center;
          }
          .spinner {
            width: 50px;
            height: 50px;
            border: 5px solid #e2e8f0;
            border-top: 5px solid #1e4a8a;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 20px auto;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          h2 { color: #1e293b; margin-bottom: 10px; }
          p { color: #64748b; font-size: 14px; }
          .auto-refresh {
            margin-top: 15px;
            font-size: 12px;
            color: #94a3b8;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>⏳ ${waitTime}</h2>
          <div class="spinner"></div>
          <p>Please wait while we prepare your QR code...</p>
          <p class="auto-refresh">This page refreshes automatically</p>
        </div>
        <script>
          setTimeout(() => location.reload(), 3000);
        </script>
      </body>
      </html>
    `);
  }

  // Generate QR code image
  try {
    const qrImage = await QRCode.toDataURL(qrCodeData);
    const secondsRemaining = Math.max(0, Math.floor((120000 - (Date.now() - qrGeneratedAt)) / 1000));
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Scan QR Code - Doctorians</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #0f2f5f 0%, #1e4a8a 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
          }
          .card {
            background: white;
            padding: 35px 30px;
            border-radius: 24px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 420px;
            width: 100%;
            text-align: center;
          }
          h2 { 
            color: #1e293b; 
            font-size: 20px; 
            margin-bottom: 5px;
            font-weight: 700;
          }
          .subtitle {
            color: #64748b;
            font-size: 13px;
            margin-bottom: 20px;
          }
          .qr-container {
            background: #f8fafc;
            padding: 20px;
            border-radius: 16px;
            display: inline-block;
            margin: 10px 0;
            border: 2px solid #e2e8f0;
          }
          img { 
            width: 280px; 
            height: 280px; 
            display: block;
            image-rendering: pixelated;
          }
          .timer {
            color: #ef4444;
            font-size: 13px;
            font-weight: 600;
            margin: 10px 0;
          }
          .steps {
            text-align: left;
            background: #f8fafc;
            padding: 20px;
            border-radius: 12px;
            margin-top: 20px;
          }
          .step {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 10px 0;
            font-size: 14px;
            color: #475569;
          }
          .step-number {
            background: linear-gradient(135deg, #0f2f5f, #1e4a8a);
            color: white;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 13px;
            font-weight: 700;
            flex-shrink: 0;
          }
          .refresh-btn {
            display: inline-block;
            margin-top: 15px;
            padding: 12px 24px;
            background: linear-gradient(135deg, #0f2f5f, #1e4a8a);
            color: white;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            text-decoration: none;
            transition: transform 0.2s;
          }
          .refresh-btn:hover {
            transform: translateY(-1px);
          }
          .note {
            color: #94a3b8;
            font-size: 11px;
            margin-top: 15px;
            font-style: italic;
          }
          @media (max-width: 480px) {
            .card { padding: 25px 20px; }
            img { width: 240px; height: 240px; }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>📱 Scan QR Code</h2>
          <p class="subtitle">Link your WhatsApp account</p>
          
          <div class="qr-container">
            <img src="${qrImage}" alt="WhatsApp QR Code">
          </div>
          
          <div class="timer" id="timer">
            ⏰ QR expires in: ${secondsRemaining} seconds
          </div>
          
          <div class="steps">
            <div class="step">
              <span class="step-number">1</span>
              <span>Open <strong>WhatsApp</strong> on your phone</span>
            </div>
            <div class="step">
              <span class="step-number">2</span>
              <span>Go to <strong>Settings → Linked Devices</strong></span>
            </div>
            <div class="step">
              <span class="step-number">3</span>
              <span>Tap <strong>Link a Device</strong></span>
            </div>
            <div class="step">
              <span class="step-number">4</span>
              <span>Point your phone at this QR code</span>
            </div>
          </div>
          
          <a href="/qr" class="refresh-btn">🔄 Refresh QR Code</a>
          <p class="note">Scan once — session persists automatically!<br>No daily re-scanning needed.</p>
        </div>
        
        <script>
          // Countdown timer
          let timeLeft = ${secondsRemaining};
          const timerEl = document.getElementById('timer');
          
          const countdown = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
              clearInterval(countdown);
              timerEl.textContent = '⚠️ QR Expired - Refreshing...';
              timerEl.style.color = '#dc2626';
              setTimeout(() => location.reload(), 2000);
            } else {
              timerEl.textContent = '⏰ QR expires in: ' + timeLeft + ' seconds';
              if (timeLeft < 30) {
                timerEl.style.color = '#ef4444';
              }
            }
          }, 1000);
          
          // Auto-check if connected
          setInterval(async () => {
            try {
              const res = await fetch('/health');
              const data = await res.json();
              if (data.connected) {
                location.reload();
              }
            } catch (e) {}
          }, 5000);
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send('<h1>Error generating QR code</h1><p>Please refresh the page.</p>');
  }
});

// QR Data API endpoint (for custom UIs)
app.get('/qr-data', async (req, res) => {
  if (isConnected) {
    return res.json({ connected: true, qr: null });
  }
  
  if (!qrCodeData) {
    return res.json({ connected: false, qr: null, message: 'QR not ready yet' });
  }
  
  try {
    const qrImage = await QRCode.toDataURL(qrCodeData);
    res.json({ 
      connected: false, 
      qr: qrImage,
      expiresIn: Math.max(0, Math.floor((120000 - (Date.now() - qrGeneratedAt)) / 1000))
    });
  } catch (e) {
    res.json({ connected: false, qr: null, error: e.message });
  }
});

// Get session data (for env variable)
app.get('/session', (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: 'Invalid admin key' });
  }
  
  if (!isConnected) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Not connected yet. Scan QR at /qr first' 
    });
  }
  
  const sessionStr = exportSessionToBase64();
  
  if (!sessionStr) {
    return res.status(500).json({ ok: false, error: 'Failed to export session' });
  }
  
  res.json({ 
    ok: true, 
    sessionData: sessionStr,
    length: sessionStr.length,
    note: 'Save this as SESSION_DATA env variable on your hosting platform',
    tip: 'This allows the service to reconnect without scanning QR again'
  });
});

// Get channel ID from invite link
app.get('/get-channel-id', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: 'Invalid admin key' });
  }
  
  if (!isConnected || !sock) {
    return res.status(503).json({ 
      ok: false, 
      error: 'WhatsApp not connected. Visit /qr first' 
    });
  }
  
  const inviteCode = req.query.invite;
  
  if (!inviteCode) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Please provide invite code',
      example: '/get-channel-id?key=ADMIN_KEY&invite=0029VaXXXXXX',
      help: 'Get invite code from: WhatsApp Channel → Share → Copy Link → Use the code after /channel/'
    });
  }
  
  try {
    console.log('🔍 Fetching channel info for invite:', inviteCode);
    const metadata = await sock.newsletterMetadata('invite', inviteCode);
    
    res.json({ 
      ok: true, 
      channelId: metadata.id,
      channelName: metadata.name || 'Unknown',
      description: metadata.description || '',
      subscriberCount: metadata.subscribers || 0,
      setEnvVar: `Set this as environment variable: CHANNEL_ID=${metadata.id}`
    });
    
    console.log('✅ Channel found:', metadata.id, '-', metadata.name);
  } catch (e) {
    console.error('❌ Channel fetch error:', e.message);
    res.status(500).json({ 
      ok: false, 
      error: e.message,
      tip: 'Make sure the invite code is correct and you are an admin of this channel',
      alternativeMethod: 'You can also find channel ID from WhatsApp Web URL'
    });
  }
});

// List all your channels
app.get('/my-channels', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: 'Invalid admin key' });
  }
  
  if (!isConnected || !sock) {
    return res.status(503).json({ ok: false, error: 'WhatsApp not connected' });
  }
  
  try {
    const newsletters = await sock.newsletterSubscribed();
    
    const channels = newsletters.map(ch => ({
      id: ch.id,
      name: ch.name || 'Unnamed',
      description: ch.description || '',
      subscribers: ch.subscribers || 0,
      role: ch.role || 'member'
    }));
    
    res.json({ 
      ok: true, 
      count: channels.length,
      channels: channels,
      tip: 'Use the channel ID with CHANNEL_ID env var'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==================== QUIZ SENDING ENDPOINTS ====================

// Send single native WhatsApp quiz
app.post('/send-quiz', async (req, res) => {
  // API key verification
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(403).json({ ok: false, error: 'Invalid API key' });
  }
  
  // Connection check
  if (!isConnected || !sock) {
    return res.status(503).json({ 
      ok: false, 
      error: 'WhatsApp not connected',
      action: 'Visit /qr to scan QR code and connect'
    });
  }
  
  // Channel check
  const channelId = CHANNEL_ID || process.env.CHANNEL_ID;
  if (!channelId) {
    return res.status(500).json({ 
      ok: false, 
      error: 'Channel ID not set',
      action: 'Use /get-channel-id endpoint or set CHANNEL_ID env var'
    });
  }

  const { question, options, correctIndex } = req.body;
  
  // Validation
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Question text is required' });
  }
  
  if (!Array.isArray(options) || options.length < 2 || options.length > 10) {
    return res.status(400).json({ ok: false, error: 'Options must be an array of 2-10 strings' });
  }
  
  // Clean options (remove empty/null)
  const cleanOptions = options.filter(opt => opt && typeof opt === 'string' && opt.trim().length > 0);
  
  if (cleanOptions.length < 2) {
    return res.status(400).json({ ok: false, error: 'At least 2 non-empty options required' });
  }

  try {
    // Build native WhatsApp poll (quiz mode)
    const pollPayload = {
      poll: {
        name: question.trim(),
        values: cleanOptions.map(opt => opt.trim()),
        selectableCount: 1,
      }
    };

    // Add correct answer for quiz mode (shows ✅/❌ after answering)
    if (typeof correctIndex === 'number' && 
        correctIndex >= 0 && 
        correctIndex < cleanOptions.length) {
      pollPayload.poll.correctAnswer = cleanOptions[correctIndex].trim();
    }

    console.log('📤 Sending quiz:', question.substring(0, 60) + '...');
    console.log('   Options:', cleanOptions.length);
    console.log('   Correct answer:', correctIndex >= 0 ? cleanOptions[correctIndex] : 'None');
    
    const sent = await sock.sendMessage(channelId, pollPayload);
    
    console.log('✅ Quiz sent! ID:', sent?.key?.id);
    
    res.json({ 
      ok: true, 
      messageId: sent?.key?.id || null,
      question: question,
      optionsCount: cleanOptions.length,
      hasCorrectAnswer: correctIndex >= 0
    });
  } catch (e) {
    console.error('❌ Send error:', e.message);
    res.status(500).json({ 
      ok: false, 
      error: e.message || 'Failed to send quiz',
      tip: 'Check if your channel ID is correct and you have admin rights'
    });
  }
});

// Bulk send quizzes (what you need for your MCQs!)
app.post('/send-bulk-quiz', async (req, res) => {
  // API key check
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(403).json({ ok: false, error: 'Invalid API key' });
  }
  
  // Connection check
  if (!isConnected || !sock) {
    return res.status(503).json({ 
      ok: false, 
      error: 'WhatsApp not connected',
      action: 'Visit /qr to connect'
    });
  }
  
  // Channel check
  const channelId = CHANNEL_ID || process.env.CHANNEL_ID;
  if (!channelId) {
    return res.status(500).json({ 
      ok: false, 
      error: 'Channel ID not configured',
      action: 'Set CHANNEL_ID env var or use /get-channel-id'
    });
  }

  const { quizzes, delayMs = 3000 } = req.body;
  
  // Validation
  if (!Array.isArray(quizzes) || quizzes.length === 0) {
    return res.status(400).json({ ok: false, error: 'quizzes array is required' });
  }
  
  if (quizzes.length > 50) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Maximum 50 quizzes per batch to prevent spam' 
    });
  }

  console.log(`📤 Starting bulk send: ${quizzes.length} quizzes`);
  console.log(`   Channel: ${channelId}`);
  console.log(`   Delay: ${delayMs}ms between each`);
  
  const results = [];
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < quizzes.length; i++) {
    const quiz = quizzes[i];
    
    try {
      // Validate each quiz
      if (!quiz.question || !Array.isArray(quiz.options) || quiz.options.length < 2) {
        results.push({ 
          index: i, 
          ok: false, 
          error: 'Invalid format: question and 2+ options required' 
        });
        failCount++;
        continue;
      }

      // Clean options
      const cleanOptions = quiz.options
        .filter(opt => opt && typeof opt === 'string' && opt.trim().length > 0)
        .map(opt => opt.trim());

      if (cleanOptions.length < 2) {
        results.push({ 
          index: i, 
          ok: false, 
          error: 'At least 2 valid options required' 
        });
        failCount++;
        continue;
      }

      // Build poll
      const pollPayload = {
        poll: {
          name: quiz.question.trim(),
          values: cleanOptions,
          selectableCount: 1,
        }
      };

      // Add correct answer if provided
      if (typeof quiz.correctIndex === 'number' && 
          quiz.correctIndex >= 0 && 
          quiz.correctIndex < cleanOptions.length) {
        pollPayload.poll.correctAnswer = cleanOptions[quiz.correctIndex];
      }

      // Send to channel
      const sent = await sock.sendMessage(channelId, pollPayload);
      
      results.push({ 
        index: i, 
        ok: true, 
        messageId: sent?.key?.id || null,
        question: quiz.question.substring(0, 50) + '...'
      });
      
      successCount++;
      console.log(`   ✅ ${i + 1}/${quizzes.length}: ${quiz.question.substring(0, 40)}...`);
      
      // Delay between messages (except last)
      if (i < quizzes.length - 1) {
        await sleep(delayMs);
      }
      
    } catch (e) {
      console.error(`   ❌ ${i + 1}/${quizzes.length}: ${e.message}`);
      results.push({ 
        index: i, 
        ok: false, 
        error: e.message 
      });
      failCount++;
    }
  }

  console.log(`📊 Bulk send complete: ${successCount} sent, ${failCount} failed`);
  
  res.json({ 
    ok: true, 
    totalSent: successCount,
    totalFailed: failCount,
    totalQuizzes: quizzes.length,
    results: results
  });
});

// Helper sleep function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== START SERVER ====================

// Import session on startup
console.log('================================================');
console.log('🚀 Doctorians MDCAT Guide - Quiz Service');
console.log('================================================');
console.log('📋 Checking for saved session...');

// Start WhatsApp connection
connectToWhatsApp();

// Start Express server
app.listen(PORT, () => {
  console.log('================================================');
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`📱 QR Code page: http://localhost:${PORT}/qr`);
  console.log('================================================');
  console.log('💡 Quick Start Guide:');
  console.log('   1. Visit /qr to scan WhatsApp QR code');
  console.log('   2. Visit /session?key=ADMIN_KEY to get session string');
  console.log('   3. Save session as SESSION_DATA env var');
  console.log('   4. Get channel ID from /get-channel-id');
  console.log('   5. Set CHANNEL_ID env var');
  console.log('   6. Start sending quizzes! 🎉');
  console.log('================================================');
});