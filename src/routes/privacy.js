'use strict';
// LGPD — pedidos do titular dos dados (somente administradores):
// localizar, exportar (portabilidade) e excluir/anonimizar os dados de uma pessoa.
// A busca é por telefone ou e-mail via HMAC: o dado aberto nunca é usado como índice.
const express = require('express');
const { all, run, tx, audit } = require('../db');
const { requireUser, requireAdmin } = require('../auth');
const { bad, str } = require('../validate');
const { decrypt, lookup, normPhone, normEmail } = require('../vault');
const { isEmail } = require('../notify');
const { rateLimiter } = require('../security');

const router = express.Router();
router.use(requireUser, requireAdmin, rateLimiter({ windowMs: 60_000, max: 30 }));

function matches(body) {
  const phone = body?.phone ? normPhone(str(body.phone, { field: 'telefone', max: 30 })) : null;
  const email = body?.email ? normEmail(str(body.email, { field: 'e-mail', max: 254 })) : null;
  if (phone && !/^\d{10,13}$/.test(phone)) throw bad('Telefone inválido.');
  if (email && !isEmail(email)) throw bad('E-mail inválido.');
  if (!phone && !email) throw bad('Informe telefone ou e-mail.');
  const rows = all(`SELECT r.id, r.submitted_at, r.contact_name_enc, r.contact_phone_enc, r.contact_email_enc, r.contact_consent_at, b.name AS branch, s.title AS survey
      FROM responses r JOIN branches b ON b.id = r.branch_id JOIN surveys s ON s.id = r.survey_id
      WHERE r.anonymized_at IS NULL AND (r.contact_phone_lookup = ? OR r.contact_email_lookup = ?) ORDER BY r.submitted_at`,
  phone ? lookup('phone:' + phone) : '-', email ? lookup('email:' + email) : '-');
  return { rows, key: { phone: !!phone, email: !!email } };
}

router.post('/search', (req, res) => {
  const { rows, key } = matches(req.body);
  audit(req.user.id, 'privacy.search', { found: rows.length, by: key }, req.ip);
  res.json(rows.map((r) => ({ id: r.id, submitted_at: r.submitted_at, branch: r.branch, survey: r.survey, name: decrypt(r.contact_name_enc) })));
});

router.post('/export', (req, res) => {
  const { rows } = matches(req.body);
  const data = rows.map((r) => ({
    data: new Date(r.submitted_at).toISOString(), filial: r.branch, pesquisa: r.survey,
    contato: { nome: decrypt(r.contact_name_enc), telefone: decrypt(r.contact_phone_enc), email: decrypt(r.contact_email_enc),
      consentimento_em: new Date(r.contact_consent_at).toISOString() },
    respostas: all(`SELECT q.text AS pergunta, COALESCE(a.value_text, CAST(a.value_num AS TEXT)) AS resposta FROM answers a
      JOIN questions q ON q.id = a.question_id WHERE a.response_id = ? ORDER BY q.position`, r.id),
  }));
  audit(req.user.id, 'privacy.export', { count: rows.length }, req.ip);
  res.set('Content-Disposition', 'attachment; filename="dados-titular.json"');
  res.json({ geradoEm: new Date().toISOString(), registros: data });
});

// Exclusão: apaga contato e comentários livres; as notas numéricas ficam (sem vínculo com a pessoa)
// para não distorcer o NPS histórico.
function anonymize(ids) {
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  tx(() => {
    run(`UPDATE responses SET contact_name_enc = NULL, contact_phone_enc = NULL, contact_email_enc = NULL, contact_phone_lookup = NULL,
      contact_email_lookup = NULL, anonymized_at = ? WHERE id IN (${ph})`, Date.now(), ...ids);
    run(`DELETE FROM answers WHERE response_id IN (${ph}) AND question_id IN (SELECT id FROM questions WHERE type = 'text')`, ...ids);
    run(`UPDATE case_notes SET text = '[removido a pedido do titular]' WHERE text IS NOT NULL AND case_id IN (SELECT id FROM cases WHERE response_id IN (${ph}))`, ...ids);
  });
}

router.post('/erase', (req, res) => {
  if (req.body?.confirm !== true) throw bad('Confirme a exclusão.');
  const { rows } = matches(req.body);
  anonymize(rows.map((r) => r.id));
  audit(req.user.id, 'privacy.erase', { count: rows.length }, req.ip);
  res.json({ ok: true, erased: rows.length });
});

module.exports = router;
module.exports.anonymize = anonymize;
