'use strict';
const { COOKIE, setCookie, redirect } = require('../lib/common');

module.exports = async function handler(req, res) {
  setCookie(res, COOKIE, '', 0);
  redirect(res, '/#tickets');
};
