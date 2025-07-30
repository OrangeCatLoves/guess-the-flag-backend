// src/duelSocket.js
const { v4: uuidv4 }   = require('uuid')
const db               = require('./db')
const { flags }        = require('./game')

// how long each round lasts
const ROUND_DURATION   = 25 * 1000 // ms per round

// In‑memory stores
const sessionFlags       = new Map() // sessionId → [flagCodes]
const sessionHintUsage   = new Map() // sessionId → Map<clientId,{ round, used:[] }>
const sessionScores      = new Map() // sessionId → Map<clientId,score>
const sessionSubs        = new Map() // sessionId → Map<clientId,Set<round>>
const sessionStartTimes  = new Map() // sessionId → timestamp
const sessionIntervals   = new Map() // sessionId → interval ID
const onlineUsers        = new Map() // socketId → user info
const socketToClient     = new Map() // socketId → clientId
const socketSession      = new Map() // socketId → sessionId
const pendingDisconnects = new Map() // clientId → timeoutId

function registerDuelHandlers(io) {
  // helper inside closure so `io` is in scope
  function broadcastOnlineUsers() {
    io.emit('online-users', Array.from(onlineUsers.values()))
  }

  io.on('connection', socket => {
    console.log(`✅ User connected: ${socket.id}`)

    // 0) Re‑join + rehydrate on refresh
    socket.on('join-session', ({ sessionId, clientId }) => {
      if (!sessionFlags.has(sessionId)) return

      socket.join(sessionId)
      socketToClient.set(socket.id, clientId)
      socketSession.set(socket.id, sessionId)

      // cancel any pending “opponent-left”
      const t = pendingDisconnects.get(clientId)
      if (t) {
        clearTimeout(t)
        pendingDisconnects.delete(clientId)
      }

      // emit the current timer for this round
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
        const code = sessionFlags.get(sessionId)[idx]
        const meta = flags.find(f => f.code === code)
        const perHints = sessionHintUsage.get(sessionId)
        if (perHints) {
          // 1) if no usage for this user *or* it’s from a previous round, reset it now
          let usage = perHints.get(clientId)
          if (!usage || usage.round !== roundNum) {
            usage = { round: roundNum, revealed: new Set(), count: 0 }
            perHints.set(clientId, usage)
          }

          // 2) now re‑emit *any* letters already revealed this round
          if (usage.revealed.size > 0) {
            const name    = meta.code.replace(/-/g,' ')
            const letters = name.split('')
            const mask    = letters.map((c,i) =>
              usage.revealed.has(i)
                ? c.toUpperCase()
                : (/[A-Za-z]/.test(c) ? '_' : c)
            ).join('')
            socket.emit('hint-updated', {
              mask,
              used: usage.count
            })
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

      // join both players
      socket.join(sessionId)
      socketSession.set(socket.id, sessionId)
      const inviter = io.sockets.sockets.get(inviterSocketId)
      if (inviter) {
        inviter.join(sessionId)
        socketSession.set(inviterSocketId, sessionId)
      }

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

        // STOP before emitting if we've completed all 5 rounds
        if (elapsedSec >= perRound * 5) {
          clearInterval(iv)
          sessionIntervals.delete(sessionId)
          return
        }
        // otherwise compute current round & remaining seconds
        const idx      = Math.floor(elapsedSec / perRound)      // 0–4
        const roundNum = idx + 1
        const secInto  = elapsedSec % perRound
        const timeLeft = perRound - secInto
        io.to(sessionId).emit('timer', { round: roundNum, timeLeft })
      }, 1000)
      sessionIntervals.set(sessionId, iv)

      // schedule game-over
      // schedule game‑over
      setTimeout(() => {
        (async () => {
          try {
            const scoresMap = sessionScores.get(sessionId) || new Map()
            const players   = Array.from(io.sockets.adapter.rooms.get(sessionId) || [])
            if (players.length < 2) return

            const [sockA, sockB] = players
            const cidA   = socketToClient.get(sockA)
            const cidB   = socketToClient.get(sockB)
            const scoreA = scoresMap.get(cidA) || 0
            const scoreB = scoresMap.get(cidB) || 0

            const userA = onlineUsers.get(sockA) || {}
            const userB = onlineUsers.get(sockB) || {}

            // 1) emit game‑over to both
            io.to(sockA).emit('game-over', {
              you:      { name: userA.username, score: scoreA },
              opponent: { name: userB.username, score: scoreB }
            })
            io.to(sockB).emit('game-over', {
              you:      { name: userB.username, score: scoreB },
              opponent: { name: userA.username, score: scoreA }
            })

            // — DEBUG: print out final tallies
            console.log(
              `[DUEL] Final scores for session ${sessionId}: ` +
              `${userA.username}=${scoreA}, ${userB.username}=${scoreB}`
            )

            // 2) pick winner + bump tally only for signed users
            if (scoreA > scoreB) {
              console.log(`[DUEL] ${userA.username} (id=${userA.userId}) won`)
              const uidA = parseInt(userA.userId, 10)
              if (!userA.guest && Number.isInteger(uidA)) {
                await db.query(
                  `UPDATE users
                      SET duelvictories = duelvictories + 1
                    WHERE id = $1`,
                  [uidA]
                )
              } else {
                console.log(`[DUEL] skipping DB update for guest/invalid-id`)
              }
            } else if (scoreB > scoreA) {
              console.log(`[DUEL] ${userB.username} (id=${userB.userId}) won`)
              const uidB = parseInt(userB.userId, 10)
              if (!userB.guest && Number.isInteger(uidB)) {
                await db.query(
                  `UPDATE users
                      SET duelvictories = duelvictories + 1
                    WHERE id = $1`,
                  [uidB]
                )
              } else {
                console.log(`[DUEL] skipping DB update for guest/invalid-id`)
              }
            } else {
              console.log(`[DUEL] Tie: no update`)
            }

          } catch (err) {
            console.error('[DUEL] game-over error for session', sessionId, err)
          } finally {
            // 3) cleanup in‑memory
            clearInterval(sessionIntervals.get(sessionId))
            sessionIntervals.delete(sessionId)
            sessionStartTimes.delete(sessionId)
            sessionScores.delete(sessionId)
            sessionSubs.delete(sessionId)
            sessionFlags.delete(sessionId)
            sessionHintUsage.delete(sessionId)
          }
        })()
      }, ROUND_DURATION * 5 + 500)

    })

    // 4) handle hint‑requests
    socket.on('use-hint', ({ sessionId, round }) => {
      const codes   = sessionFlags.get(sessionId) || [];
      const idx     = round - 1;
      const code    = codes[idx];
      if (!code) return socket.emit('hint-error', 'Invalid round');

      //––– track per‑user, per‑round revealed positions + click count
      let per = sessionHintUsage.get(sessionId);
      if (!per) {
        per = new Map();
        sessionHintUsage.set(sessionId, per);
      }
      const clientId = socketToClient.get(socket.id);
      let usage = per.get(clientId);
      if (!usage || usage.round !== round) {
        // start fresh for this round
        usage = { round, revealed: new Set(), count: 0 };
        per.set(clientId, usage);
      }

      // refuse if they've already clicked 3 times
      if (usage.count >= 3) {
        return socket.emit('hint-error', 'No more hints');
      }

      // record this click
      usage.count++;

      // build the “name” we’re revealing letters of:
      const name        = code.replace(/-/g, ' ');
      const letters     = name.split('');
      const letterCount = letters.filter(c => /[A-Za-z]/.test(c)).length;

      // decide how many letters to reveal per click
      let toReveal;
      if (letterCount > 20)      toReveal = 3;
      else if (letterCount > 10) toReveal = 2;
      else                       toReveal = 1;

      // pick random unrevealed letter positions
      const available = letters
        .map((c,i) => i)
        .filter(i => /[A-Za-z]/.test(letters[i]) && !usage.revealed.has(i));
      if (available.length === 0) {
        return socket.emit('hint-error', 'No more letters');
      }

      // clamp reveal count
      const pickCount = Math.min(toReveal, available.length);
      for (let j = 0; j < pickCount; j++) {
        const choice = available.splice(
          Math.floor(Math.random()*available.length), 1
        )[0];
        usage.revealed.add(choice);
      }

      // build masked string
      const mask = letters.map((c,i) =>
        usage.revealed.has(i)
          ? c.toUpperCase()
          : (/[A-Za-z]/.test(c) ? '_' : c)
      ).join('');

      // send back: the new mask + how many times they've clicked
      socket.emit('hint-updated', {
        mask,
        used: usage.count
      });
    });


    // 5) handle guess submissions
    socket.on('submit-guess', ({ sessionId, guess, hintsUsed, timeLeft, round }) => {
      const scoresMap = sessionScores.get(sessionId)
      if (!scoresMap) return

      // determine which flag code
      const codes = sessionFlags.get(sessionId) || []
      const idx   = round - 1
      if (idx < 0 || idx >= codes.length) return
      const code = codes[idx]

      // look up our metadata for this flag
      const meta = flags.find(f => f.code === code)
      if (!meta) return

      // — VALIDATION: compare against accepted answers
      const normalized = guess.trim().toLowerCase()
      const correctMatch = Array.isArray(meta.answers)
        && meta.answers.some(a => a.toLowerCase() === normalized)
      if (!correctMatch) {
        // wrong: notify client and bail out
        return socket.emit('incorrect-guess')
      }
      
      // calculate hint‑penalty
      const penalties   = [150,300,750]
      const count       = Math.min(Number(hintsUsed)||0, penalties.length)
      const hintPenalty = penalties.slice(0,count).reduce((s,p)=>s+p,0)

      // base + time fraction
      const base = Math.max(1500 - hintPenalty, 0)
      const pts  = Math.floor(base * (timeLeft / (ROUND_DURATION/1000)))

      // update score
      const clientId = socketToClient.get(socket.id)
      const prev     = scoresMap.get(clientId) || 0
      scoresMap.set(clientId, prev + pts)

      // mark submitted
      const subsMap = sessionSubs.get(sessionId)
      if (subsMap) {
        let subs = subsMap.get(clientId)
        if (!subs) {
          subs = new Set()
          subsMap.set(clientId, subs)
        }
        subs.add(round)
      }

      socket.emit('score-update', {
        socketId:   socket.id,
        totalScore: scoresMap.get(clientId)
      })
      socket.to(sessionId).emit('opponent-correct')
    })

    // 6) cleanup / disconnect
    socket.on('disconnect', () => {
      const clientId  = socketToClient.get(socket.id)
      const sessionId = socketSession.get(socket.id)

      onlineUsers.delete(socket.id)
      socketToClient.delete(socket.id)
      socketSession.delete(socket.id)
      broadcastOnlineUsers()

      if (!sessionId || !clientId) return

      // grace period before firing “opponent-left”
      const GRACE_MS = 3000
      const timeoutId = setTimeout(() => {
        if (pendingDisconnects.has(clientId)) {
          pendingDisconnects.delete(clientId)
          socket.to(sessionId).emit('opponent-left')
        }
      }, GRACE_MS)
      pendingDisconnects.set(clientId, timeoutId)
    })
  })
}

module.exports = { registerDuelHandlers }
