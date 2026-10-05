'use strict';
// Retenção de dados (LGPD): apaga automaticamente o que passou do prazo definido em Configurações.
const { all, run } = require('./db');
const { getSettings } = require('./settings');
const { anonymize } = require('./routes/privacy');

const MONTH = 30 * 86_400_000;

function applyRetention(now = Date.now()) {
  const r = getSettings().retention;
  // Contatos vencidos: remove os dados pessoais.
  const contacts = all('SELECT id FROM responses WHERE anonymized_at IS NULL AND contact_consent_at IS NOT NULL AND submitted_at < ?', now - r.contactsMonths * MONTH).map((x) => x.id);
  anonymize(contacts);
  // Coordenadas aproximadas vencidas: mantém só cidade/UF/região (estatística), apaga o ponto no mapa.
  const g = run('UPDATE responses SET geo_lat = NULL, geo_lng = NULL WHERE geo_lat IS NOT NULL AND submitted_at < ?', now - r.contactsMonths * MONTH);
  // Comentários livres vencidos (podem conter dados pessoais escritos pelo cliente).
  const old = now - r.commentsMonths * MONTH;
  const c = run(`DELETE FROM answers WHERE question_id IN (SELECT id FROM questions WHERE type = 'text')
    AND response_id IN (SELECT id FROM responses WHERE submitted_at < ?)`, old);
  run("UPDATE case_notes SET text = '[removido por prazo de retenção]' WHERE text IS NOT NULL AND at < ? AND text <> '[removido por prazo de retenção]'", old);
  const a = run('DELETE FROM audit_log WHERE at < ?', now - r.auditMonths * MONTH);
  return { contacts: contacts.length, coordinates: Number(g.changes), comments: Number(c.changes), audit: Number(a.changes) };
}

module.exports = { applyRetention };
