// api.js
const express = require('express');
const router  = express.Router();
const db      = require('./db');
const { flags } = require('./game');
const { getRandomFlag } = require('./game');

router.get('/random-flag', (req, res) => {
  const flag = getRandomFlag();
  res.json(flag);
});


router.get('/session/:id', async (req, res) => {
  const id = req.params.id;
  if (!id || id === 'undefined') {
    return res.status(400).json({ error: 'Session ID is required' });
  }
  if (!/^[0-9a-fA-F\-]{36}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid session ID format' });
  }

  try {
    const { rows } = await db.query(
      `SELECT flag_codes, started_at
         FROM sessions
        WHERE id = $1`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { flag_codes: codes, started_at: startedAt } = rows[0];
    if (!Array.isArray(codes) || codes.length !== 5) {
      return res.status(500).json({ error: 'Bad session flag data' });
    }

    // Now build an array of 5 flag objects, each carrying an array of hint‐strings
    const flagsData = codes.map(code => {
      const meta = flags.find(f => f.code === code) || {};
      const raw = meta.hints || {}; // this was the object from hints.json

      // turn that object into exactly the strings your frontend expects:
      const hintArr = [];
      if (raw.population)    hintArr.push(`Population: ${raw.population}`);
      if (raw.last_letter)   hintArr.push(`Last letter: ${raw.last_letter}`);
      if (raw.word_count != null) hintArr.push(`Word count: ${raw.word_count}`);
      if (raw.capital)       hintArr.push(`Capital: ${raw.capital}`);
      if (raw.word_size)     hintArr.push(`Word size: ${raw.word_size}`);

      return {
        code,
        imagePath: meta.imagePath || '',
        hints: hintArr
      };
    });

    return res.json({
      id,
      startedAt,
      flags: flagsData
    });
  } catch (err) {
    console.error('Session load error:', err);
    return res.status(500).json({ error: 'Could not load session' });
  }
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

router.get('/leaderboard/solo', async (req, res) => {
  const page  = Math.max(parseInt(req.query.page,10)||1,1)
  const limit = 50, offset = (page-1)*limit

  try {
    // 1) total count
    const totalRes = await db.query(`SELECT COUNT(*) FROM users`)
    const total = parseInt(totalRes.rows[0].count, 10)

    // 2) page of entries
    const { rows: entries } = await db.query(
      `SELECT username, bestsoloscore, lastbestsoloscore
         FROM users
        ORDER BY bestsoloscore DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    )

    res.json({ page, total, entries })
  } catch (err) {
    console.error('Solo leaderboard error', err)
    res.status(500).json({ error: 'Could not load solo leaderboard' })
  }
})

// GET /api/leaderboard/duel?page=N
router.get('/leaderboard/duel', async (req, res) => {
  const page  = Math.max(parseInt(req.query.page,10)||1,1)
  const limit = 50, offset = (page-1)*limit

  try {
    const totalRes = await db.query(`SELECT COUNT(*) FROM users`)
    const total = parseInt(totalRes.rows[0].count, 10)

    const { rows: entries } = await db.query(
      `SELECT username, duelvictories
         FROM users
        ORDER BY duelvictories DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    )

    res.json({ page, total, entries })
  } catch (err) {
    console.error('Duel leaderboard error', err)
    res.status(500).json({ error: 'Could not load duel leaderboard' })
  }
})

module.exports = router;
