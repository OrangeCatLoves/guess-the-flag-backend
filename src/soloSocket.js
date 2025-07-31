// src/soloSocket.js
const { v4: uuidv4 } = require('uuid');
const { flags, flagsByCode } = require('./game');
const db = require('./db');

/**
 * SOLO MODE CONFIG
 */
const SOLO_DURATION_MS = 180 * 1000; // 180 seconds total game time (change if you want)

/** Scoring (streak only) */
const BASE_POINTS = 500; // base points per correct answer

// Streak multiplier: 1.0, 1.1, 1.2 ... cap 2.0
function streakMultiplier(streakCount) {
  return Math.min(1 + 0.1 * (streakCount - 1), 2.0);
}

// Skip penalties: 0.5, 0.75, 1.0, 1.25, ... cap 2.0
const SKIP_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
function skipMultiplier(skipCount) {
  return SKIP_STEPS[Math.min(skipCount - 1, SKIP_STEPS.length - 1)];
}

/**
 * In-memory stores
 */
const soloSessions  = new Map(); // sessionId -> sessionState
const soloIntervals = new Map(); // sessionId -> intervalId
const socketToSolo  = new Map(); // socketId  -> sessionId
const clientToSolo  = new Map(); // clientId  -> sessionId
const soloHintUsage = new Map(); // sessionId → Map<clientId,{ round, revealed:Set, count }>

module.exports.registerSoloHandlers = function registerSoloHandlers(io) {
  io.on('connection', socket => {

    /**
     * Start a solo session
     */
    socket.on('solo-start', ({ clientId, userId }) => {
      let sessionId = clientToSolo.get(clientId);
      if (sessionId && soloSessions.has(sessionId)) {
        socket.emit('solo-started', { sessionId });
        return;
      }

      // shuffle all flags
      const codes = flags.map(f => f.code);
      for (let i = codes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [codes[i], codes[j]] = [codes[j], codes[i]];
      }

      sessionId = uuidv4();
      const startedAt = Date.now();

      soloSessions.set(sessionId, {
        clientId,
        userId,
        startedAt,
        idx: 0,
        codes,
        score: 0,
        streak: 0,
        skipCount: 0,
        correct: new Set(),
        skipped: new Set()
      });

      clientToSolo.set(clientId, sessionId);
      socketToSolo.set(socket.id, sessionId);
      socket.join(sessionId);

      startTimer(sessionId, io);
      socket.emit('solo-started', { sessionId });
      emitCurrentFlag(sessionId, socket);
    });

    /**
     * Re-join after refresh
     */
    socket.on('join-solo', ({ sessionId, clientId }) => {
      const sess = soloSessions.get(sessionId);
      if (!sess || sess.clientId !== clientId) return;

      socket.join(sessionId);
      socketToSolo.set(socket.id, sessionId);

      socket.emit('solo-rehydrate', {
        timeLeft: timeLeftSeconds(sess),
        idx:      sess.idx,
        score:    sess.score
      });

      emitCurrentFlag(sessionId, socket);
      // rehydrate any letters already revealed this round
      const usageMap = soloHintUsage.get(sessionId)
      if (usageMap) {
        const usage = usageMap.get(sess.clientId)
        if (usage && usage.round === sess.idx) {
          // rebuild mask
          const name    = sess.codes[sess.idx].replace(/-/g,' ')
          const letters = name.split('')
          const mask    = letters.map((c,i) =>
            usage.revealed.has(i)
              ? c.toUpperCase()
              : (/[A-Za-z]/.test(c) ? '_' : c)
          ).join('')
          socket.emit('solo-hint', {
            mask,
            used: usage.count
          })
        }
      }
    });

    /**
     * Submit guess
     */
    socket.on('solo-submit', ({ sessionId, guess }) => {
      const sess = soloSessions.get(sessionId);
      if (!sess) return;

      const code = sess.codes[sess.idx];
      const meta = flagsByCode.get(code);
      if (!meta) return;

      const norm     = guess.trim().toLowerCase();
      const isCorrect = meta.answers.some(a => a.toLowerCase() === norm);

      if (!isCorrect) {
        // wrong answer -> streak resets, no points
        sess.streak = 0;
        return socket.emit('solo-wrong');
      }

      // correct answer
      sess.streak += 1;
      const mult   = streakMultiplier(sess.streak);
      const points = parseFloat((BASE_POINTS * mult).toFixed(2));
      sess.score   = parseFloat((sess.score + points).toFixed(2));
      sess.correct.add(sess.idx);

      // LOG how we computed score
      console.log(`[SOLO] Correct guess -> base=${BASE_POINTS}, streak=${sess.streak}, mult=${mult.toFixed(2)}, points=${points.toFixed(2)}, total=${sess.score.toFixed(2)}`);

      // next flag
      sess.idx += 1;

      socket.emit('solo-correct', {
        points,
        totalScore: sess.score,
        streak: sess.streak
      });

      emitCurrentFlag(sessionId, io.to(sessionId));
    });

    /**
     * Skip flag
     */
    socket.on('solo-skip', ({ sessionId }) => {
      const sess = soloSessions.get(sessionId);
      if (!sess) return;

      // --- grab the code & meta of the flag they are skipping, BEFORE advancing sess.idx ---
      const code = sess.codes[sess.idx];
      const meta = flagsByCode.get(code);

      sess.skipCount += 1;
      const mult    = skipMultiplier(sess.skipCount);
      const penalty = parseFloat((BASE_POINTS * mult).toFixed(2));

      sess.score  = Math.max(0, parseFloat((sess.score - penalty).toFixed(2)));
      sess.streak = 0;
      sess.skipped.add(sess.idx);

      // LOG skip computation
      console.log(`[SOLO] Skip -> base=${BASE_POINTS}, skipCount=${sess.skipCount}, mult=${mult.toFixed(2)}, penalty=${penalty.toFixed(2)}, total=${sess.score.toFixed(2)}`);

      socket.emit('solo-skipped', {
        penalty,
        totalScore: sess.score,
        skipCount: sess.skipCount,
        answer: (meta.answers && meta.answers[0]) || code.replace(/-/g,' ')
      });
      
      // next flag
      sess.idx += 1;
      emitCurrentFlag(sessionId, io.to(sessionId));
    });

        // 7) handle hint‑requests for Solo
    socket.on('solo-use-hint', ({ sessionId, clientId }) => {
      const sess = soloSessions.get(sessionId)
      if (!sess || sess.clientId !== clientId) return

      // per-session / per-user usage map
      let per = soloHintUsage.get(sessionId)
      if (!per) {
        per = new Map()
        soloHintUsage.set(sessionId, per)
      }

      // fresh usage for this round?
      let usage = per.get(clientId)
      if (!usage || usage.round !== sess.idx) {
        usage = { round: sess.idx, revealed: new Set(), count: 0 }
        per.set(clientId, usage)
      }

      // cap at 3 clicks
      if (usage.count >= 3) {
        return socket.emit('solo-hint-error', 'No more hints')
      }
      usage.count++

      // decide how many letters to reveal
      const name        = sess.codes[sess.idx].replace(/-/g,' ')
      const letters     = name.split('')
      const letterCount = letters.filter(c=>/[A-Za-z]/.test(c)).length
      let toReveal
      if (letterCount > 20)      toReveal = 3
      else if (letterCount > 10) toReveal = 2
      else                       toReveal = 1

      // pick random unrevealed positions
      const available = letters
        .map((c,i) => i)
        .filter(i => /[A-Za-z]/.test(letters[i]) && !usage.revealed.has(i))
      const pick = Math.min(toReveal, available.length)
      for (let j = 0; j < pick; j++) {
        const idx = available.splice(Math.floor(Math.random()*available.length),1)[0]
        usage.revealed.add(idx)
      }

      // rebuild the mask
      const mask = letters.map((c,i) =>
        usage.revealed.has(i)
          ? c.toUpperCase()
          : (/[A-Za-z]/.test(c) ? '_' : c)
      ).join('')

      // apply the penalty: 50, 100, 200
      const penalties = [50,100,200]
      const pen = penalties[usage.count - 1] || 0
      sess.score = Math.max(0, +((sess.score - pen).toFixed(2)))

      // send back to client
      socket.emit('solo-hint', {
        mask,
        used:       usage.count,
        penalty:    pen,
        totalScore: sess.score
      })
    })


    socket.on('disconnect', () => {
      const sessionId = socketToSolo.get(socket.id);
      if (sessionId) socketToSolo.delete(socket.id);
    });
  });
};

