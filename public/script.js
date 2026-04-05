/**
 * WA BLAST — NEXUS SYSTEM
 * Frontend Logic: Socket.IO, LocalStorage, UI
 */

'use strict';

// ─── Socket.IO Connection ─────────────────────────────────────────────────────
const socket = io();

// ─── State ────────────────────────────────────────────────────────────────────
let currentPage   = 'home';
let sessions      = {};     // { phone: { status, connectedAt } }
let blastRunning  = false;
let activeBlastId = null;

// Stats
let stats = {
  sent: parseInt(localStorage.getItem('stat_sent') || '0'),
  failed: parseInt(localStorage.getItem('stat_failed') || '0'),
  pending: 0,
  active: 0
};

// Numbers saved in LocalStorage
let savedNumbers = JSON.parse(localStorage.getItem('saved_numbers') || '[]');

// Templates saved in LocalStorage
let templates = JSON.parse(localStorage.getItem('templates') || '[]');
if (!templates.length) templates = ['Halo {name}, kami menghubungi Anda untuk informasi penting!'];

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $el = sel => document.querySelector(sel);

// ─── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderStats();
  renderTemplates();
  renderNumbersList();
  renderHomeNumbers();
  setupNavigation();
  setupBlastPage();
  setupPairingPage();
  setupNumbersPage();
  setupSidebar();
  startAutoRefresh();
  updateTargetCount();
});

// ═══════════════ SOCKET.IO EVENTS ═════════════════════════════════════════════

socket.on('connect', () => {
  addLog('Terhubung ke server ✓', 'success');
  setConnStatus(true);
});

socket.on('disconnect', () => {
  addLog('Koneksi ke server terputus', 'error');
  setConnStatus(false);
});

socket.on('sessions_update', (list) => {
  sessions = {};
  list.forEach(s => { sessions[s.phone] = s; });
  renderAllSessionsUI();
});

socket.on('pairing_code', ({ phone, code }) => {
  $('code-display').style.display = 'block';
  $('code-value').textContent = code;
  setPairingStatus(`Masukkan kode ini di WhatsApp untuk nomor ${phone}`, 'loading');
  addLog(`Pairing code ${phone}: ${code}`, 'success');
});

socket.on('pairing_error', ({ phone, message }) => {
  setPairingStatus(`Error: ${escHtml(message)}`, 'error');
  addLog(`Pairing error ${phone}: ${message}`, 'error');
});

socket.on('number_connected', ({ phone }) => {
  setPairingStatus(`✅ Nomor ${phone} berhasil terhubung!`, 'success');
  $('code-display').style.display = 'none';
  addLog(`Nomor ${phone} AKTIF`, 'success');
});

socket.on('number_banned', ({ phone }) => {
  addLog(`⛔ Nomor ${phone} di-ban WhatsApp`, 'error');
});

socket.on('status_update', ({ phone, status }) => {
  if (sessions[phone]) sessions[phone].status = status;
  renderAllSessionsUI();
});

socket.on('log', ({ message, type, timestamp }) => {
  addLog(message, type, timestamp);
});

// Blast events
socket.on('blast_started', ({ blastId, total }) => {
  blastRunning = true;
  activeBlastId = blastId;
  $('blast-progress-panel').style.display = 'block';
  $('p-total').textContent = total;
  $('p-pending').textContent = total;
  $('p-sent').textContent = 0;
  $('p-failed').textContent = 0;
  $('blast-progress-bar').style.width = '0%';
  addBlastLog(`⚡ Blast dimulai — ${total} target`, 'success');
});

socket.on('blast_progress', ({ blastId, sent, failed, pending, total, progress }) => {
  $('p-sent').textContent = sent;
  $('p-failed').textContent = failed;
  $('p-pending').textContent = pending;
  $('blast-progress-bar').style.width = progress + '%';

  // Update global stats
  stats.sent    = parseInt(localStorage.getItem('stat_sent') || '0') + sent;
  stats.failed  = parseInt(localStorage.getItem('stat_failed') || '0') + failed;
  stats.pending = pending;
  renderStats();
});

