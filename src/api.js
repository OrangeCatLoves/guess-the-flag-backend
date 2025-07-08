// api.js
const express = require('express');
const router  = express.Router();
const db      = require('./db');
const { flags } = require('./game');

router.get('/session/:id', async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM sessions WHERE id=$1',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });

  const session = rows[0];
  const meta = flags.find(f => f.code === session.flag_code);

  return res.json({
    id: session.id,
    flagCode: session.flag_code,
    imagePath: meta.imagePath,
    hints: meta.hints,
    startedAt: session.started_at,
    // if ended:
    endedAt:   session.ended_at,
    hintsUsed: session.hints_used,
    correct:   session.correct,
    score:     session.score
  });
});

router.post('/session/:id/guess', async (req, res) => {
  const { guess, hintsUsed } = req.body;   // `{ guess: "Afghanistan", hintsUsed: 2 }`
  // 1) load your session
  const { rows } = await db.query(
    'SELECT * FROM sessions WHERE id=$1',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Session not found' });
  const session = rows[0];

  // 2) score it
  const correct = session.flag_code.toLowerCase() === guess.toLowerCase();
  const baseScore = correct ? 100 : 0;        // example: 100 for correct
  const penalty   = hintsUsed * 10;          // −10 per hint
  const score     = Math.max(baseScore - penalty, 0);

  // 3) update DB
  await db.query(
    `UPDATE sessions
     SET ended_at = NOW(),
         hints_used = $1,
         correct    = $2,
         score      = $3
     WHERE id = $4`,
    [hintsUsed, correct, score, req.params.id]
  );

  // 4) bump player total
  if (correct) {
    await db.query(
      `UPDATE players
         SET total_score = total_score + $1
       WHERE discord_id = $2`,
      [score, session.discord_id]
    );
  }

  // 5) respond
  res.json({ correct, score });
});

module.exports = router;
