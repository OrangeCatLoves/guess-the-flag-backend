// src/soloSocket.js
const { v4: uuidv4 } = require('uuid');
const { flags, flagsByCode } = require('./game');

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

module.exports.registerSoloHandlers = function registerSoloHandlers(io) {
  io.on('connection', socket => {

    /**
     * Start a solo session
     */
    socket.on('solo-start', ({ clientId }) => {
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

      sess.skipCount += 1;
      const mult    = skipMultiplier(sess.skipCount);
      const penalty = parseFloat((BASE_POINTS * mult).toFixed(2));

      sess.score  = Math.max(0, parseFloat((sess.score - penalty).toFixed(2)));
      sess.streak = 0;
      sess.skipped.add(sess.idx);

      // LOG skip computation
      console.log(`[SOLO] Skip -> base=${BASE_POINTS}, skipCount=${sess.skipCount}, mult=${mult.toFixed(2)}, penalty=${penalty.toFixed(2)}, total=${sess.score.toFixed(2)}`);

      // next flag
      sess.idx += 1;

      socket.emit('solo-skipped', {
        penalty,
        totalScore: sess.score,
        skipCount: sess.skipCount
      });

      emitCurrentFlag(sessionId, io.to(sessionId));
    });

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

function endSolo(sessionId, io) {
  const sess = soloSessions.get(sessionId);
  if (!sess) return;

  io.to(sessionId).emit('solo-game-over', {
    score:        sess.score,
    correctCount: sess.correct.size,
    skippedCount: sess.skipped.size
  });

  clearInterval(soloIntervals.get(sessionId));
  soloIntervals.delete(sessionId);
  soloSessions.delete(sessionId);
}

function timeLeftSeconds(sess) {
  const elapsed = Date.now() - sess.startedAt;
  return Math.max(0, Math.floor((SOLO_DURATION_MS - elapsed) / 1000));
}
