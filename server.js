/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   WA BLAST — NEXUS SYSTEM  v3.0                     ║
 * ║   QR Code + Pairing Code dual support               ║
 * ║   Baileys latest (GitHub master)                    ║
 * ╚══════════════════════════════════════════════════════╝
 */

'use strict';

// ── PATCH crypto SEBELUM APAPUN ──────────────────────────────────────────────
try {
  if (!globalThis.crypto) {
    const nc = require('crypto');
    globalThis.crypto = nc.webcrypto ?? nc;
  }
} catch (e) { console.warn('[crypto patch]', e.message); }

// ── Imports ───────────────────────────────────────────────────────────────────
const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const path         = require('path');
const fs           = require('fs');
const pino         = require('pino');
const QRCode       = require('qrcode');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  PHONENUMBER_MCC,
} = require('@whiskeysockets/baileys');

// ── Setup ─────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000, pingInterval: 25000,
});

const PORT         = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const PUBLIC_DIR   = path.join(__dirname, 'public');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const logger = pino({ level: 'silent' });

// ── State ─────────────────────────────────────────────────────────────────────
// sessions[phone] = { waSocket, status, connectedAt, method, pairingDone }
const sessions        = {};
const blastQueues     = {};
const reconnectTimers = {};

// ── Middleware + Static ───────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  for (const name of ['index.html', 'Index.html']) {
    const p = path.join(PUBLIC_DIR, name);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).send('index.html not found');
});

app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  sessions: Object.keys(sessions).length,
}));

app.get('/api/sessions', (req, res) => {
  res.json(Object.entries(sessions).map(([phone, d]) => ({
    phone, status: d.status, method: d.method, connectedAt: d.connectedAt,
  })));
});

