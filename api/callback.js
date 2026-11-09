'use strict';
const {
  COOKIE, STATE_COOKIE, NEXT_COOKIE, NEXT_TARGETS, SESSION_DAYS,
  UG_PREFIX, need, siteUrl, sign, parseCookies, setCookie, redirect, redis,
} = require('../lib/common');

module.exports = async function handler(req, res) {
  const cookies = parseCookies(req);
  const next = Object.prototype.hasOwnProperty.call(NEXT_TARGETS, cookies[NEXT_COOKIE]) ? cookies[NEXT_COOKIE] : '';
  const FAIL_TARGETS = { admin: '/admin.html?login=error', verify: '/verify.html?login=error', dashboard: '/dashboard.html?login=error' };
  const fail = function () { redirect(res, FAIL_TARGETS[next] || '/?login=error#tickets'); };
  try {
    const query = req.query || {};
    const code = String(query.code || '');
    const state = String(query.state || '');
    const saved = cookies[STATE_COOKIE];
    setCookie(res, STATE_COOKIE, '', 0);
    setCookie(res, NEXT_COOKIE, '', 0);
    if (!code || !state || !saved || state !== saved) return fail();

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: need('DISCORD_CLIENT_ID'),
        client_secret: need('DISCORD_CLIENT_SECRET'),
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: siteUrl() + '/api/callback',
      }),
    });
    if (!tokenResponse.ok) return fail();
    const token = await tokenResponse.json();

    const meResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + token.access_token },
    });
    if (!meResponse.ok) return fail();
    const me = await meResponse.json();
    if (!me || !me.id) return fail();

    const session = {
      id: String(me.id),
      username: String(me.username || ''),
      name: String(me.global_name || me.username || ''),
      avatar: me.avatar || null,
      exp: Date.now() + SESSION_DAYS * 24 * 3600 * 1000,
    };
    if (next === 'dashboard') {
      const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: 'Bearer ' + token.access_token },
      });
      if (!guildsResponse.ok) return fail();
      const guilds = await guildsResponse.json();
      if (!Array.isArray(guilds)) return fail();
      // Solo los servidores donde la persona es dueña, administradora o puede gestionar el servidor.
      const manageable = guilds.filter(function (g) {
        let perms = 0n;
        try { perms = BigInt(String(g.permissions || '0')); } catch (err) { perms = 0n; }
        return g.owner === true || (perms & 0x28n) !== 0n;
      }).slice(0, 200).map(function (g) {
        return { id: String(g.id), name: String(g.name || ''), icon: g.icon || null };
      });
      await redis('SET', UG_PREFIX + session.id, JSON.stringify(manageable), 'EX', '3600');
    }
    setCookie(res, COOKIE, sign(session), SESSION_DAYS * 24 * 3600);
    redirect(res, NEXT_TARGETS[next] || '/#tickets');
  } catch (err) {
    console.error(err);
    fail();
  }
};
