'use strict';
// Notificações com fila persistente (tabela outbox): e-mail (SMTP), webhook assinado e WhatsApp (API oficial da Meta).
// Tudo que é enviado passa pela fila, com novas tentativas e registro de erro — nada se perde se o SMTP cair.
const dns = require('node:dns');
const net = require('node:net');
const https = require('node:https');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const delivery = require('./delivery');
const { get, all, run } = require('./db');
const { sign } = require('./vault');

const BACKOFF_MIN = [1, 5, 30, 120, 360];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
const EMAIL_RE = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+$/;

const isEmail = (e) => typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Assuntos e cabeçalhos nunca podem conter quebra de linha (injeção de cabeçalho).
const oneLine = (s, max = 200) => String(s ?? '').replace(/[\r\n\t\u0000-\u001f]+/g, ' ').slice(0, max);

// ------------------------------------------------------------------ enfileiramento
function queueEmail({ to, subject, text, html, kind = 'email', attachment = null, attachmentName = null }) {
  if (!isEmail(to)) return false;
  run(`INSERT INTO outbox (kind, channel, recipient, subject, body_text, body_html, attachment, attachment_name, next_attempt_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, kind, 'email', to, oneLine(subject), text, html, attachment, attachmentName ? oneLine(attachmentName, 100) : null, Date.now(), Date.now());
  return true;
}

function queueWebhook(url, payload, kind) {
  run('INSERT INTO outbox (kind, channel, recipient, payload, next_attempt_at, created_at) VALUES (?,?,?,?,?,?)',
    kind, 'webhook', url, JSON.stringify(payload), Date.now(), Date.now());
}

function queueWhatsApp(phone, payload, kind) {
  run('INSERT INTO outbox (kind, channel, recipient, payload, next_attempt_at, created_at) VALUES (?,?,?,?,?,?)',
    kind, 'whatsapp', phone, JSON.stringify(payload), Date.now(), Date.now());
}

// ------------------------------------------------------------------ modelo de e-mail
// Todo conteúdo variável é escapado: comentários de clientes nunca viram HTML.
function renderEmail({ title, intro, rows = [], button = null, footer = '', brand = {} }) {
  const color = /^#[0-9a-f]{6}$/i.test(brand.primaryColor || '') ? brand.primaryColor : '#0f3d5e';
  const company = escapeHtml(brand.companyName || 'Pesquisa de Satisfação');
  const tableRows = rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#64748b;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 0;color:#0f172a">${escapeHtml(v)}</td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:${color};color:#fff;padding:18px 24px;font-weight:bold;font-size:16px">${company}</td></tr>
<tr><td style="padding:24px"><h1 style="margin:0 0 12px;font-size:20px;color:#0f172a">${escapeHtml(title)}</h1>
<p style="margin:0 0 16px;color:#334155;line-height:1.5">${escapeHtml(intro)}</p>
${tableRows ? `<table role="presentation" style="font-size:14px;margin-bottom:16px">${tableRows}</table>` : ''}
${button ? `<a href="${escapeHtml(button.url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">${escapeHtml(button.label)}</a>` : ''}
${footer ? `<p style="margin:20px 0 0;color:#94a3b8;font-size:12px">${escapeHtml(footer)}</p>` : ''}
</td></tr></table></td></tr></table></body></html>`;
  const text = [title, '', intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), button ? `\n${button.label}: ${button.url}` : '', footer ? `\n${footer}` : ''].join('\n');
  return { html, text };
}

// ------------------------------------------------------------------ proteção contra SSRF nos webhooks
// Bloqueia endereços internos (localhost, rede privada, metadados de nuvem etc.) — inclusive quando o
// domínio resolve para um IP interno (a checagem é feita no momento da conexão, contra "DNS rebinding").
function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return isPublicIp(x.slice(7));
    return !(x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') ||
      x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff') || x.startsWith('64:ff9b') || x.startsWith('2001:db8'));
  }
  return false;
}

function validateWebhookUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'URL inválida.'; }
  if (u.protocol !== 'https:') return 'O webhook precisa usar https.';
  if (u.username || u.password) return 'Não inclua usuário/senha na URL.';
  if (u.port && u.port !== '443') return 'Use a porta padrão 443.';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return 'Use um nome de domínio, não um IP.';
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) return 'Endereço interno não permitido.';
  return null;
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => !isPublicIp(a.address));
    if (bad || !addrs.length) return cb(new Error('Destino do webhook resolve para endereço interno — bloqueado.'));
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

function postJson(url, body, headers, { lookup } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', timeout: 8000, lookup, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'PesquisaSatisfacao/1.0', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado')));
    req.on('error', reject);
    req.end(body);
  });
}

// Segredo para o destino validar a assinatura do webhook (exibido ao admin em Configurações).
const webhookSecret = () => sign('webhook-secret-v1');

