'use strict';
// WhatsApp por QR Code: fila, validação e pausa. O painel e o servidor só leem e gravam no banco;
// quem fala com o WhatsApp é o serviço separado (wa-worker.js), para uma falha lá não derrubar as pesquisas.
const fs = require('node:fs');
const path = require('node:path');
const { get, all, run, MEDIA_DIR } = require('./db');
const { getSettings } = require('./settings');

const INTERVAL_MIN_MS = 30_000;
const INTERVAL_MAX_MS = 80_000;
const CHECK_PAUSE_MS = 5_000; // número sem WhatsApp não gera envio: só uma pausa curta até o próximo
const WORKER_STALE_MS = 30_000;
const PRIORITY = { thanks: 0, test: 0, alert: 1, report: 2 };
const NOT_ON_WHATSAPP = 'Número não está no WhatsApp';
const CONNECTION_DOWN = 'Conexão do WhatsApp caída';
const FILES_DIR = () => path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'wa-files');

const state = () => get('SELECT * FROM wa_state WHERE id = 1');
function setState(patch) {
  const keys = Object.keys(patch);
  run(`UPDATE wa_state SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = 1`, ...keys.map((k) => patch[k]), Date.now());
}
const isEnabled = () => state().enabled === 1;
// Ativo = conectado e com o serviço respondendo.
function isConnected(s = state()) { return s.status === 'connected' && Date.now() - (s.worker_at || 0) < WORKER_STALE_MS; }

