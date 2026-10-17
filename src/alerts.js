'use strict';
// Cliente insatisfeito (nota de NPS de 0 a 6): abre um caso para tratamento e avisa os responsáveis.
// Webhook e WhatsApp recebem só o mínimo (filial, nota, link) — dados pessoais ficam no painel.
const { get, all, run, audit } = require('./db');
const { getSettings } = require('./settings');
const { queueEmail, queueWebhook, queueWhatsApp } = require('./notify');
const templates = require('./templates');
const whatsappQr = require('./whatsapp-qr');
const { decrypt } = require('./vault');
const { publicUrl } = require('./config');
const zones = require('./zones');
const { formatLocal } = require('./time');
const { accessFor } = require('./permissions');

const DETRACTOR_MAX = 6;
const parseList = (json) => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

// Usuários que recebem um aviso da filial: quem marcou a preferência em Minha conta, enxerga a filial
// e pode abrir a tela correspondente (casos, tablets ou visão geral).
const PREF_COLUMNS = { notify_detractors: 'casos', notify_reports: 'dashboard', notify_offline: 'tablets' };
function usersToNotify(branchId, prefColumn) {
  if (!Object.hasOwn(PREF_COLUMNS, prefColumn)) throw new Error('Preferência inválida.');
  const linked = new Set(all('SELECT user_id FROM user_branches WHERE branch_id = ?', branchId).map((x) => x.user_id));
  return all(`SELECT id, name, email, whatsapp, role, role_id FROM users WHERE active = 1 AND ${prefColumn} = 1`).filter((u) => {
    const a = (u.access = accessFor(u));
    if (!a.isAdmin && !a.perms.has(PREF_COLUMNS[prefColumn] + '.ver')) return false;
    return a.scopeAll || linked.has(u.id);
  });
}
// O contato do cliente só vai para quem tem "Casos · Ver contato do cliente" (o mesmo que o painel exige).
// Endereços avulsos cadastrados na filial seguem recebendo, como antes.
const seesContact = (u) => u.access.isAdmin || u.access.perms.has('casos.contato');

// Destinatários de WhatsApp: números da filial + WhatsApp pessoal de quem enxerga a filial e quis o aviso. Sem repetir.
function whatsappRecipients(branchId, prefColumn) {
  const out = new Map();
  for (const u of usersToNotify(branchId, prefColumn)) if (u.whatsapp) out.set(u.whatsapp, { name: u.name, contact: seesContact(u) });
  for (const p of parseList(get('SELECT alert_phones FROM branches WHERE id = ?', branchId)?.alert_phones)) if (!out.has(p)) out.set(p, { name: null, contact: true });
  return [...out].map(([phone, v]) => ({ phone, ...v }));
}

// Destinatários de e-mail de uma filial: lista da filial + usuários que querem o aviso. Sem repetir e-mail;
// o nome (quando é um usuário) entra no texto como {destinatario}.
function branchRecipientList(branchId, prefColumn) {
  const b = get('SELECT alert_emails FROM branches WHERE id = ?', branchId);
  const out = new Map();
  for (const u of usersToNotify(branchId, prefColumn)) out.set(String(u.email).toLowerCase(), { name: u.name, contact: seesContact(u) });
  for (const e of parseList(b?.alert_emails)) if (!out.has(String(e).toLowerCase())) out.set(String(e).toLowerCase(), { name: null, contact: true });
  return [...out].map(([email, v]) => ({ email, ...v }));
}

function onResponse(responseId) {
  const r = get(`SELECT r.*, b.name AS branch_name, b.timezone AS branch_tz FROM responses r JOIN branches b ON b.id = r.branch_id WHERE r.id = ?`, responseId);
  if (!r) return null;
  const score = get(`SELECT MIN(a.value_num) AS m FROM answers a JOIN questions q ON q.id = a.question_id AND q.is_nps = 1 WHERE a.response_id = ?`, responseId).m;
  if (score === null || score > DETRACTOR_MAX) return null;
  const now = Date.now();
  const ins = run('INSERT OR IGNORE INTO cases (response_id, branch_id, min_score, created_at, updated_at) VALUES (?,?,?,?,?)', responseId, r.branch_id, score, now, now);
  if (!ins.changes) return null;
  const caseId = Number(ins.lastInsertRowid);
  notifyDetractor(r, score, caseId);
  return caseId;
}

