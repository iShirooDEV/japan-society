'use strict';
/**
 * JAPAN Society™ · utilidades compartidas de la API de tickets.
 * Variables de entorno necesarias (Vercel → Settings → Environment Variables):
 *   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET, SITE_URL, GUILD_ID,
 *   UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN (o KV_REST_API_URL / KV_REST_API_TOKEN).
 */
const crypto = require('crypto');

const COOKIE = 'js_session';
const STATE_COOKIE = 'js_state';
const VERSION = '2026-11-verificacion';
const QUEUE_KEY = 'js:queue'; // cola única: tickets, avisos a owners y respuestas por mensaje directo
const RESULT_PREFIX = 'js:result:';
const COOLDOWN_PREFIX = 'js:cd:';
const STATUS_KEY = 'js:status';
const OUTBOX_KEY = QUEUE_KEY; // alias, se mantiene por compatibilidad
const MSGSUM_KEY = 'js:msgsum'; // resumen de todos los mensajes a owners (una sola lectura para la lista)
const BOARD_PREFIX = 'js:tboard:'; // tickets de Discord publicados por el bot
const TRES_PREFIX = 'js:tres:'; // resultado de las acciones de tickets
const VERIFY_RES_PREFIX = 'js:vres:'; // resultado de las verificaciones
const NEXT_COOKIE = 'js_next';
const NEXT_TARGETS = { admin: '/admin.html', contacto: '/#dueno', tickets: '/#tickets', verify: '/verify.html' };
const MESSAGE_TTL = 90 * 24 * 3600;
const KINDS = ['soporte', 'alianza', 'bot', 'otro'];
const SESSION_DAYS = 7;

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error('Falta la variable de entorno ' + name);
  return value;
}

function siteUrl() {
  return need('SITE_URL').replace(/\/+$/, '');
}

function hmac(body) {
  return crypto.createHmac('sha256', need('SESSION_SECRET')).update(body).digest('base64url');
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + hmac(body);
}

function verify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(hmac(parts[0]));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!data || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch (err) {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i <= 0) return;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch (err) {
      /* cookie mal formada: se ignora */
    }
  });
  return out;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const cookie = [
    name + '=' + encodeURIComponent(value),
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=' + maxAgeSeconds,
  ].join('; ');
  const previous = res.getHeader('Set-Cookie');
  const list = Array.isArray(previous) ? previous : previous ? [previous] : [];
  res.setHeader('Set-Cookie', list.concat(cookie));
}

function getSession(req) {
  return verify(parseCookies(req)[COOKIE]);
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function avatarUrl(user) {
  if (user.avatar) {
    return 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=64';
  }
  let index = 0;
  try {
    index = Number((BigInt(user.id) >> 22n) % 6n);
  } catch (err) {
    index = 0;
  }
  return 'https://cdn.discordapp.com/embed/avatars/' + index + '.png';
}

async function redis() {
  const args = Array.prototype.slice.call(arguments).map(String);
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Falta la configuración de Redis');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || 'Redis respondió ' + response.status);
  return data.result;
}

function redisInfo() {
  const upstash = process.env.UPSTASH_REDIS_REST_URL || '';
  const url = upstash || process.env.KV_REST_API_URL || '';
  const host = String(url).replace(/^https?:\/\//, '').split('/')[0];
  const hint = host.length <= 16 ? (host || '(vacío)') : host.slice(0, 6) + '…' + host.slice(-14);
  return { source: upstash ? 'UPSTASH_REDIS_REST_URL' : (url ? 'KV_REST_API_URL' : 'ninguna'), host_hint: hint };
}

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Falta la configuración de Redis');
  return { url: String(url).replace(/\/+$/, ''), token: token };
}

/** Ejecuta varios comandos de Redis en una sola petición y devuelve sus resultados en orden. */
async function redisPipeline(commands) {
  const cfg = redisConfig();
  const response = await fetch(cfg.url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands.map(function (cmd) { return cmd.map(String); })),
  });
  const data = await response.json();
  if (!response.ok || !Array.isArray(data)) {
    throw new Error((data && data.error) || 'Redis respondió ' + response.status);
  }
  return data.map(function (item) {
    if (item && item.error) throw new Error(item.error);
    return item ? item.result : null;
  });
}

/** Convierte la respuesta plana de HGETALL ([clave, valor, ...]) en un objeto. */
function hashObject(flat) {
  const out = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  }
  return out;
}

/** Resumen compacto de un mensaje a los owners, para la lista y las estadísticas del panel. */
function messageSummary(h, replyCount) {
  return {
    id: h.id,
    user_id: h.user_id || '',
    name: h.name || h.username || '',
    username: h.username || '',
    subject: h.subject || '',
    created: Number(h.created) || 0,
    status: h.status || 'new',
    claimed_by: h.claimed_by || '',
    claimed_name: h.claimed_name || '',
    reply_count: Number(replyCount) || 0,
    first_reply_at: Number(h.first_reply_at) || 0,
  };
}

/** IP del visitante (Vercel la entrega en estas cabeceras). */
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers['x-real-ip'] || '').trim() || '';
}

function ownerIds() {
  return String(process.env.OWNER_IDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function isOwner(session) {
  return !!session && ownerIds().indexOf(String(session.id)) !== -1;
}

function checkOrigin(req) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  return origin === siteUrl();
}

function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = null; }
  }
  return body && typeof body === 'object' ? body : null;
}

module.exports = {
  VERSION, VERIFY_RES_PREFIX, clientIp, MSGSUM_KEY, BOARD_PREFIX, TRES_PREFIX, messageSummary, COOKIE, STATE_COOKIE, QUEUE_KEY, RESULT_PREFIX, COOLDOWN_PREFIX, STATUS_KEY, OUTBOX_KEY, NEXT_COOKIE, NEXT_TARGETS,
  MESSAGE_TTL, KINDS, SESSION_DAYS, redisPipeline, hashObject, ownerIds, isOwner, checkOrigin, readBody,
  need, siteUrl, sign, verify, parseCookies, setCookie, getSession, send, redirect, avatarUrl, redis, redisInfo,
};
