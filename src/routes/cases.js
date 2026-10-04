'use strict';
// Tratamento de clientes insatisfeitos: cada nota de NPS de 0 a 6 vira um caso com status,
// responsável e histórico. Gestor só vê e altera casos das próprias filiais.
const express = require('express');
const { get, all, run, tx, audit } = require('../db');
const { requireUser } = require('../auth');
const { HttpError, bad, str, int, id, dateParam } = require('../validate');
const { scope, assertBranch, placeholders } = require('../scope');
const { decrypt } = require('../vault');

const router = express.Router();
router.use(requireUser);

const STATUS = { aberto: 'Aberto', em_contato: 'Em contato', resolvido: 'Resolvido', sem_retorno: 'Sem retorno' };
const CLOSED = new Set(['resolvido', 'sem_retorno']);

function caseFilter(user, q) {
  const where = []; const params = [];
  if (q.status) {
    if (!Object.hasOwn(STATUS, q.status) && q.status !== 'pendentes') throw bad('Status inválido.');
    if (q.status === 'pendentes') where.push("c.status IN ('aberto','em_contato')"); else { where.push('c.status = ?'); params.push(q.status); }
  }
  if (q.branchId) { const b = id(q.branchId, 'filial'); assertBranch(user, b); where.push('c.branch_id = ?'); params.push(b); }
  const from = dateParam(q.from, 'de'); const to = dateParam(q.to, 'até');
  if (from !== null) { where.push('c.created_at >= ?'); params.push(from); }
  if (to !== null) { where.push('c.created_at < ?'); params.push(to + 86_400_000); }
  if (q.mine === '1') { where.push('c.assignee_id = ?'); params.push(user.id); }
  const s = scope(user);
  if (s) { where.push(s.length ? `c.branch_id IN (${placeholders(s)})` : '0'); params.push(...s); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

router.get('/summary', (req, res) => {
  const f = caseFilter(req.user, { ...req.query, status: undefined });
  const row = get(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN c.status = 'aberto' THEN 1 ELSE 0 END) AS abertos,
      SUM(CASE WHEN c.status = 'em_contato' THEN 1 ELSE 0 END) AS em_contato,
      SUM(CASE WHEN c.status = 'resolvido' THEN 1 ELSE 0 END) AS resolvidos,
      SUM(CASE WHEN c.status = 'sem_retorno' THEN 1 ELSE 0 END) AS sem_retorno,
      AVG(CASE WHEN c.resolved_at IS NOT NULL THEN (c.resolved_at - c.created_at) END) AS avg_ms
    FROM cases c ${f.sql}`, ...f.params);
  res.json({ ...row, avgHours: row.avg_ms ? Math.round(row.avg_ms / 360_000) / 10 : null });
});

router.get('/', (req, res) => {
  const page = int(req.query.page || '1', { field: 'página', min: 1, max: 100000 });
  const f = caseFilter(req.user, req.query);
  const total = get(`SELECT COUNT(*) AS n FROM cases c ${f.sql}`, ...f.params).n;
  const rows = all(`SELECT c.id, c.status, c.min_score, c.created_at, c.updated_at, c.resolved_at, b.name AS branch, u.name AS assignee,
      (r.contact_consent_at IS NOT NULL AND r.anonymized_at IS NULL) AS has_contact, r.channel,
      (SELECT a.value_text FROM answers a JOIN questions q ON q.id = a.question_id AND q.type = 'text' WHERE a.response_id = r.id AND a.value_text IS NOT NULL LIMIT 1) AS comment
    FROM cases c JOIN branches b ON b.id = c.branch_id JOIN responses r ON r.id = c.response_id LEFT JOIN users u ON u.id = c.assignee_id
    ${f.sql} ORDER BY CASE c.status WHEN 'aberto' THEN 0 WHEN 'em_contato' THEN 1 ELSE 2 END, c.created_at DESC LIMIT 25 OFFSET ?`, ...f.params, (page - 1) * 25);
  res.json({ page, pageSize: 25, total, rows: rows.map((r) => ({ ...r, has_contact: !!r.has_contact })), statuses: STATUS });
});

function loadCase(user, caseId) {
  const c = get('SELECT * FROM cases WHERE id = ?', caseId);
  if (!c) throw new HttpError(404, 'Caso não encontrado.');
  const s = scope(user);
  if (s && !s.includes(c.branch_id)) throw new HttpError(404, 'Caso não encontrado.');
  return c;
}

// Pessoas que podem ser responsáveis por um caso da filial: admins e gestores da filial.
const assignable = (branchId) => all(`SELECT DISTINCT u.id, u.name FROM users u LEFT JOIN user_branches ub ON ub.user_id = u.id
  WHERE u.active = 1 AND (u.role = 'admin' OR ub.branch_id = ?) ORDER BY u.name`, branchId);

router.get('/:id', (req, res) => {
  const c = loadCase(req.user, id(req.params.id));
  const r = get(`SELECT r.*, b.name AS branch, s.title AS survey, d.name AS device FROM responses r JOIN branches b ON b.id = r.branch_id
    JOIN surveys s ON s.id = r.survey_id LEFT JOIN devices d ON d.id = r.device_id WHERE r.id = ?`, c.response_id);
  const answers = all(`SELECT q.text, q.type, q.is_nps, a.value_num, a.value_text FROM answers a JOIN questions q ON q.id = a.question_id
    WHERE a.response_id = ? ORDER BY q.position`, r.id).map((a) => ({
    question: a.text, is_nps: !!a.is_nps,
    value: a.type === 'yesno' ? (a.value_num ? 'Sim' : 'Não') : a.type === 'multi' ? JSON.parse(a.value_text).join(', ') : (a.value_text ?? String(a.value_num)),
  }));
  let contact = null;
  if (r.contact_consent_at && !r.anonymized_at) {
    contact = { name: decrypt(r.contact_name_enc), phone: decrypt(r.contact_phone_enc), email: decrypt(r.contact_email_enc), consentAt: r.contact_consent_at };
    audit(req.user.id, 'contact.view', { caseId: c.id }, req.ip); // acesso a dado pessoal fica registrado
  }
  const notes = all(`SELECT n.at, n.text, n.status_from, n.status_to, u.name AS user FROM case_notes n LEFT JOIN users u ON u.id = n.user_id
    WHERE n.case_id = ? ORDER BY n.at`, c.id);
  res.json({ ...c, branch: r.branch, survey: r.survey, device: r.device, channel: r.channel, submitted_at: r.submitted_at,
    answers, contact, notes, statuses: STATUS, assignable: assignable(c.branch_id) });
});

router.put('/:id', (req, res) => {
  const c = loadCase(req.user, id(req.params.id));
  const b = req.body || {};
  const status = b.status === undefined ? c.status : b.status;
  if (!Object.hasOwn(STATUS, status)) throw bad('Status inválido.');
  let assignee = c.assignee_id;
  if (b.assigneeId !== undefined) {
    assignee = b.assigneeId === null ? null : id(b.assigneeId, 'responsável');
    if (assignee !== null && !assignable(c.branch_id).some((u) => u.id === assignee)) throw bad('Responsável sem acesso a esta filial.');
  }
  const note = str(b.note, { field: 'anotação', max: 2000, optional: true });
  if (status === c.status && assignee === c.assignee_id && !note) throw bad('Nada para atualizar.');
  const now = Date.now();
  tx(() => {
    run('UPDATE cases SET status = ?, assignee_id = ?, updated_at = ?, resolved_at = ? WHERE id = ?',
      status, assignee, now, CLOSED.has(status) ? (c.resolved_at || now) : null, c.id);
    run('INSERT INTO case_notes (case_id, user_id, at, text, status_from, status_to) VALUES (?,?,?,?,?,?)',
      c.id, req.user.id, now, note, status !== c.status ? c.status : null, status !== c.status ? status : null);
  });
  audit(req.user.id, 'case.update', { id: c.id, status, assignee }, req.ip);
  res.json({ ok: true });
});

module.exports = router;
