'use strict';

// ── PATCH crypto ─────────────────────────────────────────
try {
  if (!globalThis.crypto) {
    const nc = require('crypto');
    globalThis.crypto = nc.webcrypto ?? nc;
  }
} catch {}

// ── IMPORTS ──────────────────────────────────────────────
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

// ── SETUP ────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const logger = pino({ level: 'silent' });

const sessions = {};
const reconnectTimers = {};
const blastQueues = {};

// ── BASIC ROUTE ──────────────────────────────────────────
app.get('/', (req, res) => res.send('WA SERVER RUNNING'));
app.use(express.json());

// ── SOCKET ───────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('create_session', async ({ phone, method }) => {
    phone = (phone || '').replace(/\D/g, '');

    if (!phone) return;

    await createSession(phone, method || 'qr', socket);
  });

});

// ── CREATE SESSION ───────────────────────────────────────
async function createSession(phone, method, socket) {
  const sessionPath = path.join(SESSIONS_DIR, phone);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  if (sessions[phone]?.waSocket) {
    try { sessions[phone].waSocket.end(); } catch {}
  }

  clearTimeout(reconnectTimers[phone]);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  let version;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
  } catch {
    version = [2, 3000, 0];
  }

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    browser: ['Nexus', 'Chrome', '1.0']
  });

  sessions[phone] = {
    waSocket: sock,
    status: 'connecting',
    method,
    pairingDone: false
  };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    // =============================
    // QR CODE
    // =============================
    if (qr && method === 'qr') {
      try {
        const qrImg = await QRCode.toDataURL(qr);
        socket.emit('qr', { phone, qr: qrImg });
      } catch {}
    }

    // =============================
    // PAIRING CODE (FIXED TOTAL)
    // =============================
    if (
      method === 'pairing' &&
      connection === 'connecting' &&
      !sessions[phone].pairingDone
    ) {
      sessions[phone].pairingDone = true;

      try {
        await delay(1200);

        const code = await sock.requestPairingCode(phone);

        if (!code) throw new Error('Pairing code kosong');

        socket.emit('pairing', { phone, code });

      } catch (e) {
        socket.emit('pairing_error', { phone, error: e.message });

        // allow retry
        sessions[phone].pairingDone = false;
      }
    }

    // =============================
    // CONNECTED
    // =============================
    if (connection === 'open') {
      sessions[phone].status = 'connected';
      socket.emit('connected', { phone });
    }

    // =============================
    // DISCONNECT
    // =============================
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;

      const isLogout = code === DisconnectReason.loggedOut;
      const isBad = code === DisconnectReason.badSession;

      if (isLogout || isBad) {
        delete sessions[phone];
        socket.emit('logout', { phone });
      } else {
        sessions[phone].status = 'reconnecting';

        reconnectTimers[phone] = setTimeout(() => {
          createSession(phone, method, socket);
        }, 5000);
      }
    }

  });

  return sock;
}

// ── BLAST ENGINE (SAFE BASIC) ─────────────────────────────
async function runBlast(phone, targets, message, delaySec = 3) {
  const sock = sessions[phone]?.waSocket;
  if (!sock) return;

  for (let t of targets) {
    try {
      await sock.sendMessage(t + '@s.whatsapp.net', { text: message });
    } catch {}

    await delay(delaySec * 1000);
  }
}

// ── UTILS ────────────────────────────────────────────────
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── START SERVER ─────────────────────────────────────────
server.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
