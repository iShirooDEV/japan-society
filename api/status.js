'use strict';
const { STATUS_KEY, redis, redisInfo, send } = require('../lib/common');

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
    const body = {
      fresh: fresh,
      updated: fresh ? data.updated : null,
      bots: fresh && data.bots && typeof data.bots === 'object' ? data.bots : {},
    };
    const debug = !!(req.query && req.query.debug);
    if (debug) {
      const info = redisInfo();
      body.debug = {
        redis_var: info.source,
        host_hint: info.host_hint,
        key_exists: raw !== null && raw !== undefined,
        age_seconds: data && typeof data.updated === 'number' ? Math.round(Date.now() / 1000 - data.updated) : null,
        bots_in_key: data && data.bots && typeof data.bots === 'object' ? Object.keys(data.bots).length : 0,
      };
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', debug ? 'no-store' : 'public, s-maxage=30, stale-while-revalidate=60');
    res.end(JSON.stringify(body));
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'server', message: 'El estado no está disponible.' });
  }
};