app.delete('/api/sessions/:phone', async (req, res) => {
  await destroySession(req.params.phone, null);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[WS] +${socket.id}`);
  socket.emit('sessions_update', buildSessionList());

  // ── REQUEST PAIRING CODE ───────────────────────────────────────────────────
  socket.on('request_pairing', async ({ phone }) => {
    const cleaned = (phone || '').replace(/\D/g, '');
    if (!cleaned || cleaned.length < 8 || cleaned.length > 15) {
      return socket.emit('pairing_error', {
        phone: cleaned,
        message: 'Nomor tidak valid. Format: 6281234567890 (tanpa +)',
      });
    }
    if (sessions[cleaned]?.status === 'connected') {
      return socket.emit('pairing_error', { phone: cleaned, message: 'Nomor sudah terhubung.' });
    }
    log(socket, `Memproses pairing code untuk ${cleaned}...`, 'info');
    try {
      await createSession(cleaned, 'pairing', socket);
    } catch (err) {
      console.error(`[request_pairing]`, err);
      socket.emit('pairing_error', { phone: cleaned, message: err.message });
    }
  });

  // ── REQUEST QR ─────────────────────────────────────────────────────────────
  socket.on('request_qr', async ({ phone }) => {
    const cleaned = (phone || '').replace(/\D/g, '');
    if (!cleaned || cleaned.length < 8 || cleaned.length > 15) {
      return socket.emit('qr_error', {
        phone: cleaned,
        message: 'Nomor tidak valid. Format: 6281234567890 (tanpa +)',
      });
    }
    if (sessions[cleaned]?.status === 'connected') {
      return socket.emit('qr_error', { phone: cleaned, message: 'Nomor sudah terhubung.' });
    }
    log(socket, `Memuat QR Code untuk ${cleaned}...`, 'info');
    try {
      await createSession(cleaned, 'qr', socket);
    } catch (err) {
      console.error(`[request_qr]`, err);
      socket.emit('qr_error', { phone: cleaned, message: err.message });
    }
  });

  // ── DISCONNECT NUMBER ──────────────────────────────────────────────────────
  socket.on('disconnect_number', async ({ phone }) => {
    await destroySession(phone, socket);
    log(socket, `Nomor ${phone} diputuskan`, 'warning');
  });

  // ── CHECK STATUS ───────────────────────────────────────────────────────────
  socket.on('check_status', ({ phone }) => {
    socket.emit('status_update', { phone, status: sessions[phone]?.status || 'offline' });
  });

  // ── START BLAST ────────────────────────────────────────────────────────────
  socket.on('start_blast', ({ blastId, senderPhone, targets, templates, delaySeconds }) => {
    if (!sessions[senderPhone] || sessions[senderPhone].status !== 'connected') {
      return socket.emit('blast_error', {
        blastId, message: `Nomor ${senderPhone} tidak terhubung.`,
      });
    }

    const cleanTargets = (targets || [])
      .map(t => t.toString().replace(/\D/g, ''))
      .filter(t => t.length >= 8 && t.length <= 15);

    if (!cleanTargets.length)
      return socket.emit('blast_error', { blastId, message: 'Tidak ada nomor target valid.' });

    const cleanTemplates = (templates || []).map(t => t.trim()).filter(Boolean);
    if (!cleanTemplates.length)
      return socket.emit('blast_error', { blastId, message: 'Tidak ada template pesan.' });

    const delay = Math.max(0, Math.min(60, parseInt(delaySeconds) || 3));

    blastQueues[blastId] = {
      status: 'running', total: cleanTargets.length,
      sent: 0, failed: 0, pending: cleanTargets.length,
    };

    socket.emit('blast_started', { blastId, total: cleanTargets.length });
    log(socket, `Blast dimulai — ${cleanTargets.length} target, delay ${delay}s`, 'success');
    runBlast(socket, blastId, senderPhone, cleanTargets, cleanTemplates, delay);
  });

  // ── STOP BLAST ─────────────────────────────────────────────────────────────
  socket.on('stop_blast', ({ blastId }) => {
    if (blastQueues[blastId]?.status === 'running') {
      blastQueues[blastId].status = 'stopped';
      socket.emit('blast_stopped', { blastId });
      log(socket, `Blast dihentikan`, 'warning');
    }
  });

  socket.on('disconnect', () => console.log(`[WS] -${socket.id}`));
});

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE SESSION  (method: 'qr' | 'pairing')
// ═══════════════════════════════════════════════════════════════════════════════

async function createSession(phone, method, socket) {
  const sessionPath = path.join(SESSIONS_DIR, phone);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  // Close existing
  if (sessions[phone]?.waSocket) {
    try { sessions[phone].waSocket.end(undefined); } catch (_) {}
  }
  cancelTimers(phone);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  let version = [2, 3000, 1015901307];
  try {
    const r = await fetchLatestBaileysVersion();
    if (r?.version) version = r.version;
  } catch (_) {}

  // ── Build socket config based on method ───────────────────────────────────
  const socketConfig = {
    version,
    logger,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal:              false,
    generateHighQualityLinkPreview: false,
    syncFullHistory:                false,
    connectTimeoutMs:               60_000,
    defaultQueryTimeoutMs:          30_000,
    keepAliveIntervalMs:            15_000,
    markOnlineOnConnect:            false,
    browser:                        ['WA Blast', 'Chrome', '120.0.6099.71'],
  };

  // For pairing code: must use mobile: true
  if (method === 'pairing') {
    socketConfig.mobile = false; // pairing code works with mobile:false in latest Baileys
  }

  const waSocket = makeWASocket(socketConfig);

  sessions[phone] = {
    waSocket,
    status:       'connecting',
    connectedAt:  null,
    method,
    pairingDone:  false,
  };

  // ── connection.update ──────────────────────────────────────────────────────
  waSocket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ── QR Code ─────────────────────────────────────────────────────────────
    if (qr && method === 'qr') {
      try {
        const qrDataURL = await QRCode.toDataURL(qr, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 300,
          color: { dark: '#00f3ff', light: '#050d18' },
        });
        socket.emit('qr_code', { phone, qr: qrDataURL });
        log(socket, `QR Code baru untuk ${phone} — scan sekarang!`, 'info');
      } catch (err) {
        console.error('[QR generate]', err.message);
      }
    }

    // ── Pairing Code (only when not yet registered) ──────────────────────────
    if (
      method === 'pairing' &&
      !sessions[phone]?.pairingDone &&
      !waSocket.authState.creds.registered
    ) {
      sessions[phone].pairingDone = true;

      // Wait for WS to stabilize before requesting code
      reconnectTimers[`pair_${phone}`] = setTimeout(async () => {
        delete reconnectTimers[`pair_${phone}`];

        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
          attempts++;
          try {
            // Validate phone has valid MCC (country prefix)
            const phoneNum = phone.replace(/[^0-9]/g, '');
            const code = await waSocket.requestPairingCode(phoneNum);

            if (!code) throw new Error('Kode kosong dari server WhatsApp');

            // Clean & format: XXXX-XXXX
            const clean = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            const formatted = clean.length >= 8
              ? `${clean.slice(0,4)}-${clean.slice(4,8)}`
              : clean;

            socket.emit('pairing_code', { phone, code: formatted });
            log(socket, `Pairing code ${phone}: ${formatted}`, 'success');
            break; // success

          } catch (err) {
            console.error(`[PairingCode attempt ${attempts}] ${phone}:`, err.message);
            if (attempts >= maxAttempts) {
              socket.emit('pairing_error', {
                phone,
                message: `Gagal mendapatkan pairing code setelah ${maxAttempts}x: ${err.message}`,
              });
            } else {
              await sleep(3000); // wait before retry
            }
          }
        }
      }, 4000); // 4s wait for WS handshake
    }

    // ── Connected ────────────────────────────────────────────────────────────
    if (connection === 'open') {
      if (sessions[phone]) {
        sessions[phone].status      = 'connected';
        sessions[phone].connectedAt = new Date().toISOString();
      }
      socket.emit('number_connected', { phone, method });
      log(socket, `✅ ${phone} terhubung via ${method === 'qr' ? 'QR Code' : 'Pairing Code'}!`, 'success');
      broadcastSessions();
    }

    // ── Closed ───────────────────────────────────────────────────────────────
    if (connection === 'close') {
      const code         = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut  = code === DisconnectReason.loggedOut;
      const isBadSession = code === DisconnectReason.badSession;
      const shouldRecon  = !isLoggedOut && !isBadSession;

      console.log(`[Session ${phone}] closed code=${code} reconnect=${shouldRecon}`);

      if (isLoggedOut || isBadSession) {
        if (sessions[phone]) sessions[phone].status = 'banned';
        socket.emit('number_banned', { phone });
        log(socket, `⛔ ${phone} di-logout / banned`, 'error');
        broadcastSessions();
        cleanFiles(phone);
        delete sessions[phone];
      } else if (shouldRecon) {
        if (sessions[phone]) sessions[phone].status = 'reconnecting';
        log(socket, `🔄 ${phone} reconnect dalam 6 detik...`, 'warning');
        broadcastSessions();
        reconnectTimers[phone] = setTimeout(() => {
          delete reconnectTimers[phone];
          // Reconnect with same method
          const m = sessions[phone]?.method || 'pairing';
          createSession(phone, m, socket).catch(e => {
            console.error(`[Reconnect] ${phone}:`, e.message);
          });
        }, 6000);
      } else {
        if (sessions[phone]) sessions[phone].status = 'disconnected';
        broadcastSessions();
      }
    }
  });

  waSocket.ev.on('creds.update', saveCreds);

  return waSocket;
}

// ── destroySession ─────────────────────────────────────────────────────────────
async function destroySession(phone, socket) {
  cancelTimers(phone);
  if (sessions[phone]) {
    try { sessions[phone].waSocket?.end(undefined); } catch (_) {}
    delete sessions[phone];
  }
  cleanFiles(phone);
  broadcastSessions();
}

function cancelTimers(phone) {
  for (const k of [phone, `pair_${phone}`]) {
    if (reconnectTimers[k]) { clearTimeout(reconnectTimers[k]); delete reconnectTimers[k]; }
  }
}

function cleanFiles(phone) {
  const p = path.join(SESSIONS_DIR, phone);
  try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
  catch (err) { console.error('[cleanFiles]', err.message); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLAST ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

async function runBlast(socket, blastId, senderPhone, targets, templates, delaySeconds) {
  const queue    = blastQueues[blastId];
  const waSocket = sessions[senderPhone]?.waSocket;

  if (!waSocket) {
    socket.emit('blast_error', { blastId, message: 'Socket tidak tersedia.' });
    return;
  }

  for (let i = 0; i < targets.length; i++) {
    if (!blastQueues[blastId] || blastQueues[blastId].status !== 'running') break;

    const target   = targets[i];
    const template = templates[i % templates.length];
    const jid      = `${target}@s.whatsapp.net`;

    socket.emit('message_status', { blastId, target, status: 'pending', message: template, index: i });

    try {
      await waSocket.sendMessage(jid, { text: template });
      queue.sent++;
      queue.pending = Math.max(0, queue.pending - 1);
      socket.emit('message_status', { blastId, target, status: 'sent', message: template, index: i });
      log(socket, `✅ → ${target}`, 'success');
    } catch (err) {
      queue.failed++;
      queue.pending = Math.max(0, queue.pending - 1);
      const m = (err.message || '').toLowerCase();
      if (m.includes('rate') || m.includes('418') || m.includes('429') || m.includes('spam')) {
        if (sessions[senderPhone]) { sessions[senderPhone].status = 'limited'; broadcastSessions(); }
      }
      socket.emit('message_status', {
        blastId, target, status: 'failed', message: template, index: i, error: err.message,
      });
      log(socket, `❌ → ${target}: ${err.message}`, 'error');
    }

    socket.emit('blast_progress', {
      blastId,
      sent: queue.sent, failed: queue.failed, pending: queue.pending, total: queue.total,
      progress: Math.round(((queue.sent + queue.failed) / queue.total) * 100),
    });

    if (i < targets.length - 1 && blastQueues[blastId]?.status === 'running') {
      await sleep((delaySeconds * 1000) + Math.floor(Math.random() * 1500));
    }
  }

  if (blastQueues[blastId]?.status !== 'stopped') {
    blastQueues[blastId].status = 'completed';
    socket.emit('blast_completed', {
      blastId, sent: queue.sent, failed: queue.failed, total: queue.total,
    });
    log(socket, `Blast selesai — ✅${queue.sent} ❌${queue.failed}`, 'success');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(socket, message, type = 'info') {
  const ts = new Date().toLocaleTimeString('id-ID');
  console.log(`[${type}] ${message}`);
  if (socket) socket.emit('log', { message, type, timestamp: ts });
}

function buildSessionList() {
  return Object.entries(sessions).map(([phone, d]) => ({
    phone, status: d.status, method: d.method, connectedAt: d.connectedAt,
  }));
}

function broadcastSessions() {
  io.emit('sessions_update', buildSessionList());
}

// ── Auto cleanup ──────────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [phone, d] of Object.entries(sessions)) {
    if (['disconnected','banned'].includes(d.status) &&
        d.connectedAt && new Date(d.connectedAt).getTime() < cutoff) {
      console.log(`[AutoCleanup] ${phone}`);
      destroySession(phone, null);
    }
  }
}, 900_000);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(sig) {
  console.log(`[${sig}] shutting down...`);
  for (const [, d] of Object.entries(sessions)) {
    try { d.waSocket?.end(undefined); } catch (_) {}
  }
  server.close(() => { process.exit(0); });
  setTimeout(() => process.exit(1), 8000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  e => console.error('[uncaught]', e));
process.on('unhandledRejection', r => console.error('[unhandled]', r));

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`╔═══════════════════════════════════════╗`);
  console.log(`║  WA BLAST v3.0  port=${PORT}             ║`);
  console.log(`║  QR Code + Pairing Code support       ║`);
  console.log(`╚═══════════════════════════════════════╝`);
});
