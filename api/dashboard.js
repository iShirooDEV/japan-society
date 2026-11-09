'use strict';
const crypto = require('crypto');
const {
  OUTBOX_KEY, DASH_PREFIX, BOT_GUILDS_KEY, UG_PREFIX, CRES_PREFIX, DASH_KEYS,
  need, getSession, checkOrigin, readBody, send, redis,
} = require('../lib/common');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNOWFLAKE_RE = /^\d{5,25}$/;
const PANELS = ['tickets', 'verificacion'];

function parseJson(text) {
  try { return JSON.parse(text); } catch (err) { return null; }
}

/** Servidores que la persona puede gestionar (se guardan al iniciar sesión en el dashboard). */
async function manageableGuilds(session) {
  const raw = await redis('GET', UG_PREFIX + session.id);
  const list = raw ? parseJson(raw) : null;
  return Array.isArray(list) ? list : null;
}

function inviteUrl(guildId) {
  const params = new URLSearchParams({
    client_id: need('DISCORD_CLIENT_ID'),
    scope: 'bot applications.commands',
    permissions: '268561424',
  });
  if (guildId) { params.set('guild_id', guildId); params.set('disable_guild_select', 'true'); }
  return 'https://discord.com/oauth2/authorize?' + params.toString();
}

async function listGuilds(res, session) {
  const mine = await manageableGuilds(session);
  if (!mine) {
    return send(res, 403, { error: 'relogin', message: 'Vuelve a iniciar sesión para cargar tus servidores.' });
  }
  const raw = await redis('GET', BOT_GUILDS_KEY);
  const botGuilds = (raw ? parseJson(raw) : null) || [];
  const withBot = mine.filter(function (g) { return botGuilds.indexOf(g.id) !== -1; });
  const missing = mine.filter(function (g) { return botGuilds.indexOf(g.id) === -1; }).map(function (g) {
    return Object.assign({}, g, { invite_url: inviteUrl(g.id) });
  });
  return send(res, 200, { guilds: withBot, missing: missing, invite_url: inviteUrl('') });
}

async function guildConfig(res, session, guildId) {
  if (!SNOWFLAKE_RE.test(guildId)) return send(res, 400, { error: 'guild', message: 'Servidor no válido.' });
  const mine = await manageableGuilds(session);
  if (!mine) return send(res, 403, { error: 'relogin', message: 'Vuelve a iniciar sesión para cargar tus servidores.' });
  if (!mine.some(function (g) { return g.id === guildId; })) {
    return send(res, 403, { error: 'forbidden', message: 'No puedes gestionar ese servidor.' });
  }
  const raw = await redis('GET', DASH_PREFIX + guildId);
  const data = raw ? parseJson(raw) : null;
  if (!data) return send(res, 200, { data: null, fresh: false, age_seconds: null });
  const age = Math.max(0, Math.round(Date.now() / 1000 - (Number(data.updated) || 0)));
  return send(res, 200, { data: data, fresh: age < 1500, age_seconds: age });
}

/** Valida un valor del formulario: null, '' (quitar), un ID numérico o un entero. */
function cleanValue(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 1000 ? { ok: true, value: value } : { ok: false };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return { ok: true, value: '' };
    return /^\d{1,20}$/.test(trimmed) ? { ok: true, value: trimmed } : { ok: false };
  }
  return { ok: false };
}

async function authorizeGuild(res, session, guildId) {
  if (!SNOWFLAKE_RE.test(guildId)) { send(res, 400, { error: 'guild', message: 'Servidor no válido.' }); return false; }
  const mine = await manageableGuilds(session);
  if (!mine) { send(res, 403, { error: 'relogin', message: 'Vuelve a iniciar sesión para cargar tus servidores.' }); return false; }
  if (!mine.some(function (g) { return g.id === guildId; })) {
    send(res, 403, { error: 'forbidden', message: 'No puedes gestionar ese servidor.' });
    return false;
  }
  return true;
}

