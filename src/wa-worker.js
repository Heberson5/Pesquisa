'use strict';
// Serviço separado do WhatsApp por QR Code. Conversa com o painel pelo banco (tabela wa_state e fila wa_messages).
// Se cair ou travar, as pesquisas continuam: só os envios por QR Code ficam parados.
const fs = require('node:fs');
const path = require('node:path');
const { all } = require('./db');
const wa = require('./wa');
const { queueEmail, renderEmail } = require('./notify');
const { getSettings } = require('./settings');
const { publicUrl } = require('./config');

const AUTH_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'wa-session');
const LOOP_MS = 2_000;
const silent = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return silent; } };

let lib = null; let sock = null; let attempts = 0; let downNotified = false; let reconnectTimer = null; let busy = false;
const hasSession = () => fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
const clearSession = () => fs.rmSync(AUTH_DIR, { recursive: true, force: true });
const log = (...a) => process.stdout.write(`${new Date().toISOString()} [whatsapp] ${a.join(' ')}
`);
// A biblioteca de criptografia imprime chaves da sessão no console: nada disso pode ir para os logs do servidor.
for (const level of ['log', 'info', 'warn', 'debug', 'error']) console[level] = () => {};

function closeSocket() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const s = sock; sock = null;
  if (s) { try { s.ev.removeAllListeners('connection.update'); s.end(undefined); } catch { /* já fechado */ } }
}

// Avisa os administradores uma vez por queda: ninguém fica olhando a tela, e os envios ficam parados.
function notifyDown() {
  if (downNotified) return;
  downNotified = true;
  const s = getSettings();
  const { html, text } = renderEmail({ brand: s, title: 'WhatsApp desconectado', intro: 'A conexão do WhatsApp por QR Code caiu. Os envios foram pausados e só voltam quando alguém escolher reenviar.', rows: [],
    button: { label: 'Abrir envios', url: `${publicUrl}/admin/#/envios` }, footer: 'Aviso automático do painel.' });
  for (const u of all("SELECT email FROM users WHERE role = 'admin' AND active = 1")) queueEmail({ to: u.email, subject: '[Alerta] WhatsApp desconectado', text, html, kind: 'wa_down' });
}

async function connect() {
  closeSocket();
  lib = lib || await import('@whiskeysockets/baileys');
  const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = lib;
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  const hadSession = hasSession();
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const s = makeWASocket({ auth, version, logger: silent, browser: ['Pesquisa de Satisfação', 'Chrome', '1.0'], markOnlineOnConnect: false, syncFullHistory: false });
  sock = s;
  s.ev.on('creds.update', saveCreds);
  s.ev.on('connection.update', (u) => {
    if (s !== sock) return;
    if (u.qr) wa.setState({ status: 'qr', qr: u.qr, error: null });
    if (u.connection === 'open') {
      attempts = 0; downNotified = false;
      wa.setState({ status: 'connected', enabled: 1, qr: null, error: null, phone: String(s.user?.id || '').split(/[:@]/)[0] || null });
      log('conectado');
    }
    if (u.connection !== 'close') return;
    const code = u.lastDisconnect?.error?.output?.statusCode;
    const wasConnected = wa.state().status === 'connected';
    wa.pauseAll();
    if (code === DisconnectReason.loggedOut) {
      closeSocket(); clearSession();
      wa.setState({ status: 'off', qr: null, phone: null, error: 'A sessão foi encerrada no celular. Leia o QR Code de novo.' });
      if (wasConnected) notifyDown();
      return;
    }
    if (code === DisconnectReason.restartRequired) { reconnectTimer = setTimeout(() => connect().catch(fail), 500); return; }
    // QR Code não lido a tempo: para de tentar até alguém clicar em conectar de novo.
    if (!hadSession && !hasRegistration()) {
      closeSocket(); clearSession();
      wa.setState({ status: 'off', qr: null, error: 'O QR Code expirou. Clique em conectar para gerar outro.' });
      return;
    }
    if (wasConnected) notifyDown();
    attempts++;
    wa.setState({ status: 'reconnecting', qr: null, error: 'Conexão caída. Tentando reconectar; os envios ficam pausados.' });
    reconnectTimer = setTimeout(() => connect().catch(fail), Math.min(15_000 * attempts, 300_000));
  });
}

function hasRegistration() {
  try { return !!JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8')).me; } catch { return false; }
}

function fail(e) {
  log('erro ao conectar:', e.message);
  attempts++;
  wa.setState({ status: 'reconnecting', error: 'Não foi possível conectar. Tentando de novo.' });
  reconnectTimer = setTimeout(() => connect().catch(fail), Math.min(15_000 * attempts, 300_000));
}

const check = async (number) => {
  const [hit] = await sock.onWhatsApp(number);
  return hit?.exists ? hit.jid : null;
};
const send = (jid, content) => sock.sendMessage(jid, content);

async function loop() {
  if (busy) return;
  busy = true;
  try {
    const st = wa.state();
    wa.setState({ worker_at: Date.now() });
    if (st.command === 'connect') {
      wa.setState({ command: null, status: 'connecting', error: null });
      await connect();
    } else if (st.command === 'disconnect') {
      wa.setState({ command: null });
      try { if (sock) await sock.logout(); } catch { /* sem conexão: limpa do mesmo jeito */ }
      closeSocket(); clearSession();
      wa.pauseAll();
      wa.setState({ status: 'off', enabled: 0, qr: null, phone: null, error: null });
      return;
    }
    if (st.status !== 'connected' || !sock) { wa.pauseAll(); return; }
    if (Date.now() < (st.next_send_at || 0)) return;
    const r = await wa.processNext({ check, send });
    if (r) { wa.setState({ next_send_at: Date.now() + r.wait }); log('mensagem', r.id, r.status); }
  } catch (e) {
    log('erro:', e.message);
  } finally { busy = false; }
}

// Ao iniciar não há conexão ainda: o que estava na fila pausa e só sai com a escolha de alguém.
wa.pauseAll();
const boot = wa.state();
if (boot.enabled && hasSession()) {
  wa.setState({ status: 'reconnecting', qr: null, worker_at: Date.now() });
  connect().catch(fail);
} else if (boot.command !== 'connect') {
  wa.setState({ status: 'off', qr: null, worker_at: Date.now() });
}
setInterval(loop, LOOP_MS);
log('serviço iniciado');
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { closeSocket(); process.exit(0); });
