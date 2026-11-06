'use strict';
const crypto = require('crypto');
const {
  QUEUE_KEY, RESULT_PREFIX, COOLDOWN_PREFIX, KINDS, need, siteUrl, getSession, send, redis,
} = require('../lib/common');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function createTicket(req, res, session) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (origin !== siteUrl()) {
    return send(res, 403, { error: 'origin', message: 'Solicitud no permitida.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return send(res, 400, { error: 'body', message: 'Datos no válidos.' });
  }

  const kind = String(body.kind || '');
  const subject = String(body.subject || '').trim().slice(0, 100);
  const message = String(body.message || '').trim().slice(0, 1000);
  if (KINDS.indexOf(kind) === -1) {
    return send(res, 400, { error: 'kind', message: 'Elige un tipo de ticket válido.' });
  }
  if (subject.length < 3) {
    return send(res, 400, { error: 'subject', message: 'El asunto debe tener al menos 3 caracteres.' });
  }
  if (message.length < 10) {
    return send(res, 400, { error: 'message', message: 'Cuéntanos tu caso con al menos 10 caracteres.' });
  }

  const allowed = await redis('SET', COOLDOWN_PREFIX + session.id, '1', 'NX', 'EX', '120');
  if (allowed !== 'OK') {
    return send(res, 429, { error: 'cooldown', message: 'Espera un par de minutos antes de enviar otro ticket.' });
  }
  const pending = Number(await redis('LLEN', QUEUE_KEY));
  if (pending >= 50) {
    return send(res, 503, { error: 'busy', message: 'Hay muchas solicitudes ahora mismo. Inténtalo en unos minutos.' });
  }

  const id = crypto.randomUUID();
  await redis('LPUSH', QUEUE_KEY, JSON.stringify({
    type: 'ticket',
    id: id,
    guild_id: need('GUILD_ID'),
    user_id: session.id,
    username: session.username,
    kind: kind,
    subject: subject,
    message: message,
    created: Date.now(),
  }));
  return send(res, 202, { id: id });
}

async function ticketStatus(req, res, session) {
  const id = String((req.query && req.query.id) || '');
  if (!UUID_RE.test(id)) {
    return send(res, 400, { error: 'id', message: 'Identificador no válido.' });
  }
  const raw = await redis('GET', RESULT_PREFIX + id);
  if (raw === null || raw === undefined) return send(res, 200, { status: 'pending' });
  let result;
  try { result = JSON.parse(raw); } catch (err) { return send(res, 200, { status: 'pending' }); }
  if (String(result.user_id) !== session.id) {
    return send(res, 404, { error: 'notfound', message: 'No encontrado.' });
  }
  return send(res, 200, result);
}

module.exports = async function handler(req, res) {
  try {
    const session = getSession(req);
    if (!session) {
      return send(res, 401, { error: 'login', message: 'Inicia sesión con Discord para continuar.' });
    }
    if (req.method === 'POST') return await createTicket(req, res, session);
    if (req.method === 'GET') return await ticketStatus(req, res, session);
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'method', message: 'Método no permitido.' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'server', message: 'Error interno. Inténtalo más tarde.' });
  }
};
