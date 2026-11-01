'use strict';
const {
  COOKIE, STATE_COOKIE, SESSION_DAYS, need, siteUrl, sign, parseCookies, setCookie, redirect,
} = require('../lib/common');

module.exports = async function handler(req, res) {
  const fail = function () { redirect(res, '/?login=error#tickets'); };
  try {
    const query = req.query || {};
    const code = String(query.code || '');
    const state = String(query.state || '');
    const saved = parseCookies(req)[STATE_COOKIE];
    setCookie(res, STATE_COOKIE, '', 0);
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
    setCookie(res, COOKIE, sign(session), SESSION_DAYS * 24 * 3600);
    redirect(res, '/#tickets');
  } catch (err) {
    console.error(err);
    fail();
  }
};
