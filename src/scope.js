'use strict';
// Escopo por filial: perfis com "todas as filiais" (e o administrador) veem tudo; os demais só as filiais vinculadas ao usuário.
const { get, all } = require('./db');
const { HttpError } = require('./validate');
const { accessFor } = require('./permissions');

// Retorna null (todas as filiais) ou a lista de filiais do usuário.
function scope(user) {
  if (accessFor(user).scopeAll) return null;
  return all('SELECT branch_id FROM user_branches WHERE user_id = ?', user.id).map((r) => r.branch_id);
}
function assertBranch(user, branchId) {
  const s = scope(user);
  if (s && !s.includes(branchId)) throw new HttpError(404, 'Filial não encontrada.');
  if (!get('SELECT 1 FROM branches WHERE id = ?', branchId)) throw new HttpError(404, 'Filial não encontrada.');
}
const placeholders = (arr) => arr.map(() => '?').join(',');

module.exports = { scope, assertBranch, placeholders };