socket.on('message_status', ({ blastId, target, status, message, index, error }) => {
  const safeTarget = escHtml(target);
  if (status === 'sent') {
    addBlastLog(`✅ ${safeTarget}`, 'success');
    stats.sent++;
    localStorage.setItem('stat_sent', stats.sent);
  } else if (status === 'failed') {
    addBlastLog(`❌ ${safeTarget} — ${escHtml(error || 'gagal')}`, 'error');
    stats.failed++;
    localStorage.setItem('stat_failed', stats.failed);
  } else if (status === 'pending') {
    addBlastLog(`⏳ ${safeTarget}`, 'warning');
  }
  renderStats();
});

socket.on('blast_completed', ({ blastId, sent, failed, total }) => {
  blastRunning = false;
  activeBlastId = null;
  addBlastLog(`🎯 Blast selesai! Terkirim: ${sent}, Gagal: ${failed}, Total: ${total}`, 'success');
  addLog(`🎯 Blast selesai — Sent: ${sent} | Failed: ${failed}`, 'success');
  $('start-blast').disabled = false;
  $('start-blast').textContent = '⚡ MULAI BLAST';
});

socket.on('blast_stopped', ({ blastId }) => {
  blastRunning = false;
  activeBlastId = null;
  addBlastLog('🛑 Blast dihentikan', 'warning');
  $('start-blast').disabled = false;
  $('start-blast').innerHTML = '<span>⚡ MULAI BLAST</span>';
});

socket.on('blast_error', ({ blastId, message }) => {
  blastRunning = false;
  addBlastLog(`❌ Error: ${escHtml(message)}`, 'error');
  addLog(`Blast error: ${message}`, 'error');
  $('start-blast').disabled = false;
  $('start-blast').innerHTML = '<span>⚡ MULAI BLAST</span>';
});

// ═══════════════ NAVIGATION ═══════════════════════════════════════════════════

function setupNavigation() {
  // Sidebar nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });

  // Bottom nav buttons
  document.querySelectorAll('.bnav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });
}

function navigateTo(page) {
  currentPage = page;

  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  // Show target page
  const target = $(`page-${page}`);
  if (target) target.classList.add('active');

  // Update nav buttons
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.page === page);
  });

  document.querySelectorAll('.bnav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.page === page);
  });

  // Close sidebar on mobile
  closeSidebar();

  // Refresh relevant data
  if (page === 'blast') refreshBlastSenderOptions();
  if (page === 'home') renderHomeNumbers();
}

// ═══════════════ SIDEBAR ══════════════════════════════════════════════════════

function setupSidebar() {
  const hamburger = $('hamburger');
  const sidebar   = $('sidebar');
  const overlay   = $('sidebar-overlay');

  hamburger.addEventListener('click', toggleSidebar);
  overlay.addEventListener('click', closeSidebar);
}

function toggleSidebar() {
  $('sidebar').classList.toggle('open');
  $('sidebar-overlay').classList.toggle('open');
}

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-overlay').classList.remove('open');
}

// ═══════════════ BLAST PAGE ════════════════════════════════════════════════════

function setupBlastPage() {
  // Delay slider
  $('blast-delay').addEventListener('input', function() {
    $('delay-display').textContent = this.value;
  });

  // Target textarea count
  $('blast-targets').addEventListener('input', updateTargetCount);

  // Add template
  $('add-template').addEventListener('click', () => {
    templates.push('');
    saveTemplates();
    renderTemplates();
  });

  // Start blast
  $('start-blast').addEventListener('click', startBlast);

  // Stop blast
  $('stop-blast').addEventListener('click', () => {
    if (activeBlastId) {
      socket.emit('stop_blast', { blastId: activeBlastId });
    }
  });
}

