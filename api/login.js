'use strict';
const crypto = require('crypto');
const { STATE_COOKIE, NEXT_COOKIE, NEXT_TARGETS, need, siteUrl, setCookie, redirect, send } = require('../lib/common');

module.exports = async function handler(req, res) {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    setCookie(res, STATE_COOKIE, state, 600);
    const next = String((req.query && req.query.next) || '');
    if (Object.prototype.hasOwnProperty.call(NEXT_TARGETS, next)) setCookie(res, NEXT_COOKIE, next, 600);
    const params = new URLSearchParams({
      client_id: need('DISCORD_CLIENT_ID'),
      redirect_uri: siteUrl() + '/api/callback',
      response_type: 'code',
      scope: 'identify',
      state: state,
      prompt: 'none',
    });
    redirect(res, 'https://discord.com/oauth2/authorize?' + params.toString());
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'server', message: 'El inicio de sesión no está configurado.' });
  }
};
