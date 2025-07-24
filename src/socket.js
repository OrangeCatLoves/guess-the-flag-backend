// src/socket.js
const { Server }                = require('socket.io')
const { registerDuelHandlers } = require('./duelSocket')
const { registerSoloHandlers } = require('./soloSocket')

function initSocket(server) {
  const io = new Server(server, {
    cors: { origin: 'http://localhost:5173', methods: ['GET','POST'] }
  })

  // wire up duel and solo modes
  registerDuelHandlers(io)
  registerSoloHandlers(io)

  return io
}

module.exports = { initSocket }
