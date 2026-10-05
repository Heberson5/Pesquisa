'use strict';
// Rótulo genérico do aparelho do cliente (QR Code), ex.: "iPhone · Safari". Guarda só esse texto curto,
// nunca o User-Agent inteiro (que identifica o aparelho com muita precisão).
function deviceLabel(ua) {
  const s = typeof ua === 'string' ? ua.slice(0, 400) : '';
  if (!s) return 'Aparelho não identificado';
  let os = 'Aparelho desconhecido';
  if (/iPhone/.test(s)) os = 'iPhone';
  else if (/iPad/.test(s)) os = 'iPad';
  else if (/Android/.test(s)) os = /Mobile/.test(s) ? 'Android (celular)' : 'Android (tablet)';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/Macintosh|Mac OS X/.test(s)) os = 'Mac';
  else if (/CrOS/.test(s)) os = 'Chromebook';
  else if (/Linux/.test(s)) os = 'Linux';
  let browser = '';
  if (/FBAN|FBAV/.test(s)) browser = 'Facebook';
  else if (/Instagram/.test(s)) browser = 'Instagram';
  else if (/Edg(e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/SamsungBrowser/.test(s)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS/.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS/.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';
  return browser ? `${os} · ${browser}` : os;
}
module.exports = { deviceLabel };