async function cooldown(res, session) {
  const ok = await redis('SET', 'js:dcd:' + session.id, '1', 'NX', 'EX', '5');
  if (ok !== 'OK') { send(res, 429, { error: 'cooldown', message: 'Espera unos segundos antes de guardar otra vez.' }); return false; }
  return true;
}

async function saveChanges(res, session, body) {
  const guildId = String(body.guild || '');
  const changes = body.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return send(res, 400, { error: 'changes', message: 'No hay cambios que guardar.' });
  }
  const keys = Object.keys(changes);
  if (!keys.length || keys.length > DASH_KEYS.length) {
    return send(res, 400, { error: 'changes', message: 'No hay cambios que guardar.' });
  }
  const clean = {};
  for (let i = 0; i < keys.length; i++) {
    if (DASH_KEYS.indexOf(keys[i]) === -1) return send(res, 400, { error: 'key', message: 'Opción no válida.' });
    const checked = cleanValue(changes[keys[i]]);
    if (!checked.ok) return send(res, 400, { error: 'value', message: 'Hay un valor no válido en los cambios.' });
    clean[keys[i]] = checked.value;
  }
  if (!(await authorizeGuild(res, session, guildId))) return;
  if (!(await cooldown(res, session))) return;
  const jobId = crypto.randomUUID();
  await redis('LPUSH', OUTBOX_KEY, JSON.stringify({
    type: 'cfg_set', job_id: jobId, guild_id: guildId, user_id: session.id, changes: clean,
  }));
  return send(res, 202, { job_id: jobId });
}

async function publishPanel(res, session, body) {
  const guildId = String(body.guild || '');
  const kind = String(body.kind || '');
  const channelId = String(body.channel_id || '');
  if (PANELS.indexOf(kind) === -1) return send(res, 400, { error: 'kind', message: 'Tipo de panel no válido.' });
  if (!SNOWFLAKE_RE.test(channelId)) return send(res, 400, { error: 'channel', message: 'Elige un canal.' });
  if (!(await authorizeGuild(res, session, guildId))) return;
  if (!(await cooldown(res, session))) return;
  const jobId = crypto.randomUUID();
  await redis('LPUSH', OUTBOX_KEY, JSON.stringify({
    type: 'cfg_panel', job_id: jobId, guild_id: guildId, user_id: session.id, kind: kind, channel_id: channelId,
  }));
  return send(res, 202, { job_id: jobId });
}

async function jobResult(res, session, id) {
  if (!UUID_RE.test(id)) return send(res, 400, { error: 'id', message: 'Identificador no válido.' });
  const raw = await redis('GET', CRES_PREFIX + id);
  const result = raw ? parseJson(raw) : null;
  if (!result) return send(res, 200, { status: 'pending' });
  if (String(result.user_id) !== session.id) return send(res, 404, { error: 'notfound', message: 'No encontrado.' });
  return send(res, 200, result);
}

module.exports = async function handler(req, res) {
  try {
    const session = getSession(req);
    if (!session) return send(res, 401, { error: 'login', message: 'Inicia sesión con Discord para continuar.' });

    if (req.method === 'GET') {
      const query = req.query || {};
      const action = String(query.action || '');
      if (action === 'guilds') return await listGuilds(res, session);
      if (action === 'config') return await guildConfig(res, session, String(query.guild || ''));
      if (action === 'jobresult') return await jobResult(res, session, String(query.id || ''));
      return send(res, 400, { error: 'action', message: 'Acción no válida.' });
    }

    if (req.method === 'POST') {
      if (!checkOrigin(req)) return send(res, 403, { error: 'origin', message: 'Solicitud no permitida.' });
      const body = readBody(req);
      if (!body) return send(res, 400, { error: 'body', message: 'Datos no válidos.' });
      if (body.action === 'save') return await saveChanges(res, session, body);
      if (body.action === 'panel') return await publishPanel(res, session, body);
      return send(res, 400, { error: 'action', message: 'Acción no válida.' });
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'method', message: 'Método no permitido.' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'server', message: 'Error interno. Inténtalo más tarde.' });
  }
};
