'use strict';
// WhatsApp conectado pelo QR Code ("Aparelhos conectados" no celular da empresa), usando a biblioteca Baileys.
// Só ENVIA alertas para a equipe; não lê conversas. A sessão (equivale a estar logado no número) fica
// criptografada no banco. Os envios saem um por vez, com uma pausa sorteada entre o mínimo e o máximo
// configurados (15 a 60 s), para o número se comportar como uma pessoa e não como um disparador.
const QRCode = require('qrcode');
const { get, all, run, audit } = require('./db');
const { encrypt, decrypt } = require('./vault');
const { getSettings } = require('./settings');

const STATE_KEY = 'state.waQr';
const QR_MAX = 6; // QR Codes gerados (~20 s cada) sem leitura antes de desistir
const DISCONNECTED_GIVE_UP_MS = 24 * 3_600_000;

let lib = null;          // módulo baileys (carregado sob demanda)
let sock = null;
let transport = null;    // envio de teste (substitui a conexão real nos testes automáticos)
let timer = null;
let reconnectTimer = null;
let sending = false;
let status = { state: 'off', qr: null, qrAt: null, me: null, since: null, lastError: null };
const jidCache = new Map();

const persisted = () => { try { return JSON.parse(get('SELECT value FROM settings WHERE key = ?', STATE_KEY)?.value || '{}'); } catch { return {}; } };
const persist = (patch) => run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', STATE_KEY, JSON.stringify({ ...persisted(), ...patch }));
const cfg = () => getSettings().whatsapp;

// ------------------------------------------------------------------ sessão criptografada no banco
function readKey(k) {
  const row = get('SELECT v FROM wa_auth WHERE k = ?', k);
  if (!row) return null;
  try { return JSON.parse(decrypt(row.v), lib.BufferJSON.reviver); } catch { return null; }
}
function writeKey(k, value) {
  if (value === null || value === undefined) return run('DELETE FROM wa_auth WHERE k = ?', k);
  run('INSERT INTO wa_auth (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, encrypt(JSON.stringify(value, lib.BufferJSON.replacer)));
}
const hasSession = () => !!get("SELECT 1 AS x FROM wa_auth WHERE k = 'creds'");
const clearSession = () => run('DELETE FROM wa_auth');

function dbAuthState() {
  const creds = readKey('creds') || lib.initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const id of ids) {
            let v = readKey(`${type}-${id}`);
            if (type === 'app-state-sync-key' && v) v = lib.proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }
          return out;
        },
        set: async (data) => { for (const cat in data) for (const id in data[cat]) writeKey(`${cat}-${id}`, data[cat][id]); },
      },
    },
    saveCreds: async () => writeKey('creds', creds),
  };
}

// A biblioteca espera um "logger" no formato do pino; aqui ela fica em silêncio.
const silent = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return silent; } };

// ------------------------------------------------------------------ conexão
async function connect() {
  if (transport) { status = { ...status, state: 'connected', since: status.since || Date.now() }; startWorker(); return status; }
  if (sock && ['connecting', 'qr', 'connected'].includes(status.state)) return status;
  lib = lib || await import('baileys');
  status = { ...status, state: 'connecting', qr: null, lastError: null };
  let qrCount = 0;
  const { state, saveCreds } = dbAuthState();
  const s = lib.makeWASocket({
    auth: { creds: state.creds, keys: lib.makeCacheableSignalKeyStore(state.keys, silent) },
    logger: silent, browser: lib.Browsers.ubuntu('Pesquisa de Satisfação'),
    markOnlineOnConnect: false, syncFullHistory: false, getMessage: async () => undefined,
  });
  sock = s;
  s.ev.on('creds.update', saveCreds);
  s.ev.on('connection.update', async (u) => {
    if (sock !== s) return;
    if (u.qr) {
      qrCount++;
      if (qrCount > QR_MAX) {
        status = { ...status, state: 'off', qr: null, lastError: 'O QR Code expirou sem ser lido. Clique em "Gerar QR Code" para tentar de novo.' };
        sock = null; try { s.end(undefined); } catch { /* */ }
        return;
      }
      status = { ...status, state: 'qr', qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 280, errorCorrectionLevel: 'L' }), qrAt: Date.now() };
    }
    if (u.connection === 'open') {
      const number = String(s.user?.id || '').split(/[:@]/)[0];
      status = { state: 'connected', qr: null, qrAt: null, me: { number, name: s.user?.name || s.user?.verifiedName || null }, since: Date.now(), lastError: null };
      persist({ retries: 0 });
      startWorker();
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      sock = null; jidCache.clear();
      if (code === lib.DisconnectReason.loggedOut || code === lib.DisconnectReason.forbidden) {
        clearSession();
        status = { state: 'off', qr: null, qrAt: null, me: null, since: null, lastError: 'O WhatsApp foi desconectado pelo celular. Gere um novo QR Code para conectar de novo.' };
        audit(null, 'whatsapp.logged_out', { code }, null);
        warnAdmins();
        return;
      }
      if (status.state === 'off') return; // QR expirado ou desconexão pedida
      // Queda de rede, reinício pedido pelo WhatsApp etc.: tenta de novo sozinho, com intervalo crescente.
      const wait = code === lib.DisconnectReason.restartRequired ? 500 : Math.min(60_000, 5_000 * 2 ** (persisted().retries || 0));
      persist({ retries: Math.min(5, (persisted().retries || 0) + 1) });
      status = { ...status, state: 'connecting', qr: null, lastError: code ? `Conexão caiu (código ${code}). Reconectando…` : 'Reconectando…' };
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connect().catch((e) => { status = { ...status, state: 'error', lastError: e.message }; }), wait);
      reconnectTimer.unref?.();
    }
  });
  return status;
}

