// src/socket.js
const { Server }     = require('socket.io')
const { v4: uuidv4 } = require('uuid')
const db             = require('./db')
const { flags }      = require('./game')

const ROUND_DURATION = 25 * 1000 // ms per round

// In‑memory stores
const sessionFlags      = new Map() // sessionId → [flagCodes]
const sessionHintUsage  = new Map() // sessionId → Map<clientId,{ round, used:[] }>
const sessionScores     = new Map() // sessionId → Map<clientId,score>
const sessionSubs       = new Map() // sessionId → Map<clientId,Set<round>>
const sessionStartTimes = new Map() // sessionId → timestamp
const sessionIntervals  = new Map() // sessionId → interval ID
const onlineUsers       = new Map() // socketId → user info
const socketToClient    = new Map() // socketId → clientId

let io
function initSocket(server) {
  io = new Server(server, {
    cors: { origin: "http://localhost:5173", methods: ["GET","POST"] }
  })

  io.on('connection', socket => {
    console.log(`✅ User connected: ${socket.id}`)

    //
    // 0) Re-join + rehydrate on refresh
    //
    socket.on('join-session', ({ sessionId, clientId }) => {
      if (!sessionFlags.has(sessionId)) return

      socket.join(sessionId)
      socketToClient.set(socket.id, clientId)

      // emit current timer
      const startTs = sessionStartTimes.get(sessionId)
      if (startTs) {
        const elapsed  = Math.floor((Date.now() - startTs) / 1000)
        const perRound = ROUND_DURATION / 1000
        const idx      = Math.min(Math.floor(elapsed / perRound), 4)
        const roundNum = idx + 1
        const secInto  = elapsed % perRound
        const timeLeft = Math.max(perRound - secInto, 0)
        socket.emit('timer', { round: roundNum, timeLeft })

        // re‑emit any hints used this round
        const perHints = sessionHintUsage.get(sessionId)
        if (perHints) {
          const usage = perHints.get(clientId)
          if (usage && usage.round === roundNum) {
            usage.used.forEach(h =>
              socket.emit('hint-selected', { hint: h, usedCount: usage.used.length })
            )
          }
        }
      }

      // rehydrate score + submissions
      const scoresMap = sessionScores.get(sessionId) || new Map()
      const yourScore = scoresMap.get(clientId) || 0
      const subsMap   = sessionSubs.get(sessionId)   || new Map()
      const yourSubs  = subsMap.get(clientId)        || new Set()
      socket.emit('rehydrate-state', {
        totalScore:      yourScore,
        submittedRounds: Array.from(yourSubs)
      })
    })


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
      onlineUsers.set(socket.id, {
        socketId: socket.id,
        userId, username, guest,
        duelvictories: wins
      })
      broadcastOnlineUsers()
    })


    // 2) invite
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


    // 3) accept-invite → start duel
    socket.on('accept-invite', async ({ inviterSocketId }) => {
      // pick 5 distinct flags
      const allCodes = flags.map(f => f.code)
      for (let i = allCodes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[allCodes[i], allCodes[j]] = [allCodes[j], allCodes[i]]
      }
      const codes = allCodes.slice(0, 5)

      // new session
      const sessionId = uuidv4()
      sessionFlags.set(sessionId, codes)
      await db.query(
        `INSERT INTO sessions (id, flag_code, flag_codes, started_at)
         VALUES ($1, $2, $3, NOW())`,
        [sessionId, codes[0], JSON.stringify(codes)]
      )
      sessionScores.set(sessionId, new Map())
      sessionSubs.set(sessionId,   new Map())

      // join both
      socket.join(sessionId)
      const inviter = io.sockets.sockets.get(inviterSocketId)
      if (inviter) inviter.join(sessionId)

      // notify start
      io.to(sessionId).emit('start-duel', { sessionId })

      // authoritative timer
      if (sessionIntervals.has(sessionId)) {
        clearInterval(sessionIntervals.get(sessionId))
      }
      const startTs = Date.now()
      sessionStartTimes.set(sessionId, startTs)
      const iv = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTs) / 1000)
        const perRound   = ROUND_DURATION / 1000
        const clamped    = Math.min(elapsedSec, perRound * 5)
        const idx        = Math.floor(clamped / perRound)
        const roundNum   = idx + 1
        const secInto    = clamped % perRound
        const timeLeft   = Math.max(perRound - secInto, 0)
        io.to(sessionId).emit('timer', { round: roundNum, timeLeft })
        if (elapsedSec >= perRound * 5) {
          clearInterval(iv)
          sessionIntervals.delete(sessionId)
        }
      }, 1000)
      sessionIntervals.set(sessionId, iv)

      // schedule game-over
      setTimeout(() => {
        const scoresMap = sessionScores.get(sessionId) || new Map()
        const members   = Array.from(io.sockets.adapter.rooms.get(sessionId) || [])
        if (members.length < 2) return

        members.forEach(sockId => {
          const cid     = socketToClient.get(sockId)
          const score   = scoresMap.get(cid) || 0
          const oppId   = members.find(x => x !== sockId)
          const oppCid  = socketToClient.get(oppId)
          const oppScore= scoresMap.get(oppCid) || 0
          const user    = onlineUsers.get(sockId) || { username: 'You' }
          const oppUser = onlineUsers.get(oppId)  || { username: 'Opponent' }

          io.to(sockId).emit('game-over', {
            you:      { name: user.username,    score },
            opponent: { name: oppUser.username, score: oppScore }
          })
        })

        // cleanup
        clearInterval(sessionIntervals.get(sessionId))
        sessionIntervals.delete(sessionId)
        sessionStartTimes.delete(sessionId)
        sessionScores.delete(sessionId)
        sessionSubs.delete(sessionId)
        sessionFlags.delete(sessionId)
        sessionHintUsage.delete(sessionId)
      }, ROUND_DURATION * 5 + 500)
    })


    // 4) handle hint‑requests
    socket.on('use-hint', ({ sessionId, round }) => {
      const codes = sessionFlags.get(sessionId) || []
      const idx   = round - 1
      if (idx < 0 || idx >= codes.length) {
        return socket.emit('hint-selected', { error: 'Invalid round' })
      }
      const code = codes[idx]
      const meta = flags.find(f => f.code === code) || {}
      const raw  = meta.hints || {}
      const all  = []
      if (raw.population)     all.push(`Population: ${raw.population}`)
      if (raw.last_letter)    all.push(`Last letter: ${raw.last_letter}`)
      if (raw.word_count != null) all.push(`Word count: ${raw.word_count}`)
      if (raw.capital)        all.push(`Capital: ${raw.capital}`)
      if (raw.word_size)      all.push(`Word size: ${raw.word_size}`)

      let per = sessionHintUsage.get(sessionId)
      if (!per) {
        per = new Map()
        sessionHintUsage.set(sessionId, per)
      }
      const clientId = socketToClient.get(socket.id)
      let usage = per.get(clientId)
      if (!usage || usage.round !== round) {
        usage = { round, used: [] }
        per.set(clientId, usage)
      }
      if (usage.used.length >= 3) {
        return socket.emit('hint-selected', { error: 'No hints left' })
      }

      const avail = all.filter(h => !usage.used.includes(h))
      if (!avail.length) {
        return socket.emit('hint-selected', { error: 'No hints left' })
      }
      const pick = avail[Math.floor(Math.random() * avail.length)]
      usage.used.push(pick)

      socket.emit('hint-selected', {
        hint:      pick,
        usedCount: usage.used.length
      })
    })


    // 5) handle guess submissions
    // handle guess submissions
    socket.on('submit-guess', ({ sessionId, guess, hintsUsed, timeLeft, round }) => {
      const scoresMap = sessionScores.get(sessionId)
      if (!scoresMap) return

      // calculate hint‑penalty
      const penalties   = [150, 300, 750]
      const count       = Math.min(Number(hintsUsed) || 0, penalties.length)
      const hintPenalty = penalties.slice(0, count).reduce((s, p) => s + p, 0)

      // base and time‑fraction
      const base = Math.max(1500 - hintPenalty, 0)
      const pts  = Math.floor(base * (timeLeft / (ROUND_DURATION/1000)))

      // update score
      const clientId = socketToClient.get(socket.id)
      const prev     = scoresMap.get(clientId) || 0
      scoresMap.set(clientId, prev + pts)

      // track that this client has submitted this round
      const subsMap = sessionSubs.get(sessionId)
      if (subsMap) {
        let subs = subsMap.get(clientId)
        if (!subs) {
          subs = new Set()
          subsMap.set(clientId, subs)
        }
        subs.add(round)                // ← now `round` is defined
      }

      socket.emit('score-update', {
        socketId:   socket.id,
        totalScore: scoresMap.get(clientId)
      })
    })

    // 6) cleanup
    socket.on('disconnect', () => {
      onlineUsers.delete(socket.id)
      socketToClient.delete(socket.id)
      broadcastOnlineUsers()
    })
  })
}

function broadcastOnlineUsers() {
  io.emit('online-users', Array.from(onlineUsers.values()))
}

module.exports = { initSocket }
