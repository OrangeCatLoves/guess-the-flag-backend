// src/auth.js
const express = require('express')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const db = require('./db')
const rateLimit = require('express-rate-limit');

const router = express.Router()
const JWT_SECRET = process.env.JWT_SECRET || 'please_set_a_real_secret'

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                  // limit each IP to 10 requests per windowMs
  message: { error: 'Too many login attempts, please try again later.' },
  standardHeaders: true,    // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false      // Disable the `X-RateLimit-*` headers
});

// — POST /auth/register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email + password required' })
  }
  const hash = await bcrypt.hash(password, 10)
  try {
    await db.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)',
      [username, email, hash]
    )
    res.status(201).json({ message: 'Account created' })
  } catch (err) {
    // handle unique‐violation from Postgres
    if (err.code === '23505') {
      // which constraint?
      if (err.constraint === 'users_email_key') {
        return res.status(409).json({ error: 'That email is already registered.' })
      }
      if (err.constraint === 'users_username_key') {
        return res.status(409).json({ error: 'That username is already taken.' })
      }
    }
    console.error('Registration error:', err);
    res.status(400).json({ error: 'Registration failed: ' + err.message });
  }
})

// — POST /auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { identifier, password } = req.body
  const { rows } = await db.query(
    'SELECT id, username, email, password_hash FROM users WHERE username=$1 OR email=$1',
    [identifier]
  )
  if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' })

  const user = rows[0]
  const match = await bcrypt.compare(password, user.password_hash)
  if (!match) return res.status(401).json({ error: 'Invalid credentials' })

  const payload = { userId: user.id, username: user.username, guest: false }
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn:'7d' })
  res.json({ token, displayName: user.username, userId: user.id, email: user.email })
})

// — POST /auth/guest
router.post('/guest', (req, res) => {
  // generate a random 6-digit guest name
  const guestName = 'Guest#' + String(Math.floor(100000 + Math.random()*900000))
  const payload   = { guest: true, username: guestName }
  const token     = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' })
  res.json({ token, displayName: guestName })
})

// — POST /auth/change-password
router.post('/change-password', async (req, res) => {
  const auth = req.headers.authorization?.split(' ')[1];
  if (!auth) return res.status(401).end();

  let payload;
  try {
    payload = jwt.verify(auth, JWT_SECRET);
  } catch {
    return res.status(401).end();
  }

  const { identifier, oldPassword, newPassword } = req.body;
  if (!identifier || !oldPassword || !newPassword) {
    return res.status(400).json({ error: 'identifier, oldPassword, and newPassword required' });
  }

  // fetch user by identifier and check it matches JWT
  const { rows } = await db.query(
    'SELECT id, password_hash FROM users WHERE (username=$1 OR email=$1) AND id=$2',
    [identifier, payload.userId]
  );
  if (!rows.length) {
    return res.status(404).json({ error: 'User not found or not authorized' });
  }

  const ok = await bcrypt.compare(oldPassword, rows[0].password_hash);
  if (!ok) {
    return res.status(400).json({ error: 'Old password incorrect' });
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  await db.query(
    'UPDATE users SET password_hash=$1 WHERE id=$2',
    [newHash, payload.userId]
  );

  res.json({ message: 'Password changed' });
});

module.exports = router;
