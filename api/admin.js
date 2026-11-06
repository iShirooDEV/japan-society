'use strict';
const crypto = require('crypto');
const {
  OUTBOX_KEY, MESSAGE_TTL, MSGSUM_KEY, BOARD_PREFIX, TRES_PREFIX, messageSummary,
  need, getSession, isOwner, checkOrigin, readBody, send, avatarUrl, redis, redisPipeline, hashObject,
} = require('../lib/common');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNOWFLAKE_RE = /^\d{5,25}$/;
const TICKET_ACTIONS = { t_claim: 't_claim', t_close: 't_close', t_reply: 't_reply' };

function parseJson(text) {
  try { return JSON.parse(text); } catch (err) { return null; }
}

/** Vuelve a calcular el resumen de un mensaje después de cambiarlo. */
async function refreshSummary(id) {
  const out = await redisPipeline([['HGETALL', 'js:m:' + id], ['LLEN', 'js:mr:' + id]]);
  const h = hashObject(out[0]);
  if (h.id) await redis('HSET', MSGSUM_KEY, id, JSON.stringify(messageSummary(h, Number(out[1]) || 0)));
}

/** Lista de mensajes: 2 comandos en total (más un relleno puntual para mensajes antiguos sin resumen). */
async function listMessages(res) {
  const out = await redisPipeline([['LRANGE', 'js:msgs', 0, 99], ['HGETALL', MSGSUM_KEY]]);
  const ids = out[0] || [];
  const sums = hashObject(out[1]);
  const missing = ids.filter(function (id) { return !sums[id]; }).slice(0, 20);
  if (missing.length) {
    const commands = [];
    missing.forEach(function (id) {
      commands.push(['HGETALL', 'js:m:' + id]);
      commands.push(['LLEN', 'js:mr:' + id]);
    });
    const filled = await redisPipeline(commands);
    const writes = [];
    missing.forEach(function (id, i) {
      const h = hashObject(filled[i * 2]);
      if (!h.id) return;
      sums[id] = JSON.stringify(messageSummary(h, Number(filled[i * 2 + 1]) || 0));
      writes.push(['HSET', MSGSUM_KEY, id, sums[id]]);
    });
    if (writes.length) await redisPipeline(writes);
  }
  const messages = ids.map(function (id) { return parseJson(sums[id]); }).filter(Boolean);
  return send(res, 200, { messages: messages });
}

async function getMessage(res, id) {
  if (!UUID_RE.test(id)) return send(res, 400, { error: 'id', message: 'Identificador no válido.' });
  const out = await redisPipeline([['HGETALL', 'js:m:' + id], ['LRANGE', 'js:mr:' + id, 0, -1]]);
  const h = hashObject(out[0]);
  if (!h.id) return send(res, 404, { error: 'notfound', message: 'Mensaje no encontrado.' });
  const replies = (out[1] || []).map(parseJson).filter(Boolean);
  const results = replies.length
    ? await redisPipeline(replies.map(function (r) { return ['GET', 'js:dmres:' + r.job_id]; }))
    : [];
  return send(res, 200, {
    message: Object.assign(messageSummary(h, replies.length), { message: h.message || '' }),
    replies: replies.map(function (r, i) {
      return {
        by_id: String(r.by_id || ''),
        by_name: String(r.by_name || ''),
        text: String(r.text || ''),
        at: Number(r.at) || 0,
        delivery: results[i] || 'pending',
      };
    }),
  });
}

async function loadOrFail(res, id) {
  if (!UUID_RE.test(id)) { send(res, 400, { error: 'id', message: 'Identificador no válido.' }); return null; }
  const h = hashObject(await redis('HGETALL', 'js:m:' + id));
  if (!h.id) { send(res, 404, { error: 'notfound', message: 'Mensaje no encontrado.' }); return null; }
  return h;
}

async function claim(res, owner, id, force) {
  const h = await loadOrFail(res, id);
  if (!h) return;
  if (h.status === 'closed') return send(res, 409, { error: 'closed', message: 'Este mensaje ya está cerrado.' });

  if (force) {
    await redisPipeline([['HSET', 'js:m:' + id, 'claimed_by', owner.id, 'claimed_name', owner.name]]);
  } else if (h.claimed_by && h.claimed_by !== owner.id) {
    return send(res, 409, { error: 'claimed', message: 'Ya lo atiende ' + (h.claimed_name || 'otro owner') + '.' });
  } else if (!h.claimed_by) {
    const set = await redis('HSETNX', 'js:m:' + id, 'claimed_by', owner.id);
    if (String(set) !== '1') {
      const current = await redis('HGET', 'js:m:' + id, 'claimed_by');
      if (current !== owner.id) return send(res, 409, { error: 'claimed', message: 'Otro owner lo atendió justo antes.' });
    }
    await redis('HSET', 'js:m:' + id, 'claimed_name', owner.name);
  }
  if (h.status === 'new') await redis('HSET', 'js:m:' + id, 'status', 'claimed');
  await refreshSummary(id);
  return send(res, 200, { ok: true });
}