/**
 * Helpers
 */
function emitCurrentFlag(sessionId, emitter) {
  const sess = soloSessions.get(sessionId);
  if (!sess) return;

  // if ran out, wrap (or end if you prefer)
  if (sess.idx >= sess.codes.length) {
    sess.idx = 0;
  }

  const code = sess.codes[sess.idx];
  const meta = flagsByCode.get(code);
  if (!meta) return;

  emitter.emit('solo-flag', {
    idx:  sess.idx,
    flag: { code: meta.code, imagePath: meta.imagePath }
  });
}

function startTimer(sessionId, io) {
  const sess = soloSessions.get(sessionId);
  if (!sess) return;

  const iv = setInterval(() => {
    const left = timeLeftSeconds(sess);
    io.to(sessionId).emit('solo-timer', { timeLeft: left });
    if (left <= 0) {
      clearInterval(iv);
      soloIntervals.delete(sessionId);
      endSolo(sessionId, io);
    }
  }, 1000);

  soloIntervals.set(sessionId, iv);
}

async function endSolo(sessionId, io) {
  const sess = soloSessions.get(sessionId);
  if (!sess) return;

  io.to(sessionId).emit('solo-game-over', {
    score:        sess.score,
    correctCount: sess.correct.size,
    skippedCount: sess.skipped.size
  });

  // 3b) update Postgres for signed‑in user
  // only update for real signed‑in users
  const uid = parseInt(sess.userId, 10)
  if (!isNaN(uid)) {
    try {
      await db.query(
        `UPDATE users
            SET lastbestsoloscore = $1,
                bestsoloscore     = GREATEST(bestsoloscore, $1)
          WHERE id = $2`,
        [sess.score, uid]
      )
    } catch (err) {
      console.error('Failed to update solo scores for user', sess.userId, err)
    }
  }

  clearInterval(soloIntervals.get(sessionId));
  soloIntervals.delete(sessionId);
  soloHintUsage.delete(sessionId)
  soloSessions.delete(sessionId);
}

function timeLeftSeconds(sess) {
  const elapsed = Date.now() - sess.startedAt;
  return Math.max(0, Math.floor((SOLO_DURATION_MS - elapsed) / 1000));
}
