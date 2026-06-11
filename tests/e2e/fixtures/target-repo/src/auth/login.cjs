function login(password) {
  return password === 'secret' ? 'ok' : 'denied';
}

module.exports = { login };
