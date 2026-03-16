const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db/init');
const { requireAdmin, requireMod } = require('../middleware/auth');
const router  = express.Router();

// All admin routes require at least mod, specific ones require admin
router.use(requireMod);

router.get('/users', async (req, res) => {
  try {
    const users = await db.all(`
      SELECT id,username,role,created_at,last_seen,
        (SELECT COUNT(*) FROM threads WHERE user_id=u.id) as thread_count,
        (SELECT COUNT(*) FROM posts   WHERE user_id=u.id) as post_count
      FROM users u ORDER BY created_at DESC`);
    res.json(users);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin','moderator','member','banned'].includes(role))
      return res.status(400).json({ error: 'Invalid role' });
    // Only admin can assign admin/moderator roles
    if (['admin','moderator'].includes(role) && req.session.user.role !== 'admin')
      return res.status(403).json({ error: 'Only admins can assign admin/moderator roles' });
    // Moderator can only ban/unban members
    if (req.session.user.role === 'moderator' && !['member','banned'].includes(role))
      return res.status(403).json({ error: 'Moderators can only ban or unban members' });
    const user = await db.get('SELECT * FROM users WHERE id=?',[req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.id === req.session.user.id)
      return res.status(400).json({ error: 'Cannot change your own role' });
    // Cannot ban an admin or moderator (only admin can demote them first)
    if (req.session.user.role === 'moderator' && ['admin','moderator'].includes(user.role))
      return res.status(403).json({ error: 'Cannot ban admins or moderators' });

    await db.run('UPDATE users SET role=? WHERE id=?', [role, user.id]);

    // If banned: delete ALL their posts and threads
    if (role === 'banned') {
      await db.run('DELETE FROM posts WHERE user_id=?', [user.id]);
      await db.run('DELETE FROM threads WHERE user_id=?', [user.id]);
    }

    // Invalidate their session by updating a flag (they'll be blocked on next request)
    res.json({ ok: true, username: user.username, role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id=?',[req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.id === req.session.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });

    // Clean up dependent records to avoid foreign key constraint failures
    await db.run('DELETE FROM messages WHERE user_id=?', [user.id]);
    await db.run('DELETE FROM posts WHERE user_id=?', [user.id]);
    await db.run('DELETE FROM threads WHERE user_id=?', [user.id]);
    await db.run('UPDATE conversations SET created_by=NULL WHERE created_by=?', [user.id]);
    
    await db.run('DELETE FROM users WHERE id=?',[user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword||newPassword.length<6) return res.status(400).json({ error: 'Password must be at least 6 chars' });
    await db.run('UPDATE users SET password=? WHERE id=?',[await bcrypt.hash(newPassword,12), req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats', requireAdmin, async (req, res) => {
  try {
    res.json({
      users:   (await db.get('SELECT COUNT(*) as n FROM users')).n,
      threads: (await db.get('SELECT COUNT(*) as n FROM threads')).n,
      posts:   (await db.get('SELECT COUNT(*) as n FROM posts')).n,
      banned:  (await db.get("SELECT COUNT(*) as n FROM users WHERE role='banned'")).n,
      admins:  (await db.get("SELECT COUNT(*) as n FROM users WHERE role='admin'")).n,
      mods:    (await db.get("SELECT COUNT(*) as n FROM users WHERE role='moderator'")).n,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
