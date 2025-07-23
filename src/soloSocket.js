// src/soloSocket.js
const { v4: uuidv4 } = require('uuid');
const { flagsByCode, flags } = require('./game');

const SOLO_DURATION = 180 * 1000;

const soloSessions  = new Map(); // sessionId -> { clientId, startedAt, idx, codes[], score, correct:Set, skipped:Set }
const soloIntervals = new Map(); // sessionId -> intervalId
const socketToSolo  = new Map(); // socketId  -> sessionId
const clientToSolo  = new Map(); // clientId  -> sessionId

module.exports.registerSoloHandlers = function registerSoloHandlers(io) {

  io.on('connection', socket => {

    socket.on('solo-start', ({ clientId }) => {
      // If client already has a solo session in progress, reuse
      let sessionId = clientToSolo.get(clientId);
      if (sessionId && soloSessions.has(sessionId)) {
        socket.emit('solo-started', { sessionId });
        return;
      }

      // build a shuffled list of flag codes (all, or subset)
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

    socket.on('join-solo', ({ sessionId, clientId }) => {
      const sess = soloSessions.get(sessionId);
      if (!sess || sess.clientId !== clientId) return;

      socket.join(sessionId);
      socketToSolo.set(socket.id, sessionId);

      const timeLeft = Math.max(0, Math.floor((SOLO_DURATION - (Date.now() - sess.startedAt)) / 1000));
      socket.emit('solo-rehydrate', {
        timeLeft,
        idx: sess.idx,
        score: sess.score
      });
      emitCurrentFlag(sessionId, socket);
    });

    socket.on('solo-submit', ({ sessionId, guess }) => {
      const sess = soloSessions.get(sessionId);
      if (!sess) return;

      const code = sess.codes[sess.idx];
      const meta = flagsByCode.get(code);
      if (!meta) return;

      const norm = guess.trim().toLowerCase();
      const correct = meta.answers.some(a => a.toLowerCase() === norm);

      if (!correct) return socket.emit('solo-wrong');

      // TODO: scoring later; placeholder 1 point
      sess.correct.add(sess.idx);
      sess.score += 1;

      // next flag
      sess.idx += 1;
      socket.emit('solo-correct');
      emitCurrentFlag(sessionId, io.to(sessionId));
    });

    socket.on('solo-skip', ({ sessionId }) => {
      const sess = soloSessions.get(sessionId);
      if (!sess) return;
      sess.skipped.add(sess.idx);
      sess.idx += 1;
      socket.emit('solo-skipped');
      emitCurrentFlag(sessionId, io.to(sessionId));
    });

    socket.on('disconnect', () => {
      // optional: grace timer like duel, or ignore
      const sessionId = socketToSolo.get(socket.id);
      if (sessionId) socketToSolo.delete(socket.id);
    });
  });
};

function emitCurrentFlag(sessionId, emitter) {
  const sess = soloSessions.get(sessionId);
  if (!sess) return;
  const code = sess.codes[sess.idx];
  if (!code) return; // ran out of flags (could end or reshuffle)
  const meta = flagsByCode.get(code);
  emitter.emit('solo-flag', {
    idx: sess.idx,
    flag: { code: meta.code, imagePath: meta.imagePath }
  });
}

function startTimer(sessionId, io) {
  const sess = soloSessions.get(sessionId);
  if (!sess) return;

  const iv = setInterval(() => {
    const left = SOLO_DURATION - (Date.now() - sess.startedAt);
    const timeLeft = Math.max(Math.floor(left / 1000), 0);
    io.to(sessionId).emit('solo-timer', { timeLeft });
    if (timeLeft <= 0) {
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
    score: sess.score,
    correctCount: sess.correct.size,
    skippedCount: sess.skipped.size
  });

  clearInterval(soloIntervals.get(sessionId));
  soloIntervals.delete(sessionId);
  soloSessions.delete(sessionId);
}
