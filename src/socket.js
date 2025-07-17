const { Server }   = require('socket.io')
const { v4: uuidv4 } = require('uuid')
const db            = require('./db')
const { flags, getRandomFlag } = require('./game')

const ROUND_DURATION = 25 * 1000 // milliseconds
// track running score per session
const sessionScores = new Map()       // sessionId → Map<socketId, score>
const onlineUsers   = new Map()       // socketId → user info

let io
function initSocket(server) {
  io = new Server(server, {
    cors: { origin: "http://localhost:5173", methods: ["GET","POST"] }
  })

  io.on('connection', socket => {
    console.log(`✅ User connected: ${socket.id}`)

    // 1) registration
    socket.on('register', async ({ userId, username, guest }) => {
      let wins = 0
      if (!guest) {
        const { rows } = await db.query(
          'SELECT duelvictories FROM users WHERE id=$1',
          [userId]
        )
        wins = rows[0]?.duelvictories || 0
      }
      onlineUsers.set(socket.id, { socketId: socket.id, userId, username, guest, duelvictories: wins })
      broadcastOnlineUsers()
    })

    // 2) invite someone
    socket.on('invite', ({ toSocketId }) => {
      const sender = onlineUsers.get(socket.id)
      if (!sender) return
      io.to(toSocketId).emit('invite-received', {
        socketId:      socket.id,
        username:      sender.username,
        guest:         sender.guest,
        duelvictories: sender.duelvictories
      })
    })

    // 3) accept invite → start duel
    socket.on('accept-invite', async ({ inviterSocketId }) => {
      // pick five distinct flags
      const allCodes = flags.map(f => f.code)
      for (let i = allCodes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[allCodes[i], allCodes[j]] = [allCodes[j], allCodes[i]]
      }
      const codes = allCodes.slice(0, 5)

      // create session row
      const sessionId = uuidv4()
      await db.query(
        `INSERT INTO sessions (id, flag_code, flag_codes, started_at)
         VALUES ($1, $2, $3, NOW())`,
        [sessionId, codes[0], JSON.stringify(codes)]
      )

      // init in-memory score tracker
      sessionScores.set(sessionId, new Map())

      // join both players to room
      socket.join(sessionId)
      const inviter = io.sockets.sockets.get(inviterSocketId)
      if (inviter) inviter.join(sessionId)

      // kickoff
      io.to(sessionId).emit('start-duel', { sessionId })

      // schedule game-over after all rounds
      setTimeout(() => {
        const scoresMap = sessionScores.get(sessionId) || new Map()
        const members   = Array.from(io.sockets.adapter.rooms.get(sessionId) || [])
        if (members.length < 2) return

        const [a, b]     = members
        const userA      = onlineUsers.get(a)
        const userB      = onlineUsers.get(b)
        const scoreA     = scoresMap.get(a) || 0
        const scoreB     = scoresMap.get(b) || 0

        // send each their personalized result
        io.to(a).emit('game-over', {
          you:      { name: userA.username, score: scoreA },
          opponent: { name: userB.username, score: scoreB }
        })
        io.to(b).emit('game-over', {
          you:      { name: userB.username, score: scoreB },
          opponent: { name: userA.username, score: scoreA }
        })

        sessionScores.delete(sessionId)
      }, ROUND_DURATION * 5 + 500)
    })

    // 4) handle guess submission
    socket.on('submit-guess', ({ sessionId, guess, hintsUsed, timeLeft }) => {
      const scoresMap = sessionScores.get(sessionId)
      if (!scoresMap) return

      // calculate hint‐penalty
      const penalties = [150, 300, 750]
      const count     = Math.min(Number(hintsUsed) || 0, penalties.length)
      const hintPenalty = penalties.slice(0, count).reduce((s,p) => s + p, 0)

      // base and time‐fraction
      const base = Math.max(1500 - hintPenalty, 0)
      const pts  = Math.floor(base * (timeLeft / (ROUND_DURATION/1000)))

      // update running total
      const prev = scoresMap.get(socket.id) || 0
      scoresMap.set(socket.id, prev + pts)

      // send back updated total for *this* player
      socket.emit('score-update', {
        socketId:   socket.id,
        totalScore: scoresMap.get(socket.id)
      })
    })

    // 5) cleanup on disconnect
    socket.on('disconnect', () => {
      onlineUsers.delete(socket.id)
      broadcastOnlineUsers()
    })
  })
}

function broadcastOnlineUsers() {
  io.emit('online-users', Array.from(onlineUsers.values()))
}

module.exports = { initSocket }
