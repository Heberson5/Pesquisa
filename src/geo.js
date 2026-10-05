'use strict';
// Localização aproximada das respostas (QR Code/link), 100% offline: o aparelho do cliente informa as coordenadas
// (só com autorização dele) e aqui elas viram "cidade mais próxima + UF + região" usando a lista de municípios do IBGE.
// Nada é enviado a serviços externos. As coordenadas são arredondadas (~1 km) antes de gravar.
const data = require('./geodata/municipios.json');

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
function km(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1); const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const BR_BOX = { latMin: -34.5, latMax: 5.6, lngMin: -74.5, lngMax: -33.5 };
const MAX_CITY_KM = 100; // além disso só informamos o estado/região, não a cidade

// Devolve { city, uf, region, outside } ou null se as coordenadas forem inválidas.
function locate(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat < BR_BOX.latMin || lat > BR_BOX.latMax || lng < BR_BOX.lngMin || lng > BR_BOX.lngMax) return { city: null, uf: null, region: 'Fora do Brasil', outside: true };
  let best = null; let bestD = Infinity;
  for (const m of data.m) {
    // filtro barato antes do cálculo completo
    if (Math.abs(m[3] - lat) > 2 || Math.abs(m[4] - lng) > 2.5) continue;
    const d = km(lat, lng, m[3], m[4]);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (!best) { // nenhuma sede perto (ex.: Amazônia profunda): procura em todas
    for (const m of data.m) { const d = km(lat, lng, m[3], m[4]); if (d < bestD) { bestD = d; best = m; } }
  }
  return { city: bestD <= MAX_CITY_KM ? best[0] : null, uf: data.ufs[best[1]], region: data.regioes[best[2]], outside: false };
}

// Valida o que o navegador enviou e prepara os campos para gravar (coordenadas arredondadas a 0,01° ≈ 1 km).
function fromClient(geo) {
  if (geo === undefined || geo === null) return null;
  if (typeof geo !== 'object' || Array.isArray(geo)) return { error: 'Localização inválida.' };
  if (geo.consent !== true) return { error: 'Localização exige a autorização do cliente.' };
  if (typeof geo.lat !== 'number' || typeof geo.lng !== 'number') return { error: 'Localização inválida.' };
  const place = locate(geo.lat, geo.lng);
  if (!place) return { error: 'Localização inválida.' };
  return { lat: Math.round(geo.lat * 100) / 100, lng: Math.round(geo.lng * 100) / 100, ...place };
}

module.exports = { locate, fromClient, UFS: data.ufs, REGIOES: data.regioes };
