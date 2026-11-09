'use strict';
/**
 * Diagnóstico de la configuración. Abre /api/health en el navegador.
 * No muestra secretos. Es independiente de lib/common.js para que funcione
 * aunque ese archivo esté desactualizado.
 */
const EXPECTED_EXPORTS = [
  'VERSION', 'DASH_PREFIX', 'BOT_GUILDS_KEY', 'UG_PREFIX', 'CRES_PREFIX', 'DASH_KEYS', 'VERIFY_RES_PREFIX', 'clientIp', 'STATUS_KEY', 'OUTBOX_KEY', 'MSGSUM_KEY', 'BOARD_PREFIX', 'TRES_PREFIX', 'messageSummary', 'NEXT_TARGETS', 'redisPipeline', 'hashObject',
  'isOwner', 'checkOrigin', 'readBody', 'redisInfo',
];

function hint(url) {
  const host = String(url || '').replace(/^https?:\/\//, '').split('/')[0];
  return host.length <= 16 ? (host || '(vacío)') : host.slice(0, 6) + '…' + host.slice(-14);
}

async function redisCall(url, token, path, body) {
  const response = await fetch(url + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || (data && data.error)) throw new Error((data && data.error) || 'HTTP ' + response.status);
  if (Array.isArray(data)) {
    data.forEach(function (item) { if (item && item.error) throw new Error(item.error); });
  }
  return data;
}

module.exports = async function handler(req, res) {
  const out = { env: {}, common: {}, redis: {} };
  ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET', 'SITE_URL', 'GUILD_ID', 'OWNER_IDS'].forEach(function (name) {
    out.env[name] = !!process.env[name];
  });
  out.env.TURNSTILE_SITE_KEY_opcional = !!process.env.TURNSTILE_SITE_KEY;
  out.env.TURNSTILE_SECRET_KEY_opcional = !!process.env.TURNSTILE_SECRET_KEY;
  out.env.SESSION_SECRET_32_o_mas = String(process.env.SESSION_SECRET || '').length >= 32;
  out.env.SITE_URL_correcta = /^https:\/\/[^/\s]+$/.test(String(process.env.SITE_URL || ''));
  out.env.OWNER_IDS_cantidad = String(process.env.OWNER_IDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).length;

  try {
    const common = require('../lib/common');
    out.common.faltan_exports = EXPECTED_EXPORTS.filter(function (name) { return !(name in common); });
    out.common.actualizado = out.common.faltan_exports.length === 0;
    out.common.version = common.VERSION || 'antigua';
  } catch (err) {
    out.common.error = String(err.message).slice(0, 120);
  }

  const url = String(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
  out.redis.variable = process.env.UPSTASH_REDIS_REST_URL ? 'UPSTASH_REDIS_REST_URL' : (url ? 'KV_REST_API_URL' : 'ninguna');
  out.redis.host_hint = hint(url);
  out.redis.url_correcta = /^https:\/\/[^/\s"']+$/.test(url);
  out.redis.token_presente = !!token;

  if (!url || !token) {
    out.redis.error = 'Faltan las variables de Redis';
  } else {
    try {
      const stamp = String(Date.now());
      await redisCall(url, token, '', ['SET', 'js:health', stamp, 'EX', '60']);
      const back = await redisCall(url, token, '', ['GET', 'js:health']);
      out.redis.escritura_y_lectura = back.result === stamp;
    } catch (err) {
      out.redis.escritura_y_lectura = false;
      out.redis.error = String(err.message).slice(0, 160);
    }
    try {
      await redisCall(url, token, '/pipeline', [['SET', 'js:health2', '1', 'EX', '60'], ['LLEN', 'js:health3']]);
      out.redis.pipeline = true;
    } catch (err) {
      out.redis.pipeline = false;
      out.redis.pipeline_error = String(err.message).slice(0, 160);
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(out, null, 2));
};