async function disconnect() {
  clearTimeout(reconnectTimer);
  const s = sock; sock = null;
  status = { state: 'off', qr: null, qrAt: null, me: null, since: null, lastError: null };
  if (s) { try { await s.logout(); } catch { /* sem conexão: apaga a sessão mesmo assim */ } try { s.end(undefined); } catch { /* */ } }
  clearSession(); jidCache.clear();
  if (transport) transport = null;
}

// Ao subir o servidor: reconecta se o modo QR estiver ligado e houver sessão salva.
function boot() {
  if (cfg().mode !== 'qr') return;
  // A fila anda mesmo sem sessão: assim os avisos parados vencem em 24 h em vez de ficarem pendentes para sempre.
  startWorker();
  if (hasSession()) connect().catch((e) => { status = { ...status, state: 'error', lastError: e.message }; });
}

// Aviso por e-mail aos administradores quando o celular desconecta o sistema.
function warnAdmins() {
  try {
    const { queueEmail, renderEmail } = require('./notify');
    const { publicUrl } = require('./config');
    const brand = getSettings();
    const { html, text } = renderEmail({ brand, title: 'WhatsApp desconectado',
      intro: 'O número usado para os alertas foi desconectado (pelo celular ou pelo próprio WhatsApp). Os alertas por WhatsApp ficam guardados na fila por até 24 horas. Entre no painel e leia o QR Code de novo.',
      button: { label: 'Conectar de novo', url: `${publicUrl}/admin/#/configuracoes` } });
    // Quem pode reconectar: administradores e perfis com "Conectar e desconectar o WhatsApp".
    const { can } = require('./permissions');
    const to = all('SELECT id, email, role, role_id FROM users WHERE active = 1').filter((u) => can(u, 'cfg_envios', 'whatsapp'));
    for (const u of to) queueEmail({ to: u.email, subject: `${brand.companyName}: WhatsApp desconectado`, text, html, kind: 'whatsapp_down' });
  } catch (e) { console.error('[whatsapp] aviso', e.message); }
}

// ------------------------------------------------------------------ fila com intervalo
const randomGap = () => {
  const { minDelaySec: min, maxDelaySec: max } = cfg();
  return (min + Math.floor(Math.random() * (max - min + 1))) * 1000;
};

// Enfileira uma mensagem já com o horário de envio sorteado: o primeiro sai na hora (se o número estava parado)
// e cada um dos seguintes espera de 15 a 60 s depois do anterior. Fila com teto: se o próximo horário livre
// estiver a mais de 2 horas (rajada de alertas), a mensagem é registrada como não enviada em vez de atrasar
// todas as próximas por horas e arriscar o número da empresa.
const MAX_BACKLOG_MS = 2 * 3_600_000;
function queue(phone, text, kind, label = null, responseId = null) {
  const now = Date.now();
  const last = Number(persisted().lastSlot || 0);
  const gap = randomGap();
  const at = Math.max(now, last + gap);
  const payload = JSON.stringify({ mode: 'qr', text: String(text).slice(0, 4000), label, gap: at === now ? 0 : gap });
  if (at - now > MAX_BACKLOG_MS) {
    run("INSERT INTO outbox (kind, channel, recipient, payload, status, last_error, next_attempt_at, created_at, response_id) VALUES (?,?,?,?,'failed',?,?,?,?)",
      kind, 'whatsapp', phone, payload, 'Fila do WhatsApp cheia (mais de 2 horas de mensagens): não enviada.', now, now, responseId);
    return null;
  }
  persist({ lastSlot: at });
  run('INSERT INTO outbox (kind, channel, recipient, payload, next_attempt_at, created_at, response_id) VALUES (?,?,?,?,?,?,?)',
    kind, 'whatsapp', phone, payload, at, now, responseId);
  return at;
}

