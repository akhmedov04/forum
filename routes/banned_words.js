const express = require('express');
const db      = require('../db/init');
const { requireAdmin } = require('../middleware/auth');
const { invalidateCache } = require('../middleware/wordFilter');
const router  = express.Router();

router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    const words = await db.all('SELECT * FROM banned_words ORDER BY word ASC');
    res.json(words);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const word = (req.body.word || '').trim().toLowerCase();
    if (!word || word.length < 2) return res.status(400).json({ error: 'Word must be at least 2 characters' });
    if (word.length > 50)         return res.status(400).json({ error: 'Word too long (max 50)' });
    const existing = await db.get('SELECT id FROM banned_words WHERE word=? COLLATE NOCASE', [word]);
    if (existing) return res.status(409).json({ error: 'Word already in list' });
    const result = await db.run('INSERT INTO banned_words(word) VALUES(?)', [word]);
    invalidateCache();
    res.json(await db.get('SELECT * FROM banned_words WHERE id=?', [result.lastInsertRowid]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM banned_words WHERE id=?', [req.params.id]);
    invalidateCache();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
