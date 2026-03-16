const express = require('express');
const db      = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

router.use(requireAuth);

// Upvote a post (+1 rep to post author)
router.post('/vote', async (req, res) => {
  try {
    const { post_id, value } = req.body;
    const v = value === -1 ? -1 : 1;
    if (!post_id) return res.status(400).json({ error: 'post_id required' });

    const post = await db.get('SELECT * FROM posts WHERE id=?', [post_id]);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.user_id === req.session.user.id) return res.status(400).json({ error: 'Cannot vote on your own post' });

    const existing = await db.get('SELECT * FROM rep_votes WHERE from_user=? AND post_id=?',
      [req.session.user.id, post_id]);

    if (existing) {
      if (existing.value === v) {
        // Remove vote
        await db.run('DELETE FROM rep_votes WHERE id=?', [existing.id]);
        await db.run('UPDATE users SET reputation = reputation - ? WHERE id=?', [v, post.user_id]);
        res.json({ vote: 0 });
      } else {
        // Change vote
        await db.run('UPDATE rep_votes SET value=? WHERE id=?', [v, existing.id]);
        await db.run('UPDATE users SET reputation = reputation + ? WHERE id=?', [v * 2, post.user_id]);
        res.json({ vote: v });
      }
    } else {
      await db.run('INSERT INTO rep_votes(from_user, to_user, post_id, value) VALUES(?,?,?,?)',
        [req.session.user.id, post.user_id, post_id, v]);
      await db.run('UPDATE users SET reputation = reputation + ? WHERE id=?', [v, post.user_id]);
      res.json({ vote: v });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get votes for posts in a thread (batch)
router.get('/thread/:thread_id', async (req, res) => {
  try {
    const userId = req.session.user?.id;
    // Get vote totals per post
    const totals = await db.all(`
      SELECT post_id, SUM(value) as total FROM rep_votes
      WHERE post_id IN (SELECT id FROM posts WHERE thread_id=?)
      GROUP BY post_id`, [req.params.thread_id]);

    // Get current user's votes
    let myVotes = [];
    if (userId) {
      myVotes = await db.all(`
        SELECT post_id, value FROM rep_votes
        WHERE from_user=? AND post_id IN (SELECT id FROM posts WHERE thread_id=?)`,
        [userId, req.params.thread_id]);
    }

    const totalMap = {};
    totals.forEach(r => totalMap[r.post_id] = r.total);
    const myMap = {};
    myVotes.forEach(r => myMap[r.post_id] = r.value);

    res.json({ totals: totalMap, myVotes: myMap });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