async function reply(res, owner, id, rawText) {
  const text = String(rawText || '').trim();
  if (text.length < 1 || text.length > 1800) {
    return send(res, 400, { error: 'text', message: 'La respuesta debe tener entre 1 y 1800 caracteres.' });
  }
  const h = await loadOrFail(res, id);
  if (!h) return;
  if (h.status === 'closed') return send(res, 409, { error: 'closed', message: 'Este mensaje ya está cerrado.' });
  if (h.claimed_by && h.claimed_by !== owner.id) {
    return send(res, 409, {
      error: 'claimed',
      message: 'Lo atiende ' + (h.claimed_name || 'otro owner') + '. Usa «Tomar» si quieres responder tú.',
    });
  }

  const jobId = crypto.randomUUID();
  await redisPipeline([
    ['HSET', 'js:m:' + id, 'claimed_by', owner.id, 'claimed_name', owner.name, 'status', 'answered'],
    ['HSETNX', 'js:m:' + id, 'first_reply_at', Date.now()],
    ['RPUSH', 'js:mr:' + id, JSON.stringify({ by_id: owner.id, by_name: owner.name, text: text, at: Date.now(), job_id: jobId })],
    ['EXPIRE', 'js:mr:' + id, MESSAGE_TTL],
    ['EXPIRE', 'js:m:' + id, MESSAGE_TTL],
    ['LPUSH', OUTBOX_KEY, JSON.stringify({
      type: 'dm', job_id: jobId, msg_id: id, user_id: h.user_id, by_name: owner.name, subject: h.subject || '', text: text,
    })],
  ]);
  await refreshSummary(id);
  return send(res, 200, { ok: true, job_id: jobId });
}

async function closeMessage(res, owner, id) {
  const h = await loadOrFail(res, id);
  if (!h) return;
  await redisPipeline([['HSET', 'js:m:' + id, 'status', 'closed', 'closed_by', owner.name]]);
  await refreshSummary(id);
  return send(res, 200, { ok: true });
}

/* ---------- tickets de Discord (los publica el bot) ---------- */

async function ticketsBoard(res) {
  const raw = await redis('GET', BOARD_PREFIX + need('GUILD_ID'));
  const board = raw ? parseJson(raw) : null;
  if (!board) return send(res, 200, { board: null, fresh: false, age_seconds: null });
  const age = Math.max(0, Math.round(Date.now() / 1000 - (Number(board.updated) || 0)));
  return send(res, 200, { board: board, fresh: age < 1200, age_seconds: age });
}

async function ticketAction(res, owner, body) {
  const type = TICKET_ACTIONS[body.action];
  const channelId = String(body.channel_id || '');
  if (!SNOWFLAKE_RE.test(channelId)) {
    return send(res, 400, { error: 'channel', message: 'Ticket no válido.' });
  }
  let text = '';
  if (type === 't_reply') {
    text = String(body.text || '').trim();
    if (text.length < 1 || text.length > 1500) {
      return send(res, 400, { error: 'text', message: 'La respuesta debe tener entre 1 y 1500 caracteres.' });
    }
  }
  const jobId = crypto.randomUUID();
  await redis('LPUSH', OUTBOX_KEY, JSON.stringify({
    type: type, job_id: jobId, guild_id: need('GUILD_ID'), channel_id: channelId,
    owner_id: owner.id, owner_name: owner.name, text: text,
  }));
  return send(res, 202, { job_id: jobId });
}

async function jobResult(res, id) {
  if (!UUID_RE.test(id)) return send(res, 400, { error: 'id', message: 'Identificador no válido.' });
  const raw = await redis('GET', TRES_PREFIX + id);
  const result = raw ? parseJson(raw) : null;
  return send(res, 200, result || { status: 'pending' });
}

module.exports = async function handler(req, res) {
  try {
    const session = getSession(req);
    if (!session) return send(res, 401, { error: 'login', message: 'Inicia sesión con Discord.' });
    if (!isOwner(session)) return send(res, 403, { error: 'forbidden', message: 'No tienes acceso a este panel.' });
    const owner = { id: session.id, name: session.name || session.username };

    if (req.method === 'GET') {
      const query = req.query || {};
      const action = String(query.action || '');
      if (action === 'me') return send(res, 200, { owner: true, id: owner.id, name: owner.name, avatar: avatarUrl(session) });
      if (action === 'list') return await listMessages(res);
      if (action === 'get') return await getMessage(res, String(query.id || ''));
      if (action === 'tickets') return await ticketsBoard(res);
      if (action === 'jobresult') return await jobResult(res, String(query.id || ''));
      return send(res, 400, { error: 'action', message: 'Acción no válida.' });
    }

    if (req.method === 'POST') {
      if (!checkOrigin(req)) return send(res, 403, { error: 'origin', message: 'Solicitud no permitida.' });
      const body = readBody(req);
      if (!body) return send(res, 400, { error: 'body', message: 'Datos no válidos.' });
      const id = String(body.id || '');
      if (body.action === 'claim') return await claim(res, owner, id, false);
      if (body.action === 'takeover') return await claim(res, owner, id, true);
      if (body.action === 'reply') return await reply(res, owner, id, body.text);
      if (body.action === 'close') return await closeMessage(res, owner, id);
      if (Object.prototype.hasOwnProperty.call(TICKET_ACTIONS, body.action)) return await ticketAction(res, owner, body);
      return send(res, 400, { error: 'action', message: 'Acción no válida.' });
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'method', message: 'Método no permitido.' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'server', message: 'Error interno. Inténtalo más tarde.' });
  }
};
