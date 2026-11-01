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
const QUEUE_KEY = 'js:tickets';
const RESULT_PREFIX = 'js:result:';
const COOLDOWN_PREFIX = 'js:cd:';
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
  const index = Number((BigInt(user.id) >> 22n) % 6n);
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

module.exports = {
  COOKIE, STATE_COOKIE, QUEUE_KEY, RESULT_PREFIX, COOLDOWN_PREFIX, KINDS, SESSION_DAYS,
  need, siteUrl, sign, verify, parseCookies, setCookie, getSession, send, redirect, avatarUrl, redis,
};
