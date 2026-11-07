'use strict';
const crypto = require('crypto');
const {
  OUTBOX_KEY, VERIFY_RES_PREFIX, need, getSession, checkOrigin, readBody, send, redis, redisPipeline, clientIp,
} = require('../lib/common');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTS_PER_IP = 15; // por hora

/** Con Turnstile configurado se exige resolverlo; si no, la comprobación de humano es el inicio de sesión de Discord. */
async function checkCaptcha(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (typeof token !== 'string' || token.length < 10 || token.length > 2048) return false;
  const params = new URLSearchParams({ secret: secret, response: token });
  if (ip) params.set('remoteip', ip);
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const data = await response.json();
  return !!(data && data.success);
}

function ipKey(ip) {
  const hash = crypto.createHash('sha256').update(String(ip) + need('SESSION_SECRET')).digest('hex');
  return 'js:vip:' + hash.slice(0, 16); // nunca se guarda la IP en claro
}

async function startVerification(req, res, session) {
  if (!checkOrigin(req)) return send(res, 403, { error: 'origin', message: 'Solicitud no permitida.' });
  const body = readBody(req) || {};
  const ip = clientIp(req);

  const allowed = await redis('SET', 'js:vcd:' + session.id, '1', 'NX', 'EX', '20');
  if (allowed !== 'OK') {
    return send(res, 429, { error: 'cooldown', message: 'Espera unos segundos antes de intentarlo otra vez.' });
  }
  if (ip) {
    const key = ipKey(ip);
    const out = await redisPipeline([['SET', key, '0', 'NX', 'EX', '3600'], ['INCR', key]]);
    if (Number(out[1]) > MAX_ATTEMPTS_PER_IP) {
      return send(res, 429, { error: 'ip', message: 'Demasiados intentos desde tu conexión. Espera un rato e inténtalo de nuevo.' });
    }
  }

  if (!(await checkCaptcha(body.token, ip))) {
    return send(res, 400, { error: 'captcha', message: 'No pudimos comprobar que eres humano. Inténtalo de nuevo.' });
  }

  const jobId = crypto.randomUUID();
  await redis('LPUSH', OUTBOX_KEY, JSON.stringify({
    type: 'verify', job_id: jobId, guild_id: need('GUILD_ID'), user_id: session.id,
  }));
  return send(res, 202, { job_id: jobId });
}

async function verificationResult(res, session, id) {
  if (!UUID_RE.test(id)) return send(res, 400, { error: 'id', message: 'Identificador no válido.' });
  const raw = await redis('GET', VERIFY_RES_PREFIX + id);
  let result = null;
  try { result = raw ? JSON.parse(raw) : null; } catch (err) { result = null; }
  if (!result) return send(res, 200, { status: 'pending' });
  if (String(result.user_id) !== session.id) return send(res, 404, { error: 'notfound', message: 'No encontrado.' });
  return send(res, 200, result);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const id = String((req.query && req.query.id) || '');
      if (!id) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.end(JSON.stringify({ turnstile_site_key: process.env.TURNSTILE_SITE_KEY || '' }));
      }
      const session = getSession(req);
      if (!session) return send(res, 401, { error: 'login', message: 'Inicia sesión con Discord para continuar.' });
      return await verificationResult(res, session, id);
    }
    if (req.method === 'POST') {
      const session = getSession(req);
      if (!session) return send(res, 401, { error: 'login', message: 'Inicia sesión con Discord para continuar.' });
      return await startVerification(req, res, session);
    }
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'method', message: 'Método no permitido.' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'server', message: 'Error interno. Inténtalo más tarde.' });
  }
};
