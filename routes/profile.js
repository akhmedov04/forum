const express = require('express');
const db      = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

// Get user profile by username
router.get('/:username', async (req, res) => {
  try {
    const user = await db.get(
      `SELECT id, username, role, bio, avatar_url, reputation, created_at, last_seen FROM users WHERE username = ? COLLATE NOCASE`,
      [req.params.username]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });

    const threadCount = (await db.get('SELECT COUNT(*) as n FROM threads WHERE user_id=?', [user.id])).n;
    const postCount   = (await db.get('SELECT COUNT(*) as n FROM posts WHERE user_id=?', [user.id])).n;

    const recentThreads = await db.all(`
      SELECT t.id, t.title, t.views, t.created_at, c.slug as cat_slug, c.name as cat_name,
        (SELECT COUNT(*) FROM posts WHERE thread_id=t.id) as reply_count
      FROM threads t JOIN categories c ON c.id=t.cat_id
      WHERE t.user_id=? ORDER BY t.created_at DESC LIMIT 10`, [user.id]);

    const recentPosts = await db.all(`
      SELECT p.id, p.body, p.created_at, t.id as thread_id, t.title as thread_title
      FROM posts p JOIN threads t ON t.id=p.thread_id
      WHERE p.user_id=? ORDER BY p.created_at DESC LIMIT 10`, [user.id]);

    const rank = getRepRank(user.reputation);
    res.json({ ...user, thread_count: threadCount, post_count: postCount, rank, recentThreads, recentPosts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update own profile
router.put('/me/update', requireAuth, async (req, res) => {
  try {
    const { bio, avatar_url } = req.body;
    const cleanBio = (bio || '').slice(0, 500);
    const cleanAvatar = (avatar_url || '').slice(0, 500);
    if (cleanAvatar && !cleanAvatar.startsWith('/uploads/')) {
      return res.status(400).json({ error: 'Invalid avatar URL' });
    }
    await db.run('UPDATE users SET bio=?, avatar_url=? WHERE id=?', [cleanBio, cleanAvatar, req.session.user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function getRepRank(rep) {
  if (rep >= 500) return { name: 'LEGEND', color: '#ff006e', icon: '★★★★★' };
  if (rep >= 200) return { name: 'ELITE',  color: '#ffd60a', icon: '★★★★' };
  if (rep >= 100) return { name: 'VETERAN', color: '#00f5ff', icon: '★★★' };
  if (rep >= 30)  return { name: 'ACTIVE',  color: '#007a80', icon: '★★' };
  if (rep >= 5)   return { name: 'MEMBER',  color: '#4a6478', icon: '★' };
  return { name: 'NEWBIE', color: '#1a3348', icon: '·' };
}

module.exports = router;
module.exports.getRepRank = getRepRank;