function renderTemplates() {
  const container = $('templates-container');
  container.innerHTML = '';

  templates.forEach((tpl, i) => {
    const div = document.createElement('div');
    div.className = 'template-item';
    div.innerHTML = `
      <div class="template-badge">TEMPLATE ${String(i + 1).padStart(2, '0')}</div>
      <textarea placeholder="Isi template pesan...">${escHtml(tpl)}</textarea>
      <button class="template-remove" data-idx="${i}" title="Hapus template">✕</button>
    `;

    const ta = div.querySelector('textarea');
    ta.addEventListener('input', () => {
      templates[i] = ta.value;
      saveTemplates();
    });

    const removeBtn = div.querySelector('.template-remove');
    removeBtn.addEventListener('click', () => {
      if (templates.length <= 1) {
        showToast('Minimal 1 template diperlukan', 'error');
        return;
      }
      templates.splice(i, 1);
      saveTemplates();
      renderTemplates();
    });

    container.appendChild(div);
  });
}

function saveTemplates() {
  localStorage.setItem('templates', JSON.stringify(templates));
}

function updateTargetCount() {
  const raw = $('blast-targets').value;
  const nums = parseTargets(raw);
  $('target-count').textContent = nums.length;
}

function parseTargets(raw) {
  return raw
    .split(/[\n,]+/)
    .map(s => s.trim().replace(/\D/g, ''))
    .filter(s => s.length >= 8 && s.length <= 15);
}

function startBlast() {
  if (blastRunning) return;

  const sender = $('blast-sender').value;
  if (!sender) { showToast('Pilih nomor pengirim dahulu', 'error'); return; }

  const raw = $('blast-targets').value;
  const targets = parseTargets(raw);
  if (!targets.length) { showToast('Masukkan nomor target yang valid', 'error'); return; }

  const tpls = templates.filter(t => t.trim().length > 0);
  if (!tpls.length) { showToast('Isi minimal 1 template pesan', 'error'); return; }

  const delay = parseInt($('blast-delay').value) || 3;

  showConfirm(
    'Mulai Blast?',
    `Akan mengirim ke ${targets.length} nomor dengan ${tpls.length} template. Lanjutkan?`,
    () => {
      const blastId = 'blast_' + Date.now();
      $('start-blast').disabled = true;
      $('start-blast').textContent = 'SENDING...';
      $('blast-log').innerHTML = '';

      socket.emit('start_blast', {
        blastId,
        senderPhone: sender,
        targets,
        templates: tpls,
        delaySeconds: delay
      });
    }
  );
}

function refreshBlastSenderOptions() {
  const sel = $('blast-sender');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Pilih Nomor —</option>';

  Object.entries(sessions).forEach(([phone, data]) => {
    if (data.status === 'connected') {
      const opt = document.createElement('option');
      opt.value = phone;
      opt.textContent = phone;
      sel.appendChild(opt);
    }
  });

  if (prev) sel.value = prev;
}

// ═══════════════ PAIRING PAGE ══════════════════════════════════════════════════

function setupPairingPage() {
  $('req-pairing').addEventListener('click', requestPairing);
  $('pairing-phone').addEventListener('keydown', e => {
    if (e.key === 'Enter') requestPairing();
  });
}

function requestPairing() {
  const phone = $('pairing-phone').value.trim().replace(/\D/g, '');
  if (!phone || phone.length < 8) {
    setPairingStatus('Masukkan nomor yang valid', 'error');
    return;
  }

  $('code-display').style.display = 'none';
  setPairingStatus('Meminta pairing code...', 'loading');
  $('req-pairing').disabled = true;

  setTimeout(() => { $('req-pairing').disabled = false; }, 15000);

  socket.emit('request_pairing', { phone });
}

function setPairingStatus(msg, type) {
  const el = $('pairing-status');
  el.textContent = msg;
  el.className = `pairing-status ${type || ''}`;
}

// ═══════════════ NUMBERS PAGE ══════════════════════════════════════════════════

function setupNumbersPage() {
  $('add-number-btn').addEventListener('click', addNumber);
  $('new-number-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addNumber();
  });
  $('check-all-status').addEventListener('click', checkAllStatus);
  $('refresh-all-status').addEventListener('click', refreshAllStatus);
}

