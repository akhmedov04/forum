const express = require('express');
const db      = require('../db/init');
const { requireAdmin } = require('../middleware/auth');
const router  = express.Router();

router.get('/', async (req, res) => {
  try {
    const cats = await db.all(`
      SELECT c.*, COUNT(DISTINCT t.id) as thread_count, COUNT(DISTINCT p.id) as post_count
      FROM categories c
      LEFT JOIN threads t ON t.cat_id=c.id
      LEFT JOIN posts p ON p.thread_id=t.id
      GROUP BY c.id ORDER BY c.sort_order`);
    res.json(cats);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, name_ru, name_uz, description, icon, slug, admin_only } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });
    const existing = await db.get('SELECT id FROM categories WHERE slug=?', [slug]);
    if (existing) return res.status(409).json({ error: 'Slug already exists' });
    const maxOrd = await db.get('SELECT MAX(sort_order) as m FROM categories');
    const result = await db.run(
      'INSERT INTO categories(slug,name,name_ru,name_uz,description,icon,sort_order,admin_only) VALUES(?,?,?,?,?,?,?,?)',
      [slug, name, name_ru||name, name_uz||name, description||'', icon||'GEN', (maxOrd.m||0)+1, admin_only?1:0]
    );
    res.json(await db.get('SELECT * FROM categories WHERE id=?', [result.lastInsertRowid]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, name_ru, name_uz, description, icon, admin_only } = req.body;
    await db.run(
      `UPDATE categories SET
        name=COALESCE(?,name), name_ru=COALESCE(?,name_ru), name_uz=COALESCE(?,name_uz),
        description=COALESCE(?,description), icon=COALESCE(?,icon),
        admin_only=COALESCE(?,admin_only) WHERE id=?`,
      [name||null, name_ru||null, name_uz||null, description||null, icon||null,
       admin_only!=null ? (admin_only?1:0) : null, req.params.id]
    );
    res.json(await db.get('SELECT * FROM categories WHERE id=?', [req.params.id]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await db.run('DELETE FROM categories WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
