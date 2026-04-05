/**
 * WA BLAST — NEXUS SYSTEM
 * Backend Server v3.0 — Production Ready
 * Node.js 18+ | Baileys | Express | Socket.IO
 */

'use strict';

// ── CRITICAL: Polyfill crypto sebelum apapun di-load ────────────────────────
try {
  if (!globalThis.crypto) {
    const { webcrypto } = require('crypto');
    globalThis.crypto = webcrypto;
  }
} catch (e) {
  try { globalThis.crypto = require('crypto').webcrypto; } catch (_) {}
}

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const pino       = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors      : { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

const PORT         = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const PUBLIC_DIR   = path.join(__dirname, 'public');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const logger    = pino({ level: 'silent' });
const sessions  = {};
const blastJobs = {};

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/health', (req, res) => {
  res.json({
    status   : 'ok',
    uptime   : Math.floor(process.uptime()),
    sessions : Object.keys(sessions).length,
    memory   : Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/sessions', (req, res) => {
  res.json({ success: true, data: buildSessionList() });
});

app.delete('/api/sessions/:phone', async (req, res) => {
  await destroySession(req.params.phone, null);
  res.json({ success: true });
});

app.get('/', (req, res) => {
  const candidates = ['index.html', 'Index.html', 'INDEX.HTML'];
  for (const name of candidates) {
    const p = path.join(PUBLIC_DIR, name);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  const files = fs.existsSync(PUBLIC_DIR) ? fs.readdirSync(PUBLIC_DIR).join(', ') : 'folder tidak ada';
  res.status(404).send('<h3>index.html tidak ditemukan di ' + PUBLIC_DIR + '</h3><p>' + files + '</p>');
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Socket] Connect: ' + socket.id);
  socket.emit('sessions_update', buildSessionList());

  socket.on('request_pairing', async ({ phone }) => {
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10 || cleanPhone.length > 15) {
      return socket.emit('pairing_error', { phone: cleanPhone, message: 'Nomor tidak valid. Format: 628123456789' });
    }
    if (sessions[cleanPhone] && sessions[cleanPhone].status === 'connected') {
      return socket.emit('pairing_error', { phone: cleanPhone, message: 'Nomor ini sudah terhubung' });
    }
    log(socket, 'Memproses pairing untuk ' + cleanPhone + '...', 'info');
    try {
      await createSession(cleanPhone, socket);
    } catch (err) {
      console.error('[Pairing Error]', err);
      socket.emit('pairing_error', { phone: cleanPhone, message: err.message || 'Terjadi kesalahan' });
    }
  });

  socket.on('disconnect_number', async ({ phone }) => {
    if (!phone) return;
    await destroySession(String(phone), socket);
    log(socket, 'Nomor ' + phone + ' diputuskan', 'warning');
  });

  socket.on('check_status', ({ phone }) => {
    const s = sessions[String(phone)];
    socket.emit('status_update', { phone, status: s ? s.status : 'disconnected' });
  });

  socket.on('start_blast', async (payload) => {
    const { blastId, senderPhone, targets, templates, delaySeconds } = payload || {};
    if (!blastId)     return socket.emit('blast_error', { blastId, message: 'blastId tidak ada' });
    if (!senderPhone) return socket.emit('blast_error', { blastId, message: 'Pilih nomor pengirim' });

    const sess = sessions[String(senderPhone)];
    if (!sess || sess.status !== 'connected') {
      return socket.emit('blast_error', { blastId, message: 'Nomor pengirim ' + senderPhone + ' tidak aktif' });
    }
    if (!Array.isArray(targets) || !targets.length) {
      return socket.emit('blast_error', { blastId, message: 'Tidak ada nomor target' });
    }
    if (!Array.isArray(templates) || !templates.length) {
      return socket.emit('blast_error', { blastId, message: 'Tidak ada template pesan' });
    }

    const cleanTargets   = targets.map(t => String(t).replace(/\D/g, '')).filter(t => t.length >= 8 && t.length <= 15);
    const cleanTemplates = templates.map(t => String(t).trim()).filter(Boolean);

    if (!cleanTargets.length)   return socket.emit('blast_error', { blastId, message: 'Tidak ada target valid' });
    if (!cleanTemplates.length) return socket.emit('blast_error', { blastId, message: 'Semua template kosong' });

    const delay = Math.max(0, Math.min(60, parseInt(delaySeconds) || 3));

    blastJobs[blastId] = { status: 'running', total: cleanTargets.length, sent: 0, failed: 0, pending: cleanTargets.length };
    socket.emit('blast_started', { blastId, total: cleanTargets.length });
    log(socket, 'Blast dimulai - ' + cleanTargets.length + ' target | delay ' + delay + 's', 'success');

    runBlast(socket, blastId, senderPhone, cleanTargets, cleanTemplates, delay);
  });

  socket.on('stop_blast', ({ blastId }) => {
    if (!blastId) return;
    const job = blastJobs[blastId];
    if (job && job.status === 'running') {
      job.status = 'stopped';
      socket.emit('blast_stopped', { blastId });
      log(socket, 'Blast dihentikan', 'warning');
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Disconnect: ' + socket.id);
  });
});

// ── Session Management ────────────────────────────────────────────────────────
async function createSession(phone, socket) {
  const sessionPath = path.join(SESSIONS_DIR, phone);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  if (sessions[phone] && sessions[phone].waSocket) {
    try { sessions[phone].waSocket.end(undefined); } catch (_) {}
    await sleep(800);
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  let version;
  try {
    const res = await fetchLatestBaileysVersion();
    version = res.version;
  } catch (_) {
    version = [2, 3000, 1023140];
    console.warn('[Baileys] Pakai fallback version');
  }

  const waSocket = makeWASocket({
    version,
    logger,
    printQRInTerminal        : false,
    auth                     : { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser                  : ['Chrome (Linux)', 'Chrome', '124.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory          : false,
    connectTimeoutMs         : 60000,
    defaultQueryTimeoutMs    : 30000,
    keepAliveIntervalMs      : 25000,
    retryRequestDelayMs      : 2000,
    markOnlineOnConnect      : false,
    fireInitQueries          : false,
    getMessage               : async () => undefined
  });

  sessions[phone] = { waSocket, status: 'connecting', connectedAt: null, pairingDone: false, socketRef: socket };
  io.emit('sessions_update', buildSessionList());

  waSocket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    const sess = sessions[phone];

    // Request pairing code — sekali saja
    if (sess && !sess.pairingDone && !waSocket.authState.creds.registered) {
      sess.pairingDone = true;
      await sleep(2000);
      try {
        console.log('[Pairing] Requesting code for ' + phone);
        const rawCode = await waSocket.requestPairingCode(phone);
        if (!rawCode) throw new Error('Server WA tidak mengembalikan kode');
        const formatted = String(rawCode).replace(/[^A-Z0-9]/gi, '').replace(/(.{4})(?=.)/g, '$1-');
        console.log('[Pairing] Code ' + phone + ': ' + formatted);
        const target = sess.socketRef || socket;
        target.emit('pairing_code', { phone, code: formatted });
        log(target, 'Pairing code untuk ' + phone + ': ' + formatted, 'success');
      } catch (err) {
        console.error('[Pairing] Gagal ' + phone + ':', err.message);
        const target = (sessions[phone] && sessions[phone].socketRef) || socket;
        target.emit('pairing_error', { phone, message: 'Gagal mendapatkan pairing code: ' + err.message });
        if (sessions[phone]) sessions[phone].pairingDone = false;
      }
    }

    if (connection === 'open') {
      if (sessions[phone]) {
        sessions[phone].status      = 'connected';
        sessions[phone].connectedAt = new Date().toISOString();
      }
      const target = (sessions[phone] && sessions[phone].socketRef) || socket;
      target.emit('number_connected', { phone });
      log(target, phone + ' berhasil terhubung!', 'success');
      io.emit('sessions_update', buildSessionList());
      console.log('[Session] CONNECTED: ' + phone);
    }

    if (connection === 'close') {
      const code            = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : undefined;
      const isLoggedOut     = code === DisconnectReason.loggedOut;
      const isBadSession    = code === DisconnectReason.badSession;
      const shouldReconnect = !isLoggedOut && !isBadSession;

      console.log('[Session] CLOSED: ' + phone + ' | code:' + code + ' | reconnect:' + shouldReconnect);
      const target = (sessions[phone] && sessions[phone].socketRef) || socket;

      if (isLoggedOut || isBadSession) {
        if (sessions[phone]) sessions[phone].status = 'banned';
        target.emit('number_banned', { phone });
        log(target, phone + ' logout/banned dari WhatsApp', 'error');
        io.emit('sessions_update', buildSessionList());
        cleanSessionFiles(phone);
      } else if (shouldReconnect) {
        if (sessions[phone]) sessions[phone].status = 'reconnecting';
        io.emit('sessions_update', buildSessionList());
        log(target, phone + ' sedang reconnect...', 'warning');
        setTimeout(() => {
          if (sessions[phone]) {
            createSession(phone, target).catch(e => console.error('[Reconnect] Gagal:', e.message));
          }
        }, 5000);
      } else {
        if (sessions[phone]) sessions[phone].status = 'disconnected';
        io.emit('sessions_update', buildSessionList());
      }
    }
  });

  waSocket.ev.on('creds.update', saveCreds);

  waSocket.ev.on('messages.update', (updates) => {
    for (const upd of updates) {
      if (upd && upd.update && (upd.update.status === 4 || upd.update.status === 'ERROR')) {
        if (sessions[phone] && sessions[phone].status === 'connected') {
          sessions[phone].status = 'limited';
          io.emit('sessions_update', buildSessionList());
          const target = (sessions[phone] && sessions[phone].socketRef) || socket;
          log(target, phone + ' kena rate limit', 'warning');
        }
      }
    }
  });

  return waSocket;
}

async function destroySession(phone, socketRef) {
  if (sessions[phone]) {
    try { sessions[phone].waSocket.end(undefined); } catch (_) {}
    delete sessions[phone];
  }
  cleanSessionFiles(phone);
  io.emit('sessions_update', buildSessionList());
}

function cleanSessionFiles(phone) {
  const p = path.join(SESSIONS_DIR, phone);
  try {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log('[Session] Files removed: ' + phone);
    }
  } catch (e) {
    console.error('[CleanSession] Error:', e.message);
  }
}

function buildSessionList() {
  return Object.entries(sessions).map(function(entry) {
    return { phone: entry[0], status: entry[1].status, connectedAt: entry[1].connectedAt };
  });
}

// ── Blast Engine ──────────────────────────────────────────────────────────────
async function runBlast(socket, blastId, senderPhone, targets, templates, delaySeconds) {
  const job = blastJobs[blastId];

  for (let i = 0; i < targets.length; i++) {
    if (!blastJobs[blastId] || blastJobs[blastId].status !== 'running') break;

    const sess = sessions[senderPhone];
    if (!sess || sess.status !== 'connected') {
      socket.emit('blast_error', { blastId, message: 'Nomor pengirim ' + senderPhone + ' terputus' });
      if (blastJobs[blastId]) blastJobs[blastId].status = 'stopped';
      break;
    }

    const target   = targets[i];
    const template = templates[Math.floor(Math.random() * templates.length)];
    const jid      = target + '@s.whatsapp.net';

    socket.emit('message_status', { blastId, target, status: 'pending', index: i });

    try {
      await sess.waSocket.sendMessage(jid, { text: template });
      job.sent++;
      job.pending = Math.max(0, job.pending - 1);
      socket.emit('message_status', { blastId, target, status: 'sent', index: i });
      log(socket, 'Terkirim ke ' + target, 'success');
    } catch (err) {
      job.failed++;
      job.pending = Math.max(0, job.pending - 1);
      const errMsg = err && err.message ? err.message : 'unknown';
      if (errMsg.toLowerCase().indexOf('rate') !== -1) {
        if (sessions[senderPhone]) {
          sessions[senderPhone].status = 'limited';
          io.emit('sessions_update', buildSessionList());
        }
      }
      socket.emit('message_status', { blastId, target, status: 'failed', index: i, error: errMsg });
      log(socket, 'Gagal ke ' + target + ' (' + errMsg + ')', 'error');
    }

    socket.emit('blast_progress', {
      blastId,
      sent    : job.sent,
      failed  : job.failed,
      pending : job.pending,
      total   : job.total,
      progress: Math.round(((job.sent + job.failed) / job.total) * 100)
    });

    if (i < targets.length - 1 && blastJobs[blastId] && blastJobs[blastId].status === 'running') {
      await sleep((delaySeconds * 1000) + Math.floor(Math.random() * 1000));
    }
  }

  const finalJob = blastJobs[blastId];
  if (finalJob && finalJob.status !== 'stopped') {
    finalJob.status = 'completed';
    socket.emit('blast_completed', { blastId, sent: finalJob.sent, failed: finalJob.failed, total: finalJob.total });
    log(socket, 'Blast selesai! Sent: ' + finalJob.sent + ' | Gagal: ' + finalJob.failed, 'success');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, Math.max(0, ms)); });
}

