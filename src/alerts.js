'use strict';
// Cliente insatisfeito (nota de NPS de 0 a 6): abre um caso para tratamento e avisa os responsáveis.
// Webhook e WhatsApp recebem só o mínimo (filial, nota, link) — dados pessoais ficam no painel.
const { get, all, run } = require('./db');
const { getSettings } = require('./settings');
const { queueEmail, queueWebhook, queueWhatsApp } = require('./notify');
const templates = require('./templates');
const { decrypt } = require('./vault');
const { publicUrl } = require('./config');
const zones = require('./zones');
const { accessFor } = require('./permissions');

const DETRACTOR_MAX = 6;
const parseList = (json) => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

// Usuários que recebem um aviso da filial: quem marcou a preferência em Minha conta, enxerga a filial
// e pode abrir a tela correspondente (casos, tablets ou visão geral).
const PREF_COLUMNS = { notify_detractors: 'casos', notify_reports: 'dashboard', notify_offline: 'tablets' };
function usersToNotify(branchId, prefColumn) {
  if (!Object.hasOwn(PREF_COLUMNS, prefColumn)) throw new Error('Preferência inválida.');
  return all(`SELECT id, name, email, whatsapp, role, role_id FROM users WHERE active = 1 AND ${prefColumn} = 1`).filter((u) => {
    const a = accessFor(u);
    if (!a.isAdmin && !a.perms.has(PREF_COLUMNS[prefColumn] + '.ver')) return false;
    return a.scopeAll || !!get('SELECT 1 FROM user_branches WHERE user_id = ? AND branch_id = ?', u.id, branchId);
  });
}

// Destinatários de e-mail de uma filial: lista da filial + usuários que querem o aviso. Sem repetir e-mail;
// o nome (quando é um usuário) entra no texto como {destinatario}.
function branchRecipientList(branchId, prefColumn) {
  const b = get('SELECT alert_emails FROM branches WHERE id = ?', branchId);
  const out = new Map();
  for (const u of usersToNotify(branchId, prefColumn)) out.set(String(u.email).toLowerCase(), u.name);
  for (const e of parseList(b?.alert_emails)) if (!out.has(String(e).toLowerCase())) out.set(String(e).toLowerCase(), null);
  return [...out].map(([email, name]) => ({ email, name }));
}
const branchRecipients = (branchId, prefColumn) => branchRecipientList(branchId, prefColumn).map((r) => r.email);

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

function notifyDetractor(r, score, caseId) {
  const s = getSettings();
  const url = `${publicUrl}/admin/#/casos/${caseId}`;
  const comments = all(`SELECT q.text, a.value_text FROM answers a JOIN questions q ON q.id = a.question_id
      WHERE a.response_id = ? AND q.type = 'text' AND a.value_text IS NOT NULL`, r.id);
  const hasContact = !!r.contact_consent_at && !r.anonymized_at;
  const when = new Date(r.submitted_at).toLocaleString('pt-BR', { timeZone: zones.forBranch({ id: r.branch_id, timezone: r.branch_tz }), dateStyle: 'short', timeStyle: 'short' });
  const contactName = hasContact ? decrypt(r.contact_name_enc) : null;
  const contactPhone = hasContact ? decrypt(r.contact_phone_enc) : null;
  // Variáveis dos modelos de mensagem (Configurações → Modelos de mensagem).
  const vars = { filial: r.branch_name, nota: String(score), data_hora: when, canal: r.channel === 'link' ? 'QR Code' : 'tablet',
    comentario: comments.map((c) => c.value_text).join(' / ').slice(0, 300), cliente: contactName || '', telefone_cliente: contactPhone || '', link_caso: url };
  if (s.alerts.detractorEmail) {
    const rows = [['Filial', r.branch_name], ['Nota', String(score)], ['Quando', when]];
    for (const c of comments) rows.push([c.text, c.value_text]);
    if (hasContact) {
      rows.push(['Cliente pediu contato', contactName || '(sem nome)']);
      const mail = decrypt(r.contact_email_enc);
      if (contactPhone) rows.push(['Telefone', contactPhone]);
      if (mail) rows.push(['E-mail', mail]);
    }
    for (const to of branchRecipientList(r.branch_id, 'notify_detractors')) {
      const m = templates.emailFor('detractor', { ...vars, destinatario: to.name || 'equipe' }, { rows, buttonUrl: url });
      queueEmail({ to: to.email, subject: m.subject, text: m.text, html: m.html, kind: 'detractor' });
    }
  }
  if (s.alerts.webhookUrl) {
    queueWebhook(s.alerts.webhookUrl, { event: 'detractor', caseId, branch: r.branch_name, score, channel: r.channel,
      contactRequested: hasContact, submittedAt: new Date(r.submitted_at).toISOString(), url }, 'detractor');
  }
  if (s.alerts.whatsappTemplate) {
    const phones = parseList(get('SELECT alert_phones FROM branches WHERE id = ?', r.branch_id)?.alert_phones);
    // + WhatsApp pessoal dos usuários que enxergam a filial e quiseram o aviso
    const mine = usersToNotify(r.branch_id, 'notify_detractors').map((x) => x.whatsapp).filter(Boolean);
    for (const p of [...new Set([...phones, ...mine])]) queueWhatsApp(p, { template: s.alerts.whatsappTemplate, language: s.alerts.whatsappLanguage, params: [r.branch_name, String(score), url] }, 'detractor');
  }
}

module.exports = { onResponse, branchRecipients, branchRecipientList, usersToNotify, parseList, DETRACTOR_MAX };
