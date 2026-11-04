'use strict';
const { STATUS_KEY, redis, send } = require('../lib/common');

/**
 * Estado público de los bots. El bot oficial publica cada 30 segundos un resumen en Redis;
 * si el resumen es más viejo de 150 segundos, se considera que no hay datos.
 */
module.exports = async function handler(req, res) {
  try {
    const raw = await redis('GET', STATUS_KEY);
    let data = null;
    if (raw) {
      try { data = JSON.parse(raw); } catch (err) { data = null; }
    }
    const fresh = !!data && typeof data.updated === 'number' && Date.now() / 1000 - data.updated < 150;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=30');
    res.end(JSON.stringify({
      fresh: fresh,
      updated: fresh ? data.updated : null,
      bots: fresh && data.bots && typeof data.bots === 'object' ? data.bots : {},
    }));
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'server', message: 'El estado no está disponible.' });
  }
};
