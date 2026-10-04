'use strict';
// Cliente insatisfeito (nota de NPS de 0 a 6): abre um caso para tratamento e avisa os responsáveis.
// Webhook e WhatsApp recebem só o mínimo (filial, nota, link) — dados pessoais ficam no painel.
const { get, all, run } = require('./db');
const { getSettings } = require('./settings');
const { queueEmail, queueWebhook, queueWhatsApp, renderEmail } = require('./notify');
const { decrypt } = require('./vault');
const { publicUrl, timezone } = require('./config');

const DETRACTOR_MAX = 6;
const parseList = (json) => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

// Destinatários de e-mail de uma filial: lista da filial + gestores da filial e admins que querem o aviso.
function branchRecipients(branchId, prefColumn) {
  const b = get('SELECT alert_emails FROM branches WHERE id = ?', branchId);
  const users = all(`SELECT DISTINCT u.email FROM users u LEFT JOIN user_branches ub ON ub.user_id = u.id
      WHERE u.active = 1 AND u.${prefColumn} = 1 AND (u.role = 'admin' OR ub.branch_id = ?)`, branchId).map((r) => r.email);
  return [...new Set([...parseList(b?.alert_emails), ...users].map((e) => String(e).toLowerCase()))];
}

function onResponse(responseId) {
  const r = get(`SELECT r.*, b.name AS branch_name FROM responses r JOIN branches b ON b.id = r.branch_id WHERE r.id = ?`, responseId);
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
  if (s.alerts.detractorEmail) {
    const rows = [['Filial', r.branch_name], ['Nota', String(score)], ['Quando', new Date(r.submitted_at).toLocaleString('pt-BR', { timeZone: timezone })]];
    for (const c of comments) rows.push([c.text, c.value_text]);
    if (hasContact) {
      rows.push(['Cliente pediu contato', decrypt(r.contact_name_enc) || '(sem nome)']);
      const phone = decrypt(r.contact_phone_enc); const mail = decrypt(r.contact_email_enc);
      if (phone) rows.push(['Telefone', phone]);
      if (mail) rows.push(['E-mail', mail]);
    }
    const { html, text } = renderEmail({ brand: s, title: `Cliente insatisfeito — ${r.branch_name}`,
      intro: `Uma resposta com nota ${score} acabou de chegar. Um caso foi aberto para tratamento.`, rows,
      button: { label: 'Abrir o caso no painel', url }, footer: 'Você recebe este aviso porque está cadastrado para alertas desta filial. Ajuste em Minha conta.' });
    for (const to of branchRecipients(r.branch_id, 'notify_detractors')) {
      queueEmail({ to, subject: `[Alerta] Nota ${score} em ${r.branch_name}`, text, html, kind: 'detractor' });
    }
  }
  if (s.alerts.webhookUrl) {
    queueWebhook(s.alerts.webhookUrl, { event: 'detractor', caseId, branch: r.branch_name, score, channel: r.channel,
      contactRequested: hasContact, submittedAt: new Date(r.submitted_at).toISOString(), url }, 'detractor');
  }
  if (s.alerts.whatsappTemplate) {
    const phones = parseList(get('SELECT alert_phones FROM branches WHERE id = ?', r.branch_id)?.alert_phones);
    for (const p of phones) queueWhatsApp(p, { template: s.alerts.whatsappTemplate, language: s.alerts.whatsappLanguage, params: [r.branch_name, String(score), url] }, 'detractor');
  }
}

module.exports = { onResponse, branchRecipients, parseList, DETRACTOR_MAX };