function addNumber() {
  const phone = $('new-number-input').value.trim().replace(/\D/g, '');
  if (!phone || phone.length < 8 || phone.length > 15) {
    showToast('Nomor tidak valid (8-15 digit)', 'error');
    return;
  }

  if (savedNumbers.includes(phone)) {
    showToast('Nomor sudah ada dalam daftar', 'error');
    return;
  }

  savedNumbers.push(phone);
  localStorage.setItem('saved_numbers', JSON.stringify(savedNumbers));
  $('new-number-input').value = '';
  renderNumbersList();
  renderHomeNumbers();
  showToast(`Nomor ${phone} ditambahkan`, 'success');
}

function deleteNumber(phone) {
  showConfirm(
    'Hapus Nomor?',
    `Hapus ${phone} dari daftar? Sesi WhatsApp juga akan diputus.`,
    () => {
      savedNumbers = savedNumbers.filter(n => n !== phone);
      localStorage.setItem('saved_numbers', JSON.stringify(savedNumbers));
      socket.emit('disconnect_number', { phone });
      renderNumbersList();
      renderHomeNumbers();
      showToast(`Nomor ${phone} dihapus`, 'warning');
    }
  );
}

function connectNumber(phone) {
  navigateTo('pairing');
  $('pairing-phone').value = phone;
  setTimeout(() => {
    $('code-display').style.display = 'none';
    setPairingStatus('Meminta pairing code...', 'loading');
    socket.emit('request_pairing', { phone });
  }, 300);
}

function checkStatus(phone) {
  socket.emit('check_status', { phone });
}

function checkAllStatus() {
  savedNumbers.forEach(phone => socket.emit('check_status', { phone }));
  showToast('Mengecek semua status...', 'info');
}

function refreshAllStatus() {
  checkAllStatus();
}

function renderNumbersList() {
  const container = $('numbers-list-container');
  if (!savedNumbers.length) {
    container.innerHTML = '<div class="empty-state">Belum ada nomor terdaftar. Tambahkan nomor di atas.</div>';
    return;
  }

  container.innerHTML = '';
  savedNumbers.forEach(phone => {
    const session = sessions[phone];
    const status = session?.status || 'offline';
    const row = buildNumberRow(phone, status, true);
    container.appendChild(row);
  });
}

function renderHomeNumbers() {
  const container = $('home-numbers-list');
  if (!savedNumbers.length) {
    container.innerHTML = '<div class="empty-state">Belum ada nomor terdaftar</div>';
    return;
  }

  container.innerHTML = '';
  savedNumbers.forEach(phone => {
    const session = sessions[phone];
    const status = session?.status || 'offline';
    const row = buildNumberRow(phone, status, false);
    container.appendChild(row);
  });

  // Update active count
  stats.active = Object.values(sessions).filter(s => s.status === 'connected').length;
  renderStats();
}

function buildNumberRow(phone, status, showActions) {
  const row = document.createElement('div');
  row.className = 'number-row';
  row.id = `row-${phone}`;

  const badgeMap = {
    connected:    ['ACTIVE',      'active'],
    banned:       ['BAN',         'banned'],
    limited:      ['BATASI',      'limited'],
    connecting:   ['CONNECTING',  'connecting'],
    reconnecting: ['RECONNECTING','reconnecting'],
    disconnected: ['TIDAK ACTIVE','disconnected'],
    offline:      ['TIDAK ACTIVE','offline']
  };

  const [label, cls] = badgeMap[status] || ['TIDAK ACTIVE', 'offline'];

  let actionsHtml = '';
  if (showActions) {
    actionsHtml = `
      <div class="num-actions">
        <button class="btn-connect" data-phone="${escAttr(phone)}" title="Connect">CONNECT</button>
        <button class="btn-check" data-phone="${escAttr(phone)}" title="Cek status">CEK</button>
        <button class="btn-delete" data-phone="${escAttr(phone)}" title="Hapus">HAPUS</button>
      </div>
    `;
  }

  row.innerHTML = `
    <div class="num-status ${cls}"></div>
    <span class="num-phone">${escHtml(phone)}</span>
    <span class="num-badge badge-${cls}">${label}</span>
    ${actionsHtml}
  `;

  if (showActions) {
    row.querySelector('.btn-connect')?.addEventListener('click', () => connectNumber(phone));
    row.querySelector('.btn-check')?.addEventListener('click', () => checkStatus(phone));
    row.querySelector('.btn-delete')?.addEventListener('click', () => deleteNumber(phone));
  }

  return row;
}

