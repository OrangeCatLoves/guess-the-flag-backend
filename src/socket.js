// src/socket.js
const { Server }                = require('socket.io')
const { registerDuelHandlers } = require('./duelSocket')
const { registerSoloHandlers } = require('./soloSocket')

function initSocket(server) {
  // Read FRONTEND_URL from env, fallback to localhost for dev
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'
  const io = new Server(server, {
    cors: { origin: FRONTEND_URL.split(','), methods: ['GET','POST'] }
  })

  // wire up duel and solo modes
  registerDuelHandlers(io)
  registerSoloHandlers(io)

  return io
}

module.exports = { initSocket }