// Teto de avisos por filial: respostas falsas em massa (o QR Code é público) não podem inundar a equipe nem
// esgotar a cota de e-mail/WhatsApp da empresa. Os casos continuam sendo abertos; passado o teto, vai um único
// aviso de que os alertas da filial foram pausados por uma hora.
const ALERT_BURST = 10;
function overBurst(r, caseId) {
  const n = get('SELECT COUNT(*) AS n FROM cases WHERE branch_id = ? AND created_at > ? AND id <> ?', r.branch_id, Date.now() - 3_600_000, caseId).n;
  if (n < ALERT_BURST) return false;
  if (n === ALERT_BURST) {
    audit(null, 'alerts.throttled', { branchId: r.branch_id }, null);
    const brand = getSettings().companyName;
    for (const to of branchRecipientList(r.branch_id, 'notify_detractors')) {
      queueEmail({ to: to.email, kind: 'detractor_burst', subject: `${brand}: muitas notas baixas em ${r.branch_name}`,
        text: `Chegaram mais de ${ALERT_BURST} notas baixas em ${r.branch_name} na última hora. Para não encher sua caixa, os avisos individuais desta filial ficam pausados por uma hora. Todos os casos estão no painel, em Casos: ${publicUrl}/admin/#/casos` });
    }
  }
  return true;
}

function notifyDetractor(r, score, caseId) {
  if (overBurst(r, caseId)) return;
  const s = getSettings();
  const url = `${publicUrl}/admin/#/casos/${caseId}`;
  const comments = all(`SELECT q.text, a.value_text FROM answers a JOIN questions q ON q.id = a.question_id
      WHERE a.response_id = ? AND q.type = 'text' AND a.value_text IS NOT NULL`, r.id);
  const hasContact = !!r.contact_consent_at && !r.anonymized_at;
  // Hora local da resposta: fuso da filial ou do tablet que respondeu (o mesmo do "dia local" da resposta).
  const when = formatLocal(r.submitted_at, zones.forBranch({ id: r.branch_id, timezone: r.branch_tz }, r.device_id ? get('SELECT timezone FROM devices WHERE id = ?', r.device_id) : null));
  const contactName = hasContact ? decrypt(r.contact_name_enc) : null;
  const contactPhone = hasContact ? decrypt(r.contact_phone_enc) : null;
  // Variáveis dos modelos de mensagem (Configurações → Modelos de mensagem).
  const vars = { filial: r.branch_name, nota: String(score), data_hora: when, canal: r.channel === 'link' ? 'QR Code' : 'tablet',
    comentario: comments.map((c) => c.value_text).join(' / ').slice(0, 300), cliente: contactName || '', telefone_cliente: contactPhone || '', link_caso: url };
  const varsFor = (to) => ({ ...vars, destinatario: to.name || 'equipe', ...(to.contact ? {} : { cliente: '', telefone_cliente: '' }) });
  if (s.alerts.detractorEmail) {
    const rows = [['Filial', r.branch_name], ['Nota', String(score)], ['Quando', when]];
    // Texto do cliente: uma linha, sem links clicáveis (ninguém forja uma linha "do sistema" nem manda link à equipe).
    for (const c of comments) rows.push([c.text, templates.customerText(c.value_text)]);
    const contactRows = [];
    if (hasContact) {
      contactRows.push(['Cliente pediu contato', templates.customerText(contactName) || '(sem nome)']);
      const mail = decrypt(r.contact_email_enc);
      if (contactPhone) contactRows.push(['Telefone', contactPhone]);
      if (mail) contactRows.push(['E-mail', mail]);
    }
    for (const to of branchRecipientList(r.branch_id, 'notify_detractors')) {
      const m = templates.emailFor('detractor', varsFor(to), { rows: to.contact ? [...rows, ...contactRows] : rows, buttonUrl: url });
      queueEmail({ to: to.email, subject: m.subject, text: m.text, html: m.html, kind: 'detractor', responseId: r.id });
    }
  }
  if (s.alerts.webhookUrl) {
    queueWebhook(s.alerts.webhookUrl, { event: 'detractor', caseId, branch: r.branch_name, score, channel: r.channel,
      contactRequested: hasContact, submittedAt: new Date(r.submitted_at).toISOString(), url }, 'detractor', r.id);
  }
  const wa = whatsappRecipients(r.branch_id, 'notify_detractors');
  if (s.whatsapp.mode === 'qr') {
    // Número da empresa conectado por QR Code: texto do modelo, um envio por vez com intervalo.
    for (const to of wa) whatsappQr.queue(to.phone, templates.whatsappFor('detractor', varsFor(to)), 'detractor', to.name, r.id);
  } else if (s.whatsapp.mode === 'meta' && s.alerts.whatsappTemplate) {
    for (const to of wa) queueWhatsApp(to.phone, { template: s.alerts.whatsappTemplate, language: s.alerts.whatsappLanguage, params: [r.branch_name, String(score), url] }, 'detractor', r.id);
  }
}

module.exports = { onResponse, branchRecipientList, whatsappRecipients, usersToNotify, parseList, DETRACTOR_MAX };