// Padrão Brasil (+55): DDD + número recebe o código do país; número já com país é mantido.
function normalizePhone(phone, country = getSettings().whatsappCountry) {
  const d = String(phone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (/^\d{10,11}$/.test(d)) return country + d;
  return /^\d{12,15}$/.test(d) ? d : null;
}

function queue({ kind, recipient, body = null, mediaId = null, filePath = null, fileName = null, branchId = null, responseId = null, createdBy = null, force = false }) {
  const st = state();
  if (!st.enabled && !force) return null;
  const to = normalizePhone(recipient);
  const now = Date.now();
  let status = st.status === 'connected' ? 'queued' : 'paused';
  let reason = status === 'paused' ? CONNECTION_DOWN : null;
  if (!st.enabled) { status = 'failed'; reason = 'WhatsApp por QR Code não conectado'; }
  if (!to) { status = 'failed'; reason = 'Número inválido'; }
  return Number(run(`INSERT INTO wa_messages (kind, priority, recipient, body, media_id, file_path, file_name, branch_id, response_id, status, reason, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, kind, PRIORITY[kind] ?? 1, to || String(recipient ?? ''), body, mediaId, filePath, fileName, branchId, responseId, status, reason, createdBy, now, now).lastInsertRowid);
}

// Agradecimento: o modelo ativo, para quem deixou telefone e autorizou o contato.
function queueThanks({ branch, responseId, name, phone }) {
  const cfg = getSettings().whatsappThanks;
  if (!cfg.enabled || !phone || !isEnabled()) return null;
  const tpl = cfg.templates.find((t) => t.id === cfg.activeId);
  if (!tpl) return null;
  const body = tpl.text.replaceAll('{nome}', name || '').replaceAll('{filial}', branch.name).replace(/ {2,}/g, ' ').replace(/ ([,.!?])/g, '$1').trim();
  return queue({ kind: 'thanks', recipient: phone, body, mediaId: tpl.mediaId || null, branchId: branch.id, responseId });
}

// Conexão caiu: nada sai sozinho até alguém escolher reenviar.
function pauseAll() {
  return run("UPDATE wa_messages SET status = 'paused', reason = ?, updated_at = ? WHERE status IN ('queued','sending')", CONNECTION_DOWN, Date.now()).changes;
}

// O que será enviado. Áudio não tem legenda no WhatsApp: o texto vai em seguida, em outra mensagem.
function contentsFor(m) {
  if (m.file_path) return [{ document: { url: m.file_path }, fileName: m.file_name || 'relatorio.pptx', mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ...(m.body ? { caption: m.body } : {}) }];
  const media = m.media_id ? get('SELECT id, mime FROM media WHERE id = ?', m.media_id) : null;
  if (!media) return [{ text: m.body || '' }];
  const url = path.join(MEDIA_DIR, media.id);
  const caption = m.body ? { caption: m.body } : {};
  if (media.mime.startsWith('image/')) return [{ image: { url }, ...caption }];
  if (media.mime.startsWith('video/')) return [{ video: { url }, mimetype: media.mime, ...caption }];
  return [{ audio: { url }, mimetype: media.mime }, ...(m.body ? [{ text: m.body }] : [])];
}

const removeFile = (p) => { if (p) fs.rm(p, { force: true }, () => {}); };
const randomInterval = (rng = Math.random) => INTERVAL_MIN_MS + Math.floor(rng() * (INTERVAL_MAX_MS - INTERVAL_MIN_MS + 1));
const finish = (id, status, reason, extra = null) => run(`UPDATE wa_messages SET status = ?, reason = ?, updated_at = ?${extra ? ', sent_at = ?' : ''} WHERE id = ?`, status, reason, Date.now(), ...(extra ? [extra] : []), id);

// Envia a próxima da fila: agradecimento na frente de alertas, e alertas na frente de relatórios. Devolve quanto esperar.
async function processNext({ check, send, rng }) {
  const m = get("SELECT * FROM wa_messages WHERE status = 'queued' ORDER BY priority, id LIMIT 1");
  if (!m) return null;
  run("UPDATE wa_messages SET status = 'sending', updated_at = ? WHERE id = ?", Date.now(), m.id);
  try {
    const jid = await check(m.recipient);
    if (!jid) {
      finish(m.id, 'failed', NOT_ON_WHATSAPP);
      removeFile(m.file_path);
      return { id: m.id, status: 'failed', wait: CHECK_PAUSE_MS };
    }
    for (const content of contentsFor(m)) await send(jid, content);
    finish(m.id, 'sent', null, Date.now());
    removeFile(m.file_path);
    return { id: m.id, status: 'sent', wait: randomInterval(rng) };
  } catch (e) {
    if (e.connectionLost || state().status !== 'connected') {
      finish(m.id, 'paused', CONNECTION_DOWN);
      return { id: m.id, status: 'paused', wait: 0 };
    }
    finish(m.id, 'failed', String(e.message || 'Erro no envio').slice(0, 300));
    removeFile(m.file_path);
    return { id: m.id, status: 'failed', wait: CHECK_PAUSE_MS };
  }
}

// Reenvio escolhido por pessoa: só o que foi pausado volta para a fila.
function resend(ids, allowed) {
  let n = 0;
  for (const id of ids) {
    const m = get("SELECT id, branch_id FROM wa_messages WHERE id = ? AND status = 'paused'", id);
    if (m && allowed(m)) { run("UPDATE wa_messages SET status = 'queued', reason = NULL, updated_at = ? WHERE id = ?", Date.now(), m.id); n++; }
  }
  return n;
}

function saveFile(buffer) {
  fs.mkdirSync(FILES_DIR(), { recursive: true });
  const p = path.join(FILES_DIR(), `${require('node:crypto').randomBytes(16).toString('hex')}.pptx`);
  fs.writeFileSync(p, buffer, { mode: 0o600 });
  return p;
}

// Limpeza: mensagens finalizadas há mais de 90 dias, como no histórico de e-mails.
function cleanup(now = Date.now()) {
  const old = now - 90 * 86_400_000;
  for (const m of all("SELECT file_path FROM wa_messages WHERE file_path IS NOT NULL AND updated_at < ?", old)) removeFile(m.file_path);
  return run("DELETE FROM wa_messages WHERE status IN ('sent','failed','paused') AND updated_at < ?", old).changes;
}

module.exports = { INTERVAL_MIN_MS, INTERVAL_MAX_MS, NOT_ON_WHATSAPP, CONNECTION_DOWN, state, setState, isEnabled, isConnected, normalizePhone, queue, queueThanks,
  pauseAll, contentsFor, randomInterval, processNext, resend, saveFile, cleanup };
