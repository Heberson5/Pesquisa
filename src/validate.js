'use strict';
// Validação de entrada. Tudo que vem do cliente passa por aqui antes do banco.

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

function str(v, { field, min = 0, max = 500, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    if (min > 0) throw bad(`Campo "${field}" é obrigatório.`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`Campo "${field}" inválido.`);
  // remove caracteres de controle (exceto \n e \t) e normaliza
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').normalize('NFC').trim();
  if (s.length < min) throw bad(`Campo "${field}" muito curto.`);
  if (s.length > max) throw bad(`Campo "${field}" excede ${max} caracteres.`);
  return s;
}

function int(v, { field, min = -2147483648, max = 2147483647, optional = false } = {}) {
  if ((v === undefined || v === null || v === '') && optional) return null;
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`Campo "${field}" inválido.`);
  return n;
}

const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';

function id(v, field = 'id') { return int(v, { field, min: 1 }); }

function email(v) {
  const s = str(v, { field: 'e-mail', min: 3, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('E-mail inválido.');
  return s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dateParam(v, field) {
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`Data "${field}" inválida.`);
  const t = Date.parse(v + 'T00:00:00');
  if (Number.isNaN(t)) throw bad(`Data "${field}" inválida.`);
  return t;
}

module.exports = { HttpError, bad, str, int, bool, id, email, UUID_RE, dateParam };
