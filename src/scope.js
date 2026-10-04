'use strict';
// Escopo por filial: admin vê todas; gestor só as filiais vinculadas a ele.
const { get, all } = require('./db');
const { HttpError } = require('./validate');

// Retorna null (todas as filiais) para admin, ou a lista de filiais do gestor.
function scope(user) {
  if (user.role === 'admin') return null;
  return all('SELECT branch_id FROM user_branches WHERE user_id = ?', user.id).map((r) => r.branch_id);
}
function assertBranch(user, branchId) {
  const s = scope(user);
  if (s && !s.includes(branchId)) throw new HttpError(404, 'Filial não encontrada.');
  if (!get('SELECT 1 FROM branches WHERE id = ?', branchId)) throw new HttpError(404, 'Filial não encontrada.');
}
const placeholders = (arr) => arr.map(() => '?').join(',');

module.exports = { scope, assertBranch, placeholders };