function log(socket, message, type) {
  if (!socket) return;
  try {
    socket.emit('log', { message: message, type: type || 'info', timestamp: new Date().toLocaleTimeString('id-ID') });
  } catch (_) {}
}

// Auto-cleanup session stale
setInterval(function() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  Object.keys(sessions).forEach(function(phone) {
    const data = sessions[phone];
    if (data.status === 'disconnected' || data.status === 'banned') {
      const t = data.connectedAt ? new Date(data.connectedAt).getTime() : 0;
      if (t < cutoff) {
        console.log('[AutoCleanup] Removing: ' + phone);
        destroySession(phone, null);
      }
    }
  });
}, 10 * 60 * 1000);

// Graceful shutdown
function gracefulShutdown(signal) {
  console.log('[Server] ' + signal + ' - shutting down...');
  Object.keys(sessions).forEach(function(phone) {
    try { sessions[phone].waSocket.end(undefined); } catch (_) {}
  });
  server.close(function() {
    console.log('[Server] Closed.');
    process.exit(0);
  });
  setTimeout(function() { process.exit(1); }, 10000);
}

process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });
process.on('SIGINT',  function() { gracefulShutdown('SIGINT'); });
process.on('uncaughtException',  function(err)    { console.error('[UncaughtException]', err.message); });
process.on('unhandledRejection', function(reason) { console.error('[UnhandledRejection]', reason); });

// Start
server.listen(PORT, '0.0.0.0', function() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  WA BLAST NEXUS — Port: ' + PORT);
  console.log('║  Public  : ' + PUBLIC_DIR);
  console.log('║  Sessions: ' + SESSIONS_DIR);
  console.log('╚═══════════════════════════════════════╝');
});
