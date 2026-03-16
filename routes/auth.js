const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db/init');
const { authLimiter } = require('../middleware/rateLimiter');
const router  = express.Router();

// Rate limit auth endpoints (10 attempts per 15 min)
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'Username must be 2-20 characters' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (password.length > 128) return res.status(400).json({ error: 'Password too long' });
    if (!/^[a-zA-Z0-9_\-]+$/.test(username)) return res.status(400).json({ error: 'Username: letters, numbers, _ and - only' });

    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 12);
    const result = await db.run("INSERT INTO users(username,password,role) VALUES(?,?,'member')", [username, hash]);
    const user = await db.get('SELECT id,username,role FROM users WHERE id=?', [result.lastInsertRowid]);
    req.session.regenerate?.(function() {}) || void 0; // Regenerate session ID on login
    req.session.user = user;
    res.json({ user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = await db.get('SELECT * FROM users WHERE username=?', [username]);
    // Constant-time comparison: always run bcrypt even if user not found
    const dummyHash = '$2a$12$000000000000000000000uGhtZ2JXl6dXjI1MdRJpHjR5A0T8Mu2';
    const validPassword = await bcrypt.compare(password, user ? user.password : dummyHash);
    if (!user || !validPassword) return res.status(401).json({ error: 'Invalid username or password' });
    if (user.role === 'banned') return res.status(403).json({ error: 'Your account has been banned' });
    await db.run("UPDATE users SET last_seen=strftime('%s','now') WHERE id=?", [user.id]);
    req.session.regenerate?.(function() {}) || void 0;
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ user: req.session.user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

router.post('/change-password', async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    if (newPassword.length > 128) return res.status(400).json({ error: 'Password too long' });
    const user = await db.get('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    if (!await bcrypt.compare(oldPassword, user.password)) return res.status(401).json({ error: 'Current password is incorrect' });
    await db.run('UPDATE users SET password=? WHERE id=?', [await bcrypt.hash(newPassword, 12), user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
