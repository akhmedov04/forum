const express = require('express');
const db      = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

router.use(requireAuth);

// Get my bookmarks
router.get('/', async (req, res) => {
  try {
    const bookmarks = await db.all(`
      SELECT b.id, b.created_at as bookmarked_at,
        t.id as thread_id, t.title, t.views, t.created_at, t.locked, t.pinned,
        u.username as author, c.slug as cat_slug, c.name as cat_name,
        c.name_ru as cat_name_ru, c.name_uz as cat_name_uz,
        (SELECT COUNT(*) FROM posts WHERE thread_id=t.id) as reply_count
      FROM bookmarks b
      JOIN threads t ON t.id=b.thread_id
      JOIN users u ON u.id=t.user_id
      JOIN categories c ON c.id=t.cat_id
      WHERE b.user_id=?
      ORDER BY b.created_at DESC`, [req.session.user.id]);
    res.json(bookmarks);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Toggle bookmark
router.post('/toggle', async (req, res) => {
  try {
    const { thread_id } = req.body;
    if (!thread_id) return res.status(400).json({ error: 'thread_id required' });
    const thread = await db.get('SELECT id FROM threads WHERE id=?', [thread_id]);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const existing = await db.get('SELECT id FROM bookmarks WHERE user_id=? AND thread_id=?',
      [req.session.user.id, thread_id]);

    if (existing) {
      await db.run('DELETE FROM bookmarks WHERE id=?', [existing.id]);
      res.json({ bookmarked: false });
    } else {
      await db.run('INSERT INTO bookmarks(user_id, thread_id) VALUES(?,?)',
        [req.session.user.id, thread_id]);
      res.json({ bookmarked: true });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Check if bookmarked
router.get('/check/:thread_id', async (req, res) => {
  try {
    const existing = await db.get('SELECT id FROM bookmarks WHERE user_id=? AND thread_id=?',
      [req.session.user.id, req.params.thread_id]);
    res.json({ bookmarked: !!existing });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
