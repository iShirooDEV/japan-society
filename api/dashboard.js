'use strict';
const crypto = require('crypto');
const {
  OUTBOX_KEY, DASH_PREFIX, BOT_GUILDS_KEY, UG_PREFIX, CRES_PREFIX, DASH_KEYS,
  need, getSession, checkOrigin, readBody, send, redis,
} = require('../lib/common');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNOWFLAKE_RE = /^\d{5,25}$/;
const PANELS = ['tickets', 'verificacion'];
const PROFILES = ['estricto', 'equilibrado', 'monitor', 'apagado'];
const NINO_KEYS = [
  'log_channel', 'report_channel', 'verified_role', 'unverified_role', 'verify_mode', 'join_action', 'nuke_action',
  'staff_roles', 'whitelist_roles', 'exempt_channels', 'allowed_domains', 'banned_words', 'alert_words',
];
const NINO_KEY_RE = /^(antiraid|automod|settings):[a-z0-9_]{1,40}$/;

/** Cada bot tiene su propia cola y sus propias claves en Redis, para no mezclar los trabajos. */
const BOTS = {
  japan: { cfg: DASH_PREFIX, guilds: BOT_GUILDS_KEY, res: CRES_PREFIX, queue: OUTBOX_KEY },
  nino: { cfg: 'nino:cfg:', guilds: 'nino:botguilds', res: 'nino:cres:', queue: 'nino:queue' },
};
function botOf(name) {
  const key = String(name || 'japan');
  return Object.prototype.hasOwnProperty.call(BOTS, key) ? key : null;
}
function validKey(bot, key) {
  return bot === 'nino' ? (NINO_KEYS.indexOf(key) !== -1 || NINO_KEY_RE.test(key)) : DASH_KEYS.indexOf(key) !== -1;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (err) { return null; }
}

/** Servidores que la persona puede gestionar (se guardan al iniciar sesión en el dashboard). */
async function manageableGuilds(session) {
  const raw = await redis('GET', UG_PREFIX + session.id);
  const list = raw ? parseJson(raw) : null;
  return Array.isArray(list) ? list : null;
}

function inviteUrl(bot, guildId) {
  const nino = bot === 'nino';
  const params = new URLSearchParams({
    client_id: nino ? (process.env.NINO_CLIENT_ID || '1515472994279886878') : need('DISCORD_CLIENT_ID'),
    scope: 'bot applications.commands',
    permissions: nino ? '1100317060246' : '268561424',
  });
  if (guildId) { params.set('guild_id', guildId); params.set('disable_guild_select', 'true'); }
  return 'https://discord.com/oauth2/authorize?' + params.toString();
}

async function listGuilds(res, session, bot) {
  const mine = await manageableGuilds(session);
  if (!mine) {
    return send(res, 403, { error: 'relogin', message: 'Vuelve a iniciar sesión para cargar tus servidores.' });
  }
  const raw = await redis('GET', BOTS[bot].guilds);
  const botGuilds = (raw ? parseJson(raw) : null) || [];
  const withBot = mine.filter(function (g) { return botGuilds.indexOf(g.id) !== -1; });
  const missing = mine.filter(function (g) { return botGuilds.indexOf(g.id) === -1; }).map(function (g) {
    return Object.assign({}, g, { invite_url: inviteUrl(bot, g.id) });
  });
  return send(res, 200, { guilds: withBot, missing: missing, invite_url: inviteUrl(bot, '') });
}

async function guildConfig(res, session, guildId, bot) {
  if (!SNOWFLAKE_RE.test(guildId)) return send(res, 400, { error: 'guild', message: 'Servidor no válido.' });
  const mine = await manageableGuilds(session);
  if (!mine) return send(res, 403, { error: 'relogin', message: 'Vuelve a iniciar sesión para cargar tus servidores.' });
  if (!mine.some(function (g) { return g.id === guildId; })) {
    return send(res, 403, { error: 'forbidden', message: 'No puedes gestionar ese servidor.' });
  }
  const raw = await redis('GET', BOTS[bot].cfg + guildId);
  const data = raw ? parseJson(raw) : null;
  if (!data) return send(res, 200, { data: null, fresh: false, age_seconds: null });
  const age = Math.max(0, Math.round(Date.now() / 1000 - (Number(data.updated) || 0)));
  return send(res, 200, { data: data, fresh: age < 1500, age_seconds: age });
}

