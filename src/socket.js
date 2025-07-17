const { Server }   = require('socket.io')
const { v4: uuidv4 } = require('uuid')
const db            = require('./db')
const { flags, getRandomFlag } = require('./game')

const ROUND_DURATION = 25 * 1000 // milliseconds
// track which 5 flags each session uses
const sessionFlags     = new Map() // sessionId → [code0, code1, …code4]
// track hint‑usage per round
const sessionHintUsage = new Map() // sessionId → Map<socketId, { round: n, used: [hint…] }>
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
      sessionFlags.set(sessionId, codes)
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

    // handle hint‐requests from clients
    socket.on('use-hint', ({ sessionId, round }) => {
      // 1) grab your 5‐flags array:
      const codes = sessionFlags.get(sessionId) || [];
      const idx   = round - 1;
      if (idx < 0 || idx >= codes.length) {
        return socket.emit('hint‑selected', { error: 'Invalid round' });
      }

      // 2) find that flag’s metadata
      const code = codes[idx];
      const meta = flags.find(f => f.code === code) || {};

      // 3) convert the meta.hints object into an array of strings:
      const raw = meta.hints || {};
      const allHints = [];
      if (raw.population)     allHints.push(`Population: ${raw.population}`);
      if (raw.last_letter)    allHints.push(`Last letter: ${raw.last_letter}`);
      if (raw.word_count != null) allHints.push(`Word count: ${raw.word_count}`);
      if (raw.capital)        allHints.push(`Capital: ${raw.capital}`);
      if (raw.word_size)      allHints.push(`Word size: ${raw.word_size}`);

      // 4) per‑session usage map (socketId → { round, used[] })
      let perSession = sessionHintUsage.get(sessionId);
      if (!perSession) {
        perSession = new Map();
        sessionHintUsage.set(sessionId, perSession);
      }

      // 5) get or reset *this player*’s usage for *this* round
      let usage = perSession.get(socket.id);
      if (!usage || usage.round !== round) {
        usage = { round, used: [] };
        perSession.set(socket.id, usage);
      }

      // 6) enforce max 3 hints
      if (usage.used.length >= 3) {
        return socket.emit('hint-selected', { error: 'No hints left' });
      }

      // 7) pick a random unused hint
      const avail = allHints.filter(h => !usage.used.includes(h));
      if (!avail.length) {
        return socket.emit('hint-selected', { error: 'No hints left' });
      }
      const pick = avail[Math.floor(Math.random() * avail.length)];
      usage.used.push(pick);

      // 8) send it back
      socket.emit('hint-selected', {
        hint:      pick,
        usedCount: usage.used.length
      });
    });

    // handle guess submission
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