// ------------------------------------------------------------------ envio
let transport = null; let transportKey = ''; let transportAt = 0;
// O servidor SMTP é resolvido para um IP público e esse IP é "fixado" (evita apontar para a rede interna / rebinding).
async function mailer() {
  const c = delivery.smtp();
  if (!c) return null;
  const key = JSON.stringify([c.host, c.port, c.secure, c.auth?.user, c.auth?.pass]);
  if (!transport || key !== transportKey || Date.now() - transportAt > 10 * 60_000) {
    const ip = await delivery.resolvePublic(c.host);
    transport = nodemailer.createTransport({
      host: ip, port: c.port, secure: c.secure, auth: c.auth, name: 'pesquisa',
      requireTLS: !c.secure, tls: { minVersion: 'TLSv1.2', servername: c.host },
      disableFileAccess: true, disableUrlAccess: true, connectionTimeout: 10000, socketTimeout: 20000,
    });
    transportKey = key; transportAt = Date.now();
  }
  return { t: transport, from: c.from };
}

async function deliver(item) {
  if (item.channel === 'email') {
    const m = await mailer();
    if (!m) throw new Error('E-mail não configurado. Configure em Configurações → Alertas e envios.');
    await m.t.sendMail({
      from: m.from, to: item.recipient, subject: item.subject, text: item.body_text, html: item.body_html,
      disableFileAccess: true, disableUrlAccess: true,
      attachments: item.attachment ? [{ filename: item.attachment_name || 'anexo', content: Buffer.from(item.attachment) }] : [],
    });
  } else if (item.channel === 'webhook') {
    const err = validateWebhookUrl(item.recipient);
    if (err) throw new Error(err);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', webhookSecret()).update(`${ts}.${item.payload}`).digest('hex');
    await postJson(item.recipient, item.payload, { 'X-Pesquisa-Timestamp': ts, 'X-Pesquisa-Signature': `sha256=${sig}` }, { lookup: safeLookup });
  } else if (item.channel === 'whatsapp') {
    const wa = delivery.whatsapp();
    if (!wa) throw new Error('WhatsApp não configurado. Configure em Configurações → Alertas e envios.');
    const p = JSON.parse(item.payload);
    const body = JSON.stringify({
      messaging_product: 'whatsapp', to: item.recipient, type: 'template',
      template: { name: p.template, language: { code: p.language || 'pt_BR' },
        components: [{ type: 'body', parameters: p.params.map((t) => ({ type: 'text', text: oneLine(t, 300) })) }] },
    });
    await postJson(`https://graph.facebook.com/v21.0/${wa.phoneId}/messages`, body, { Authorization: `Bearer ${wa.token}` });
  }
}

let processing = false;
async function processOutbox(limit = 20) {
  if (processing) return 0;
  processing = true;
  let sent = 0;
  try {
    const items = all("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?", Date.now(), limit);
    for (const item of items) {
      try {
        await deliver(item);
        run("UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL, attachment = NULL WHERE id = ?", Date.now(), item.id);
        sent++;
      } catch (e) {
        const attempts = item.attempts + 1;
        const done = attempts >= MAX_ATTEMPTS;
        run('UPDATE outbox SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ? WHERE id = ?',
          attempts, done ? 'failed' : 'pending', Date.now() + (BACKOFF_MIN[attempts - 1] || 360) * 60_000, oneLine(e.message, 300), item.id);
      }
    }
    // Limpeza: registros enviados há mais de 90 dias.
    run("DELETE FROM outbox WHERE status = 'sent' AND sent_at < ?", Date.now() - 90 * 86_400_000);
  } finally { processing = false; }
  return sent;
}

// Confere o token e o número do WhatsApp na Meta (não envia mensagem nenhuma).
function whatsappCheck() {
  const wa = delivery.whatsapp();
  if (!wa) return Promise.reject(new Error('WhatsApp não configurado.'));
  return new Promise((resolve, reject) => {
    const req = https.request(`https://graph.facebook.com/v21.0/${wa.phoneId}?fields=display_phone_number,verified_name,quality_rating`,
      { method: 'GET', timeout: 8000, headers: { Authorization: `Bearer ${wa.token}`, 'User-Agent': 'PesquisaSatisfacao' } }, (res) => {
        let data = '';
        res.on('data', (c) => { if (data.length < 20000) data += c; });
        res.on('end', () => {
          let j = {}; try { j = JSON.parse(data); } catch { /* */ }
          if (res.statusCode === 200 && j.display_phone_number) return resolve({ number: j.display_phone_number, name: j.verified_name || null, quality: j.quality_rating || null });
          reject(new Error(oneLine(j.error?.message || `A Meta recusou (HTTP ${res.statusCode}). Confira o token e o identificador do número.`, 200)));
        });
      });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado ao falar com a Meta.')));
    req.on('error', reject);
    req.end();
  });
}

const outboxStatus = () => ({
  smtpConfigured: !!delivery.smtp(),
  whatsappConfigured: !!delivery.whatsapp(),
  pending: get("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'").n,
  failed: get("SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed' AND created_at > ?", Date.now() - 7 * 86_400_000).n,
});

module.exports = {
  isEmail, escapeHtml, oneLine, renderEmail, queueEmail, queueWebhook, queueWhatsApp, processOutbox, outboxStatus, whatsappCheck,
  validateWebhookUrl, isPublicIp, safeLookup, webhookSecret,
};