function renderPairingSessions() {
  const container = $('pairing-sessions-list');

  const active = Object.entries(sessions).filter(([, s]) => s.status === 'connected');
  if (!active.length) {
    container.innerHTML = '<div class="empty-state">Belum ada sesi aktif</div>';
    return;
  }

  container.innerHTML = '';
  active.forEach(([phone]) => {
    const row = buildNumberRow(phone, 'connected', false);
    container.appendChild(row);
  });
}

function renderAllSessionsUI() {
  renderNumbersList();
  renderHomeNumbers();
  renderPairingSessions();
  refreshBlastSenderOptions();

  // Update active count
  stats.active = Object.values(sessions).filter(s => s.status === 'connected').length;
  renderStats();
}

// ═══════════════ STATS ═══════════════════════════════════════════════════════

function renderStats() {
  $('stat-sent').textContent    = stats.sent;
  $('stat-failed').textContent  = stats.failed;
  $('stat-pending').textContent = stats.pending;
  $('stat-active').textContent  = stats.active;
}

// ═══════════════ LOG ══════════════════════════════════════════════════════════

function addLog(message, type = 'info', timestamp = null) {
  const log = $('monitor-log');
  const time = timestamp || new Date().toLocaleTimeString('id-ID');

  // Limit to 100 entries
  const entries = log.querySelectorAll('.log-entry');
  if (entries.length >= 100) entries[0].remove();

  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.innerHTML = `<span class="log-time">${escHtml(time)}</span><span class="log-msg">${escHtml(message)}</span>`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function addBlastLog(message, type = 'info') {
  const log = $('blast-log');
  if (!log) return;
  const time = new Date().toLocaleTimeString('id-ID');

  const entries = log.querySelectorAll('.log-entry');
  if (entries.length >= 100) entries[0].remove();

  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.innerHTML = `<span class="log-time">${escHtml(time)}</span><span class="log-msg">${escHtml(message)}</span>`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

$('clear-log').addEventListener('click', () => {
  $('monitor-log').innerHTML = '';
  addLog('Log dibersihkan', 'info');
});

// ═══════════════ STATUS HELPERS ══════════════════════════════════════════════

function setConnStatus(online) {
  const el = $('conn-indicator');
  const dot = el.querySelector('.conn-dot');
  const label = el.querySelector('.conn-label');
  if (online) {
    el.classList.add('online');
    label.textContent = 'ONLINE';
  } else {
    el.classList.remove('online');
    label.textContent = 'OFFLINE';
  }
}

// ═══════════════ CONFIRM DIALOG ═══════════════════════════════════════════════

let confirmCallback = null;

function showConfirm(title, body, onConfirm) {
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-modal').style.display = 'flex';
  confirmCallback = onConfirm;
}

$('confirm-ok').addEventListener('click', () => {
  $('confirm-modal').style.display = 'none';
  if (confirmCallback) { confirmCallback(); confirmCallback = null; }
});

$('confirm-cancel').addEventListener('click', () => {
  $('confirm-modal').style.display = 'none';
  confirmCallback = null;
});

// ═══════════════ TOAST ════════════════════════════════════════════════════════

function showToast(msg, type = 'info') {
  addLog(msg, type);
}

// ═══════════════ AUTO REFRESH ═════════════════════════════════════════════════

function startAutoRefresh() {
  // Auto check status every 30 seconds
  setInterval(() => {
    savedNumbers.forEach(phone => socket.emit('check_status', { phone }));
  }, 30000);
}

// ═══════════════ SECURITY HELPERS ════════════════════════════════════════════

function escHtml(str) {
  if (typeof str !== 'string') str = String(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escAttr(str) {
  return escHtml(str);
}