async function jidFor(phone) {
  if (jidCache.has(phone)) return jidCache.get(phone);
  const [r] = (await sock.onWhatsApp(phone)) || [];
  if (!r?.exists) throw new Error('Este número não tem WhatsApp.');
  jidCache.set(phone, r.jid);
  return r.jid;
}

async function sendNow(phone, text) {
  if (transport) return transport.send(phone, text);
  if (!sock || status.state !== 'connected') throw new Error('WhatsApp desconectado.');
  // Sem prévia de link: a biblioteca buscaria o endereço citado no texto (que pode vir de um cliente).
  await sock.sendMessage(await jidFor(phone), { text, linkPreview: null });
}

// Um envio por vez. Nunca manda dois seguidos antes do intervalo mínimo, nem se o servidor ficou parado.
async function processQueue(now = Date.now()) {
  if (sending) return 0;
  sending = true;
  try {
    const item = get("SELECT * FROM outbox WHERE status = 'pending' AND channel = 'whatsapp' AND payload LIKE '%\"mode\":\"qr\"%' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT 1", now);
    if (!item) return 0;
    if (status.state !== 'connected') {
      if (item.created_at < now - DISCONNECTED_GIVE_UP_MS) run("UPDATE outbox SET status = 'failed', last_error = ? WHERE id = ?", 'WhatsApp ficou desconectado por mais de 24 horas.', item.id);
      else run('UPDATE outbox SET next_attempt_at = ?, last_error = ? WHERE id = ?', now + 60_000, 'Aguardando o WhatsApp reconectar.', item.id);
      return 0;
    }
    const lastSent = Number(persisted().lastSent || 0);
    const min = cfg().minDelaySec * 1000;
    if (lastSent && now - lastSent < min) {
      // Atrasou (ex.: servidor reiniciou): reagenda respeitando a pausa mínima.
      run('UPDATE outbox SET next_attempt_at = ? WHERE id = ?', lastSent + randomGap(), item.id);
      return 0;
    }
    const p = JSON.parse(item.payload);
    try {
      await sendNow(item.recipient, p.text);
      run("UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?", now, item.id);
      persist({ lastSent: now });
      return 1;
    } catch (e) {
      const attempts = item.attempts + 1;
      const done = attempts >= 4 || /não tem WhatsApp/.test(e.message);
      run('UPDATE outbox SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ? WHERE id = ?',
        attempts, done ? 'failed' : 'pending', now + attempts * 2 * 60_000, String(e.message).slice(0, 300), item.id);
      persist({ lastSent: now });
      return 0;
    }
  } finally { sending = false; }
}

function startWorker() {
  if (timer) return;
  timer = setInterval(() => processQueue().catch((e) => console.error('[whatsapp]', e.message)), 3_000);
  timer.unref?.();
}

// Fila para a tela: próximos envios com horário e pausa sorteada, e os últimos enviados.
function queueView() {
  const rows = all(`SELECT id, kind, recipient, payload, status, next_attempt_at, sent_at, last_error, created_at FROM outbox
    WHERE channel = 'whatsapp' AND payload LIKE '%"mode":"qr"%' AND (status = 'pending' OR created_at > ?) ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, next_attempt_at DESC LIMIT 40`,
  Date.now() - 86_400_000);
  return rows.map((r) => {
    let p = {}; try { p = JSON.parse(r.payload); } catch { /* */ }
    return { id: r.id, kind: r.kind, to: p.label || r.recipient, status: r.status, at: r.status === 'sent' ? r.sent_at : r.next_attempt_at, gapSec: p.gap ? Math.round(p.gap / 1000) : 0, error: r.last_error };
  });
}

const publicStatus = ({ withQr = false } = {}) => ({ ...status, qr: withQr ? status.qr : null, hasSession: hasSession() || !!transport });
const connected = () => status.state === 'connected';

// Somente para os testes automáticos: troca a conexão real por um envio simulado.
function useTransportForTests(t) { transport = t; if (t) { status = { state: 'connected', qr: null, qrAt: null, me: { number: '5511900000000', name: 'Teste' }, since: Date.now(), lastError: null }; } else status = { state: 'off', qr: null, qrAt: null, me: null, since: null, lastError: null }; }
function stopWorker() { clearInterval(timer); timer = null; }

module.exports = { connect, disconnect, boot, queue, processQueue, queueView, publicStatus, connected, useTransportForTests, stopWorker, sendNow };
