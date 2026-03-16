const express = require('express');
const db      = require('../db/init');
const { requireAuth, requireNotBanned } = require('../middleware/auth');
const { filterText } = require('../middleware/wordFilter');
const { postLimiter } = require('../middleware/rateLimiter');
const router  = express.Router();

router.post('/', requireAuth, requireNotBanned, postLimiter, async (req, res) => {
  try {
    const { thread_id, body, image, is_anonymous } = req.body;
    if (!thread_id||!body) return res.status(400).json({ error: 'thread_id and body required' });
    if (body.trim().length<2) return res.status(400).json({ error: 'Reply is too short' });
    const thread = await db.get('SELECT * FROM threads WHERE id=?',[thread_id]);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    if (thread.locked && !['admin','moderator'].includes(req.session.user.role))
      return res.status(403).json({ error: 'Thread is locked' });
    const filteredBody = await filterText(body.trim());
    const result = await db.run('INSERT INTO posts(thread_id,user_id,body,image,is_anonymous) VALUES(?,?,?,?,?)',
      [thread_id, req.session.user.id, filteredBody, image||'', is_anonymous ? 1 : 0]);
    await db.run("UPDATE threads SET updated_at=strftime('%s','now') WHERE id=?",[thread_id]);
    const post = await db.get(`
      SELECT p.*,u.username as author,u.role as author_role
      FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?`, [result.lastInsertRowid]);
    res.status(201).json(post);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requireAuth, requireNotBanned, async (req, res) => {
  try {
    const post = await db.get('SELECT * FROM posts WHERE id=?',[req.params.id]);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const isMod = ['admin','moderator'].includes(req.session.user.role);
    if (!isMod && post.user_id !== req.session.user.id)
      return res.status(403).json({ error: 'Not allowed' });
    const { body, image } = req.body;
    if (!body||body.trim().length<2) return res.status(400).json({ error: 'Body too short' });
    const filteredBody = await filterText(body.trim());
    await db.run(
      "UPDATE posts SET body=?,image=?,updated_at=strftime('%s','now') WHERE id=?",
      [filteredBody, image !== undefined ? image : post.image, post.id]
    );
    res.json(await db.get(`SELECT p.*,u.username as author,u.role as author_role FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?`,[post.id]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const post = await db.get('SELECT * FROM posts WHERE id=?',[req.params.id]);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const isMod = ['admin','moderator'].includes(req.session.user.role);
    if (!isMod && post.user_id !== req.session.user.id)
      return res.status(403).json({ error: 'Not allowed' });
    await db.run('DELETE FROM posts WHERE id=?',[post.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
