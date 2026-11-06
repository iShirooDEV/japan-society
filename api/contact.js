'use strict';
const crypto = require('crypto');
const {
  OUTBOX_KEY, MESSAGE_TTL, MSGSUM_KEY, messageSummary, need, getSession, checkOrigin, readBody, send, redis, redisPipeline, hashObject,
} = require('../lib/common');

function parseJson(text) {
  try { return JSON.parse(text); } catch (err) { return null; }
}

async function createMessage(req, res, session) {
  if (!checkOrigin(req)) return send(res, 403, { error: 'origin', message: 'Solicitud no permitida.' });
  const body = readBody(req);
  if (!body) return send(res, 400, { error: 'body', message: 'Datos no válidos.' });

  const subject = String(body.subject || '').trim().slice(0, 100);
  const message = String(body.message || '').trim().slice(0, 1500);
  if (subject.length < 3) {
    return send(res, 400, { error: 'subject', message: 'El asunto debe tener al menos 3 caracteres.' });
  }
  if (message.length < 10) {
    return send(res, 400, { error: 'message', message: 'Cuéntanos tu mensaje con al menos 10 caracteres.' });
  }

  const allowed = await redis('SET', 'js:cdm:' + session.id, '1', 'NX', 'EX', '60');
  if (allowed !== 'OK') {
    return send(res, 429, { error: 'cooldown', message: 'Espera un minuto antes de enviar otro mensaje.' });
  }

  const id = crypto.randomUUID();
  const key = 'js:m:' + id;
  const mine = 'js:um:' + session.id;
  await redisPipeline([
    ['HSET', key, 'id', id, 'user_id', session.id, 'username', session.username, 'name', session.name,
      'subject', subject, 'message', message, 'created', Date.now(), 'status', 'new'],
    ['EXPIRE', key, MESSAGE_TTL],
    ['HSET', MSGSUM_KEY, id, JSON.stringify(messageSummary({
      id: id, user_id: session.id, username: session.username, name: session.name,
      subject: subject, created: Date.now(), status: 'new',
    }, 0))],
    ['LPUSH', 'js:msgs', id],
    ['LTRIM', 'js:msgs', 0, 499],
    ['LPUSH', mine, id],
    ['LTRIM', mine, 0, 29],
    ['EXPIRE', mine, MESSAGE_TTL],
    ['LPUSH', OUTBOX_KEY, JSON.stringify({
      type: 'notify', msg_id: id, guild_id: need('GUILD_ID'), user_id: session.id,
      name: session.name, subject: subject, preview: message.slice(0, 300),
    })],
  ]);
  return send(res, 201, { id: id });
}

async function listMine(res, session) {
  const ids = (await redis('LRANGE', 'js:um:' + session.id, 0, 9)) || [];
  if (!ids.length) return send(res, 200, { messages: [] });

  const commands = [];
  ids.forEach(function (id) {
    commands.push(['HGETALL', 'js:m:' + id]);
    commands.push(['LRANGE', 'js:mr:' + id, 0, 19]);
  });
  const out = await redisPipeline(commands);

  const messages = [];
  ids.forEach(function (id, i) {
    const h = hashObject(out[i * 2]);
    if (!h.id || h.user_id !== session.id) return;
    const replies = (out[i * 2 + 1] || []).map(parseJson).filter(Boolean).map(function (r) {
      return { by_name: String(r.by_name || ''), text: String(r.text || ''), at: Number(r.at) || 0 };
    });
    messages.push({
      id: h.id,
      subject: h.subject || '',
      message: h.message || '',
      created: Number(h.created) || 0,
      status: h.status || 'new',
      claimed_name: h.claimed_name || '',
      replies: replies,
    });
  });
  return send(res, 200, { messages: messages });
}

module.exports = async function handler(req, res) {
  try {
    const session = getSession(req);
    if (!session) return send(res, 401, { error: 'login', message: 'Inicia sesión con Discord para continuar.' });
    if (req.method === 'POST') return await createMessage(req, res, session);
    if (req.method === 'GET') return await listMine(res, session);
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'method', message: 'Método no permitido.' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'server', message: 'Error interno. Inténtalo más tarde.' });
  }
};