/** Valida un valor del formulario: null, '' (quitar), un ID numérico o un entero. */
function cleanValue(value, bot) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (bot === 'nino') {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= 100000 ? { ok: true, value: value } : { ok: false };
    const okText = function (t) { return typeof t === 'string' && t.length <= 80 && !/[\u0000-\u001f]/.test(t); };
    if (typeof value === 'string') return okText(value) ? { ok: true, value: value.trim() } : { ok: false };
    if (Array.isArray(value) && value.length <= 400 && value.every(okText)) {
      return { ok: true, value: value.map(function (t) { return t.trim(); }) };
    }
    return { ok: false };
  }
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

async function saveChanges(res, session, body, bot) {
  const guildId = String(body.guild || '');
  const changes = body.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return send(res, 400, { error: 'changes', message: 'No hay cambios que guardar.' });
  }
  const keys = Object.keys(changes);
  if (!keys.length || keys.length > (bot === 'nino' ? 100 : DASH_KEYS.length) || JSON.stringify(changes).length > 40000) {
    return send(res, 400, { error: 'changes', message: 'No hay cambios que guardar.' });
  }
  const clean = {};
  for (let i = 0; i < keys.length; i++) {
    if (!validKey(bot, keys[i])) return send(res, 400, { error: 'key', message: 'Opción no válida.' });
    const checked = cleanValue(changes[keys[i]], bot);
    if (!checked.ok) return send(res, 400, { error: 'value', message: 'Hay un valor no válido en los cambios.' });
    clean[keys[i]] = checked.value;
  }
  if (!(await authorizeGuild(res, session, guildId))) return;
  if (!(await cooldown(res, session))) return;
  const jobId = crypto.randomUUID();
  await redis('LPUSH', BOTS[bot].queue, JSON.stringify({
    type: 'cfg_set', job_id: jobId, guild_id: guildId, user_id: session.id, changes: clean,
  }));
  return send(res, 202, { job_id: jobId });
}

async function publishPanel(res, session, body, bot) {
  if (bot !== 'japan') return send(res, 400, { error: 'panel', message: 'Este bot no tiene paneles para publicar.' });
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

async function applyProfile(res, session, body, bot) {
  const guildId = String(body.guild || '');
  const profile = String(body.profile || '');
  if (bot !== 'nino' || PROFILES.indexOf(profile) === -1) return send(res, 400, { error: 'profile', message: 'Perfil no válido.' });
  if (!(await authorizeGuild(res, session, guildId))) return;
  if (!(await cooldown(res, session))) return;
  const jobId = crypto.randomUUID();
  await redis('LPUSH', BOTS[bot].queue, JSON.stringify({
    type: 'cfg_profile', job_id: jobId, guild_id: guildId, user_id: session.id, profile: profile,
  }));
  return send(res, 202, { job_id: jobId });
}

async function jobResult(res, session, id, bot) {
  if (!UUID_RE.test(id)) return send(res, 400, { error: 'id', message: 'Identificador no válido.' });
  const raw = await redis('GET', BOTS[bot].res + id);
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
      const bot = botOf(query.bot);
      if (!bot) return send(res, 400, { error: 'bot', message: 'Bot no válido.' });
      if (action === 'guilds') return await listGuilds(res, session, bot);
      if (action === 'config') return await guildConfig(res, session, String(query.guild || ''), bot);
      if (action === 'jobresult') return await jobResult(res, session, String(query.id || ''), bot);
      return send(res, 400, { error: 'action', message: 'Acción no válida.' });
    }

    if (req.method === 'POST') {
      if (!checkOrigin(req)) return send(res, 403, { error: 'origin', message: 'Solicitud no permitida.' });
      const body = readBody(req);
      if (!body) return send(res, 400, { error: 'body', message: 'Datos no válidos.' });
      const bot = botOf(body.bot);
      if (!bot) return send(res, 400, { error: 'bot', message: 'Bot no válido.' });
      if (body.action === 'save') return await saveChanges(res, session, body, bot);
      if (body.action === 'panel') return await publishPanel(res, session, body, bot);
      if (body.action === 'profile') return await applyProfile(res, session, body, bot);
      return send(res, 400, { error: 'action', message: 'Acción no válida.' });
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'method', message: 'Método no permitido.' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'server', message: 'Error interno. Inténtalo más tarde.' });
  }
};
