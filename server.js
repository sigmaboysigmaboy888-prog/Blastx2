/**
 * WhatsApp Blast Server
 * Backend: Express + Socket.IO + Baileys
 * Supports multiple WhatsApp sessions with pairing code
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

// Baileys imports
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  makeInMemoryStore,
  jidDecode,
  proto,
  getAggregateVotesInPollMessage,
  PHONENUMBER_MCC
} = require('@whiskeysockets/baileys');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Silent logger for Baileys
const logger = pino({ level: 'silent' });

// In-memory state
const sessions = {};       // { phoneNumber: { socket, status, connectedAt } }
const blastQueues = {};    // { blastId: { status, progress, total } }

app.use(express.json());

// Serve static files - try multiple paths for Railway compatibility
const publicPath = path.join(__dirname, 'public');
console.log(`[Server] Serving static from: ${publicPath}`);
app.use(express.static(publicPath));

// Explicit root route fallback
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (require('fs').existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send(`index.html not found at ${indexPath}`);
  }
});

// ─── Health Check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sessions: Object.keys(sessions).length,
    uptime: process.uptime()
  });
});

// ─── API Routes ──────────────────────────────────────────────────────────────

// Get all active sessions
app.get('/api/sessions', (req, res) => {
  const sessionList = Object.entries(sessions).map(([phone, data]) => ({
    phone,
    status: data.status,
    connectedAt: data.connectedAt
  }));
  res.json(sessionList);
});

// Delete a session
app.delete('/api/sessions/:phone', async (req, res) => {
  const { phone } = req.params;
  await destroySession(phone);
  res.json({ success: true, message: `Session ${phone} deleted` });
});

// ─── Socket.IO Events ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // Send current sessions on connect
  const sessionList = Object.entries(sessions).map(([phone, data]) => ({
    phone,
    status: data.status,
    connectedAt: data.connectedAt
  }));
  socket.emit('sessions_update', sessionList);

  // ── Request Pairing Code ──────────────────────────────────────────────────
  socket.on('request_pairing', async ({ phone }) => {
    if (!phone || !/^\d{10,15}$/.test(phone)) {
      socket.emit('pairing_error', { phone, message: 'Nomor tidak valid. Gunakan format internasional tanpa +' });
      return;
    }

    if (sessions[phone] && sessions[phone].status === 'connected') {
      socket.emit('pairing_error', { phone, message: 'Nomor sudah terhubung' });
      return;
    }

    emitLog(socket, `Meminta pairing code untuk nomor ${phone}...`, 'info');

    try {
      await createSession(phone, socket);
    } catch (err) {
      console.error('[Pairing Error]', err);
      socket.emit('pairing_error', { phone, message: err.message });
    }
  });

  // ── Disconnect a number ──────────────────────────────────────────────────
  socket.on('disconnect_number', async ({ phone }) => {
    await destroySession(phone);
    emitLog(socket, `Nomor ${phone} telah diputuskan`, 'warning');
    broadcastSessionsUpdate();
  });

  // ── Check number status ──────────────────────────────────────────────────
  socket.on('check_status', ({ phone }) => {
    const session = sessions[phone];
    if (!session) {
      socket.emit('status_update', { phone, status: 'disconnected' });
      return;
    }
    socket.emit('status_update', { phone, status: session.status });
  });

  // ── Start Blast ──────────────────────────────────────────────────────────
  socket.on('start_blast', async ({ blastId, senderPhone, targets, templates, delaySeconds }) => {
    if (!sessions[senderPhone] || sessions[senderPhone].status !== 'connected') {
      socket.emit('blast_error', { blastId, message: `Nomor pengirim ${senderPhone} tidak terhubung` });
      return;
    }

    if (!targets || targets.length === 0) {
      socket.emit('blast_error', { blastId, message: 'Tidak ada nomor target' });
      return;
    }

    if (!templates || templates.length === 0) {
      socket.emit('blast_error', { blastId, message: 'Tidak ada template pesan' });
      return;
    }

    // Normalize targets
    const cleanTargets = targets
      .map(t => t.toString().replace(/\D/g, ''))
      .filter(t => t.length >= 8 && t.length <= 15);

    if (cleanTargets.length === 0) {
      socket.emit('blast_error', { blastId, message: 'Tidak ada nomor target yang valid' });
      return;
    }

    blastQueues[blastId] = {
      status: 'running',
      total: cleanTargets.length,
      sent: 0,
      failed: 0,
      pending: cleanTargets.length
    };

    socket.emit('blast_started', { blastId, total: cleanTargets.length });
    emitLog(socket, `Blast ${blastId} dimulai - ${cleanTargets.length} target`, 'success');

    // Run blast asynchronously
    runBlast(socket, blastId, senderPhone, cleanTargets, templates, delaySeconds || 3);
  });

  // ── Stop Blast ───────────────────────────────────────────────────────────
  socket.on('stop_blast', ({ blastId }) => {
    if (blastQueues[blastId]) {
      blastQueues[blastId].status = 'stopped';
      socket.emit('blast_stopped', { blastId });
      emitLog(socket, `Blast ${blastId} dihentikan`, 'warning');
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// ─── Session Management ───────────────────────────────────────────────────────

async function createSession(phone, socket) {
  const sessionPath = path.join(SESSIONS_DIR, phone);

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  // Destroy existing session if any
  if (sessions[phone] && sessions[phone].waSocket) {
    try { sessions[phone].waSocket.end(); } catch (e) {}
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const waSocket = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    browser: ['WhatsApp Blast', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
    markOnlineOnConnect: false
  });

  sessions[phone] = {
    waSocket,
    status: 'connecting',
    connectedAt: null,
    pairingRequested: false
  };

  // Request pairing code after socket is ready
  waSocket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, isNewLogin } = update;

    // Request pairing code once when not registered
    if (!sessions[phone]?.pairingRequested && !waSocket.authState.creds.registered) {
      sessions[phone].pairingRequested = true;
      setTimeout(async () => {
        try {
          const code = await waSocket.requestPairingCode(phone);
          const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
          socket.emit('pairing_code', { phone, code: formatted });
          emitLog(socket, `Pairing code untuk ${phone}: ${formatted}`, 'success');
        } catch (err) {
          socket.emit('pairing_error', { phone, message: 'Gagal mendapatkan pairing code: ' + err.message });
        }
      }, 3000);
    }

    if (connection === 'open') {
      sessions[phone].status = 'connected';
      sessions[phone].connectedAt = new Date().toISOString();
      socket.emit('number_connected', { phone });
      emitLog(socket, `Nomor ${phone} berhasil terhubung!`, 'success');
      broadcastSessionsUpdate();
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      console.log(`[Session ${phone}] Closed. Code: ${statusCode}. Reconnect: ${shouldReconnect}`);

      if (statusCode === DisconnectReason.loggedOut) {
        // Banned or logged out
        sessions[phone].status = 'banned';
        socket.emit('number_banned', { phone });
        emitLog(socket, `Nomor ${phone} telah di-logout/banned`, 'error');
        broadcastSessionsUpdate();
        // Clean up session files
        cleanSessionFiles(phone);
      } else if (shouldReconnect) {
        sessions[phone].status = 'reconnecting';
        emitLog(socket, `Nomor ${phone} sedang reconnect...`, 'warning');
        broadcastSessionsUpdate();
        // Reconnect after delay
        setTimeout(() => createSession(phone, socket), 5000);
      } else {
        sessions[phone].status = 'disconnected';
        broadcastSessionsUpdate();
      }
    }
  });

  waSocket.ev.on('creds.update', saveCreds);

  // Monitor for rate limiting via message receipt errors
  waSocket.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      if (update.update?.status === 'ERROR') {
        if (sessions[phone]) {
          sessions[phone].status = 'limited';
          broadcastSessionsUpdate();
          emitLog(socket, `Nomor ${phone} terkena rate limit`, 'warning');
        }
      }
    }
  });

  return waSocket;
}

async function destroySession(phone) {
  if (sessions[phone]) {
    try {
      sessions[phone].waSocket?.end();
    } catch (e) {}
    delete sessions[phone];
  }
  cleanSessionFiles(phone);
  broadcastSessionsUpdate();
}

function cleanSessionFiles(phone) {
  const sessionPath = path.join(SESSIONS_DIR, phone);
  try {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('[CleanSession Error]', e);
  }
}

// ─── Blast Engine ─────────────────────────────────────────────────────────────

async function runBlast(socket, blastId, senderPhone, targets, templates, delaySeconds) {
  const queue = blastQueues[blastId];
  const waSocket = sessions[senderPhone]?.waSocket;

  if (!waSocket) {
    socket.emit('blast_error', { blastId, message: 'Socket tidak ditemukan' });
    return;
  }

  for (let i = 0; i < targets.length; i++) {
    // Check if blast was stopped
    if (!blastQueues[blastId] || blastQueues[blastId].status === 'stopped') {
      break;
    }

    const target = targets[i];
    // Pick random template
    const template = templates[Math.floor(Math.random() * templates.length)];
    const jid = target.includes('@') ? target : `${target}@s.whatsapp.net`;

    // Emit pending status
    socket.emit('message_status', {
      blastId,
      target,
      status: 'pending',
      message: template,
      index: i
    });

    try {
      await waSocket.sendMessage(jid, { text: template });

      queue.sent++;
      queue.pending = Math.max(0, queue.pending - 1);

      socket.emit('message_status', {
        blastId,
        target,
        status: 'sent',
        message: template,
        index: i
      });

      socket.emit('blast_progress', {
        blastId,
        sent: queue.sent,
        failed: queue.failed,
        pending: queue.pending,
        total: queue.total,
        progress: Math.round(((queue.sent + queue.failed) / queue.total) * 100)
      });

      emitLog(socket, `✅ Terkirim ke ${target}`, 'success');

    } catch (err) {
      queue.failed++;
      queue.pending = Math.max(0, queue.pending - 1);

      // Check if error indicates rate limit
      if (err.message?.includes('rate') || err.output?.statusCode === 429) {
        if (sessions[senderPhone]) {
          sessions[senderPhone].status = 'limited';
          broadcastSessionsUpdate();
        }
      }

      socket.emit('message_status', {
        blastId,
        target,
        status: 'failed',
        message: template,
        index: i,
        error: err.message
      });

      socket.emit('blast_progress', {
        blastId,
        sent: queue.sent,
        failed: queue.failed,
        pending: queue.pending,
        total: queue.total,
        progress: Math.round(((queue.sent + queue.failed) / queue.total) * 100)
      });

      emitLog(socket, `❌ Gagal ke ${target}: ${err.message}`, 'error');
    }

    // Delay between messages (except last)
    if (i < targets.length - 1 && blastQueues[blastId]?.status !== 'stopped') {
      const delay = (delaySeconds * 1000) + Math.floor(Math.random() * 1000); // add jitter
      await sleep(delay);
    }
  }

  if (blastQueues[blastId]?.status !== 'stopped') {
    blastQueues[blastId].status = 'completed';
    socket.emit('blast_completed', {
      blastId,
      sent: queue.sent,
      failed: queue.failed,
      total: queue.total
    });
    emitLog(socket, `🎯 Blast selesai! Terkirim: ${queue.sent}, Gagal: ${queue.failed}`, 'success');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function emitLog(socket, message, type = 'info') {
  socket.emit('log', {
    message,
    type,
    timestamp: new Date().toLocaleTimeString('id-ID')
  });
}

function broadcastSessionsUpdate() {
  const sessionList = Object.entries(sessions).map(([phone, data]) => ({
    phone,
    status: data.status,
    connectedAt: data.connectedAt
  }));
  io.emit('sessions_update', sessionList);
}

// ─── Auto-cleanup inactive sessions (1 hour) ─────────────────────────────────
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [phone, data] of Object.entries(sessions)) {
    if (data.connectedAt && new Date(data.connectedAt).getTime() < oneHourAgo) {
      if (data.status === 'disconnected' || data.status === 'banned') {
        console.log(`[AutoCleanup] Removing inactive session: ${phone}`);
        destroySession(phone);
      }
    }
  }
}, 10 * 60 * 1000); // Check every 10 minutes

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM received. Shutting down gracefully...');
  for (const phone of Object.keys(sessions)) {
    try { sessions[phone].waSocket?.end(); } catch (e) {}
  }
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Server] WhatsApp Blast running on port ${PORT}`);
  console.log(`[Server] Sessions directory: ${SESSIONS_DIR}`);
});
