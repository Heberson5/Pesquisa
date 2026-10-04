'use strict';
// Conversões de data/hora no fuso da empresa (padrão America/Sao_Paulo), sem depender do fuso do servidor.
const { timezone } = require('./config');

function offsetMs(at, tz = timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at / 1000) * 1000;
}

// 'YYYY-MM-DDTHH:MM' no fuso da empresa → timestamp. Retorna null se inválido.
function parseLocal(s, tz = timezone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = guess - offsetMs(guess, tz);
  t = guess - offsetMs(t, tz); // segunda passada acerta trocas de horário de verão
  const back = new Date(t + offsetMs(t, tz));
  if (back.getUTCFullYear() !== +m[1] || back.getUTCMonth() !== +m[2] - 1 || back.getUTCDate() !== +m[3]) return null;
  return t;
}

const formatLocal = (at, tz = timezone) => new Date(at).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });

// Dia da semana (0=dom) e hora local — usados pelo relatório semanal.
function localNow(at = Date.now(), tz = timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hour: +p.hour, date: `${p.year}-${p.month}-${p.day}` };
}

module.exports = { parseLocal, formatLocal, localNow, offsetMs };
