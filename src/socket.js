// src/socket.js
const { Server }                = require('socket.io')
const { registerDuelHandlers } = require('./duelSocket')
const { registerSoloHandlers } = require('./soloSocket')

function initSocket(server) {
  // Build an allow-list from the env var
  const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map(u => u.trim());

  // Dynamic CORS origin function
  const originChecker = (incomingOrigin, callback) => {
    if (!incomingOrigin) 
      return callback(null, true);              // allow tools like curl or mobile apps
    if (allowedOrigins.includes(incomingOrigin)) 
      return callback(null, incomingOrigin);    // echo back the single, valid origin
    callback(new Error('CORS not allowed'), false);
  };

  const io = new Server(server, {
    cors: {
      origin: originChecker,
      methods: ['GET','POST']
    }
  });

  // wire up duel and solo modes
  registerDuelHandlers(io)
  registerSoloHandlers(io)

  return io
}

module.exports = { initSocket }
