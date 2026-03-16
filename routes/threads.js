const express = require('express');
const db      = require('../db/init');
const { requireAuth, requireAdmin, requireMod, requireNotBanned } = require('../middleware/auth');
const { filterText } = require('../middleware/wordFilter');
const { postLimiter, searchLimiter } = require('../middleware/rateLimiter');
const { validateIdParam } = require('../middleware/security');
const router  = express.Router();

router.get('/', searchLimiter, async (req, res) => {
  try {
    const { cat, search } = req.query;
    const page = Math.max(1, Math.min(100, parseInt(req.query.page) || 1));
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    let where = '1=1'; const params = [];

    if (cat) {
      const catRow = await db.get('SELECT id FROM categories WHERE slug=?',[cat]);
      if (!catRow) return res.status(404).json({ error: 'Category not found' });
      where += ' AND t.cat_id=?'; params.push(catRow.id);
    }
    if (search) {
      // Limit search to 100 chars to prevent abuse
      const q = String(search).slice(0, 100);
      where += ' AND (t.title LIKE ? OR t.body LIKE ?)';
      params.push(`%${q}%`,`%${q}%`);
    }

    const total = (await db.get(`SELECT COUNT(*) as n FROM threads t WHERE ${where}`, params)).n;
    const threads = await db.all(`
      SELECT t.id,t.title,t.pinned,t.locked,t.is_anonymous,t.views,t.created_at,t.updated_at,
        u.username as author, u.id as user_id,
        c.name as cat_name, c.name_ru as cat_name_ru, c.name_uz as cat_name_uz, c.slug as cat_slug,
        COUNT(p.id) as reply_count,
        MAX(p.created_at) as last_post_at,
        lpu.username as last_post_user
      FROM threads t
      JOIN users u ON u.id=t.user_id
      JOIN categories c ON c.id=t.cat_id
      LEFT JOIN posts p ON p.thread_id=t.id
      LEFT JOIN (
        SELECT thread_id, user_id FROM posts p2
        WHERE p2.id = (SELECT MAX(p3.id) FROM posts p3 WHERE p3.thread_id = p2.thread_id)
      ) lp ON lp.thread_id = t.id
      LEFT JOIN users lpu ON lpu.id = lp.user_id
      WHERE ${where}
      GROUP BY t.id
      ORDER BY t.pinned DESC, COALESCE(MAX(p.created_at),t.created_at) DESC
      LIMIT ? OFFSET ?`, [...params, limit, offset]);

    res.json({ threads, total, page, pages:Math.ceil(total/limit) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const thread = await db.get(`
      SELECT t.*,u.username as author, u.avatar_url as author_avatar, u.reputation as author_rep,
        c.name as cat_name, c.name_ru as cat_name_ru, c.name_uz as cat_name_uz, c.slug as cat_slug
      FROM threads t JOIN users u ON u.id=t.user_id JOIN categories c ON c.id=t.cat_id
      WHERE t.id=?`, [req.params.id]);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    // Prevent view count abuse: only increment once per session per thread
    const viewedKey = `viewed_${thread.id}`;
    if (!req.session[viewedKey]) {
      await db.run('UPDATE threads SET views=views+1 WHERE id=?',[thread.id]);
      req.session[viewedKey] = true;
      thread.views += 1;
    }
    const posts = await db.all(`
      SELECT p.*,u.username as author,u.role as author_role,u.avatar_url as author_avatar,u.reputation as author_rep
      FROM posts p JOIN users u ON u.id=p.user_id
      WHERE p.thread_id=? ORDER BY p.created_at ASC`, [thread.id]);

    // Bookmark status
    let bookmarked = false;
    if (req.session?.user) {
      const bm = await db.get('SELECT id FROM bookmarks WHERE user_id=? AND thread_id=?',
        [req.session.user.id, thread.id]);
      bookmarked = !!bm;
    }

    res.json({ thread, posts, bookmarked });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requireAuth, requireNotBanned, postLimiter, async (req, res) => {
  try {
    const { cat_slug, title, body, is_anonymous } = req.body;
    if (!cat_slug||!title||!body) return res.status(400).json({ error: 'cat_slug, title and body required' });
    if (title.length<3||title.length>120) return res.status(400).json({ error: 'Title must be 3-120 characters' });
    if (body.trim().length<10) return res.status(400).json({ error: 'Body must be at least 10 characters' });
    const cat = await db.get('SELECT * FROM categories WHERE slug=?',[cat_slug]);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    if (cat.admin_only && req.session.user.role !== 'admin')
      return res.status(403).json({ error: 'Only admins can post in this board' });
    const filteredTitle = await filterText(title.trim());
    const filteredBody  = await filterText(body.trim());
    const result = await db.run('INSERT INTO threads(cat_id,user_id,title,body,image,is_anonymous) VALUES(?,?,?,?,?,?)',
      [cat.id, req.session.user.id, filteredTitle, filteredBody, req.body.image||'', is_anonymous ? 1 : 0]);
    const thread = await db.get(`
      SELECT t.*,u.username as author,c.name as cat_name,c.name_ru as cat_name_ru,c.name_uz as cat_name_uz,c.slug as cat_slug
      FROM threads t JOIN users u ON u.id=t.user_id JOIN categories c ON c.id=t.cat_id
      WHERE t.id=?`, [result.lastInsertRowid]);
    res.status(201).json(thread);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requireAuth, requireNotBanned, async (req, res) => {
  try {
    const thread = await db.get('SELECT * FROM threads WHERE id=?',[req.params.id]);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    if (req.session.user.role!=='admin' && thread.user_id!==req.session.user.id)
      return res.status(403).json({ error: 'Not allowed' });
    const { title, body } = req.body;
    const filteredTitle = title ? await filterText(title) : null;
    const filteredBody  = body  ? await filterText(body)  : null;
    await db.run("UPDATE threads SET title=COALESCE(?,title),body=COALESCE(?,body),updated_at=strftime('%s','now') WHERE id=?",
      [filteredTitle, filteredBody, thread.id]);
    res.json(await db.get('SELECT * FROM threads WHERE id=?',[thread.id]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const thread = await db.get('SELECT * FROM threads WHERE id=?',[req.params.id]);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    const isMod = ['admin','moderator'].includes(req.session.user.role);
    if (!isMod && thread.user_id !== req.session.user.id)
      return res.status(403).json({ error: 'Not allowed' });
    await db.run('DELETE FROM threads WHERE id=?',[thread.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/pin', requireAdmin, async (req, res) => {
  try {
    const t = await db.get('SELECT * FROM threads WHERE id=?',[req.params.id]);
    if (!t) return res.status(404).json({ error: 'Thread not found' });
    await db.run('UPDATE threads SET pinned=? WHERE id=?',[t.pinned?0:1,t.id]);
    res.json({ pinned: !t.pinned });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/lock', requireMod, async (req, res) => {
  try {
    const t = await db.get('SELECT * FROM threads WHERE id=?',[req.params.id]);
    if (!t) return res.status(404).json({ error: 'Thread not found' });
    await db.run('UPDATE threads SET locked=? WHERE id=?',[t.locked?0:1,t.id]);
    res.json({ locked: !t.locked });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/move', requireAdmin, async (req, res) => {
  try {
    const cat = await db.get('SELECT id FROM categories WHERE slug=?',[req.body.cat_slug]);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    await db.run('UPDATE threads SET cat_id=? WHERE id=?',[cat.id,req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
