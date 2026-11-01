'use strict';
const { getSession, send, avatarUrl } = require('../lib/common');

module.exports = async function handler(req, res) {
  try {
    const session = getSession(req);
    if (!session) return send(res, 200, { logged: false });
    send(res, 200, {
      logged: true,
      id: session.id,
      name: session.name,
      username: session.username,
      avatar: avatarUrl(session),
    });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'server', message: 'El sistema de tickets no está disponible.' });
  }
};
