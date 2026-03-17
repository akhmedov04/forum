const express = require('express');
const db      = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

router.use(requireAuth);

// ─── Get all conversations for current user ─────
router.get('/conversations', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const convs = await db.all(`
      SELECT c.*, cp.last_read, cp.pinned, cp.hidden,
        (SELECT COUNT(*) FROM messages WHERE conv_id=c.id AND deleted=0) as msg_count,
        (SELECT COUNT(*) FROM messages WHERE conv_id=c.id AND deleted=0 AND created_at > cp.last_read AND user_id != ?) as unread_count
      FROM conversations c
      JOIN conv_participants cp ON cp.conv_id=c.id AND cp.user_id=?
      WHERE cp.hidden=0
      ORDER BY cp.pinned DESC, c.updated_at DESC`, [userId, userId]);

    if (convs.length === 0) return res.json([]);

    const convIds = convs.map(c => c.id);
    const placeholders = convIds.map(() => '?').join(',');

    // Batch-load participants (avoid N+1)
    const partRows = await db.all(
      `
      SELECT cp.conv_id, u.id, u.username, u.avatar_url, u.role, u.last_seen
      FROM conv_participants cp
      JOIN users u ON u.id = cp.user_id
      WHERE cp.conv_id IN (${placeholders})
      `,
      convIds
    );
    const partsByConv = new Map();
    for (const r of partRows) {
      if (!partsByConv.has(r.conv_id)) partsByConv.set(r.conv_id, []);
      partsByConv.get(r.conv_id).push({
        id: r.id,
        username: r.username,
        avatar_url: r.avatar_url,
        role: r.role,
        last_seen: r.last_seen,
      });
    }

    // Batch-load last message for each conversation (avoid N+1)
    const lastRows = await db.all(
      `
      SELECT * FROM (
        SELECT m.*, u.username as author,
               ROW_NUMBER() OVER (PARTITION BY m.conv_id ORDER BY m.created_at DESC, m.id DESC) as rn
        FROM messages m
        JOIN users u ON u.id = m.user_id
        WHERE m.deleted=0 AND m.conv_id IN (${placeholders})
      ) WHERE rn=1
      `,
      convIds
    );
    const lastByConv = new Map();
    for (const r of lastRows) {
      delete r.rn;
      lastByConv.set(r.conv_id, r);
    }

    for (const c of convs) {
      c.participants = partsByConv.get(c.id) || [];
      c.last_message = lastByConv.get(c.id) || null;
    }
    res.json(convs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Pin / unpin conversation for current user ─────
router.put('/conversations/:id/pin', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const convId = parseInt(req.params.id);
    const pinned = req.body?.pinned ? 1 : 0;

    const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, userId]);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    await db.run('UPDATE conv_participants SET pinned=? WHERE conv_id=? AND user_id=?', [pinned, convId, userId]);
    res.json({ ok: true, pinned });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Hide (delete from sidebar) for current user ─────
router.delete('/conversations/:id', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const convId = parseInt(req.params.id);

    const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, userId]);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    await db.run('UPDATE conv_participants SET hidden=1, pinned=0 WHERE conv_id=? AND user_id=?', [convId, userId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Create DM conversation ─────
router.post('/conversations/dm', async (req, res) => {
  try {
    const { user_id } = req.body;
    const myId = req.session.user.id;
    if (!user_id || user_id === myId) return res.status(400).json({ error: 'Invalid user' });

    const target = await db.get('SELECT id, username FROM users WHERE id=?', [user_id]);
    if (!target) return res.status(404).json({ error: 'User not found' });

    // Check if DM already exists
    const existing = await db.get(`
      SELECT c.id FROM conversations c
      WHERE c.type='dm'
        AND (SELECT COUNT(*) FROM conv_participants WHERE conv_id=c.id) = 2
        AND EXISTS (SELECT 1 FROM conv_participants WHERE conv_id=c.id AND user_id=?)
        AND EXISTS (SELECT 1 FROM conv_participants WHERE conv_id=c.id AND user_id=?)`,
      [myId, user_id]);

    if (existing) {
      // Ensure it is visible again for the current user
      await db.run('UPDATE conv_participants SET hidden=0 WHERE conv_id=? AND user_id=?', [existing.id, myId]);
      return res.json({ conv_id: existing.id, existing: true });
    }

    const r = await db.run('INSERT INTO conversations(type, created_by) VALUES(?,?)', ['dm', myId]);
    const convId = r.lastInsertRowid;
    await db.run('INSERT INTO conv_participants(conv_id, user_id) VALUES(?,?)', [convId, myId]);
    await db.run('INSERT INTO conv_participants(conv_id, user_id) VALUES(?,?)', [convId, user_id]);
    res.json({ conv_id: convId, existing: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Create group conversation ─────
router.post('/conversations/group', async (req, res) => {
  try {
    const { name, user_ids } = req.body;
    const myId = req.session.user.id;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Group name required' });
    if (!user_ids?.length) return res.status(400).json({ error: 'Add at least 1 member' });

    const r = await db.run('INSERT INTO conversations(type, name, created_by) VALUES(?,?,?)',
      ['group', name.trim().slice(0, 60), myId]);
    const convId = r.lastInsertRowid;

    // Add creator as admin
    await db.run('INSERT INTO conv_participants(conv_id, user_id, role) VALUES(?,?,?)', [convId, myId, 'admin']);
    // Add members
    const uniqueIds = [...new Set(user_ids.filter(id => id !== myId))];
    for (const uid of uniqueIds.slice(0, 50)) {
      const u = await db.get('SELECT id FROM users WHERE id=?', [uid]);
      if (u) await db.run('INSERT OR IGNORE INTO conv_participants(conv_id, user_id) VALUES(?,?)', [convId, uid]);
    }
    res.json({ conv_id: convId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Get messages in conversation ─────
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const convId = req.params.id;
    // Verify membership
    const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, userId]);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const before = parseInt(req.query.before) || Date.now() / 1000 + 99999;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const messages = await db.all(`
      SELECT
        m.*,
        u.username as author,
        u.avatar_url as author_avatar,
        u.role as author_role,
        ru.username as reply_author,
        r.body as reply_body,
        r.image as reply_image
      FROM messages m
      JOIN users u ON u.id=m.user_id
      LEFT JOIN messages r ON r.id = m.reply_to_id
      LEFT JOIN users ru ON ru.id = r.user_id
      WHERE m.conv_id=? AND m.created_at < ?
      ORDER BY m.created_at DESC LIMIT ?`, [convId, before, limit]);

    // Mark as read
    const now = Math.floor(Date.now() / 1000);
    await db.run('UPDATE conv_participants SET last_read=? WHERE conv_id=? AND user_id=?', [now, convId, userId]);

    res.json(messages.reverse());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Send message (REST fallback, main flow is socket.io) ─────
router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const convId = req.params.id;
    const { body, image } = req.body;
    if (!body?.trim() && !image) return res.status(400).json({ error: 'Empty message' });
    if (image && (typeof image !== 'string' || !image.startsWith('/uploads/') || /[<>"']/.test(image)))
      return res.status(400).json({ error: 'Invalid image URL' });

    const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, userId]);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const now = Math.floor(Date.now() / 1000);
    const r = await db.run(
      'INSERT INTO messages(conv_id, user_id, body, image, created_at, updated_at) VALUES(?,?,?,?,?,?)',
      [convId, userId, (body || '').slice(0, 5000), (image || '').slice(0, 500), now, now]);
    await db.run('UPDATE conversations SET updated_at=? WHERE id=?', [now, convId]);

    const msg = await db.get(`
      SELECT m.*, u.username as author, u.avatar_url as author_avatar, u.role as author_role
      FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?`, [r.lastInsertRowid]);

    res.json(msg);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Edit message ─────
router.put('/messages/:id', async (req, res) => {
  try {
    const msg = await db.get('SELECT * FROM messages WHERE id=?', [req.params.id]);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.user_id !== req.session.user.id) return res.status(403).json({ error: 'Not your message' });
    if (msg.deleted) return res.status(400).json({ error: 'Message deleted' });

    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Empty' });
    const now = Math.floor(Date.now() / 1000);
    await db.run('UPDATE messages SET body=?, edited=1, updated_at=? WHERE id=?',
      [body.slice(0, 5000), now, msg.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Delete message ─────
router.delete('/messages/:id', async (req, res) => {
  try {
    const msg = await db.get('SELECT * FROM messages WHERE id=?', [req.params.id]);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    const isAdmin = req.session.user.role === 'admin';
    if (msg.user_id !== req.session.user.id && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    await db.run('UPDATE messages SET deleted=1, body="", image="" WHERE id=?', [msg.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Search users for starting new conversation ─────
router.get('/users/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 1) return res.json([]);
    const users = await db.all(`
      SELECT id, username, avatar_url, role, last_seen FROM users
      WHERE username LIKE ? AND id != ? AND role != 'banned'
      LIMIT 20`, [`%${q}%`, req.session.user.id]);
    res.json(users);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Get all users (for group creation) ─────
// Users you have chatted with (contacts)
router.get('/users/contacts', async (req, res) => {
  try {
    const users = await db.all(`
      SELECT DISTINCT u.id, u.username, u.avatar_url, u.role, u.last_seen
      FROM users u
      INNER JOIN conv_participants cp ON cp.user_id = u.id
      INNER JOIN conv_participants my ON my.conv_id = cp.conv_id AND my.user_id = ?
      WHERE u.id != ? AND u.role != 'banned'
      ORDER BY u.username COLLATE NOCASE`, [req.session.user.id, req.session.user.id]);
    res.json(users);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// All users (for search)
router.get('/users/all', async (req, res) => {
  try {
    const users = await db.all(`
      SELECT id, username, avatar_url, role, last_seen FROM users
      WHERE id != ? AND role != 'banned'
      ORDER BY username COLLATE NOCASE`, [req.session.user.id]);
    res.json(users);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// ═══════════════════════════════════════════════════
//  GROUP MANAGEMENT
// ═══════════════════════════════════════════════════

// Get conversation details (for group settings panel)
router.get('/conversations/:id/details', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const convId = req.params.id;
    const member = await db.get('SELECT * FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, userId]);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    const conv = await db.get('SELECT * FROM conversations WHERE id=?', [convId]);
    const participants = await db.all(`
      SELECT u.id, u.username, u.avatar_url, u.role as user_role, u.last_seen, cp.role as conv_role, cp.joined_at
      FROM conv_participants cp JOIN users u ON u.id=cp.user_id
      WHERE cp.conv_id=? ORDER BY cp.role DESC, u.username COLLATE NOCASE`, [convId]);

    res.json({ ...conv, participants, myRole: member.role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update group name
router.put('/conversations/:id/name', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const convId = req.params.id;
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

    const member = await db.get('SELECT * FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, userId]);
    if (!member || member.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const conv = await db.get('SELECT * FROM conversations WHERE id=?', [convId]);
    if (!conv || conv.type !== 'group') return res.status(400).json({ error: 'Not a group' });

    await db.run('UPDATE conversations SET name=? WHERE id=?', [name.trim().slice(0, 60), convId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update group avatar
router.put('/conversations/:id/avatar', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const convId = req.params.id;
    const { avatar_url } = req.body;

    const member = await db.get('SELECT * FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, userId]);
    if (!member || member.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    if (avatar_url && !avatar_url.startsWith('/uploads/')) return res.status(400).json({ error: 'Invalid URL' });
    await db.run('UPDATE conversations SET avatar_url=? WHERE id=?', [(avatar_url || '').slice(0, 500), convId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Add member to group
router.post('/conversations/:id/members', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const convId = req.params.id;
    const { user_id } = req.body;

    const member = await db.get('SELECT * FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, userId]);
    if (!member || member.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const conv = await db.get('SELECT * FROM conversations WHERE id=? AND type="group"', [convId]);
    if (!conv) return res.status(400).json({ error: 'Not a group' });

    const target = await db.get('SELECT id,username FROM users WHERE id=?', [user_id]);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const existing = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, user_id]);
    if (existing) return res.status(400).json({ error: 'Already a member' });

    await db.run('INSERT INTO conv_participants(conv_id, user_id, role) VALUES(?,?,?)', [convId, user_id, 'member']);
    res.json({ ok: true, username: target.username });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Remove member from group
router.delete('/conversations/:id/members/:user_id', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const convId = req.params.id;
    const targetId = parseInt(req.params.user_id);

    const member = await db.get('SELECT * FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, userId]);
    if (!member || member.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    if (targetId === userId) return res.status(400).json({ error: 'Cannot remove yourself' });

    await db.run('DELETE FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, targetId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Set member role (admin/member)
router.put('/conversations/:id/members/:user_id/role', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const convId = req.params.id;
    const targetId = parseInt(req.params.user_id);
    const { role } = req.body;
    if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const member = await db.get('SELECT * FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, userId]);
    if (!member || member.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    await db.run('UPDATE conv_participants SET role=? WHERE conv_id=? AND user_id=?', [role, convId, targetId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Leave group
router.post('/conversations/:id/leave', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const convId = req.params.id;
    const conv = await db.get('SELECT * FROM conversations WHERE id=? AND type="group"', [convId]);
    if (!conv) return res.status(400).json({ error: 'Not a group' });

    await db.run('DELETE FROM conv_participants WHERE conv_id=? AND user_id=?', [convId, userId]);

    // If no members left, delete conversation
    const remaining = await db.get('SELECT COUNT(*) as n FROM conv_participants WHERE conv_id=?', [convId]);
    if (remaining.n === 0) {
      await db.run('DELETE FROM messages WHERE conv_id=?', [convId]);
      await db.run('DELETE FROM conversations WHERE id=?', [convId]);
    } else {
      // If no admins left, promote the oldest member
      const adminCount = await db.get('SELECT COUNT(*) as n FROM conv_participants WHERE conv_id=? AND role="admin"', [convId]);
      if (adminCount.n === 0) {
        const oldest = await db.get('SELECT user_id FROM conv_participants WHERE conv_id=? ORDER BY joined_at ASC LIMIT 1', [convId]);
        if (oldest) await db.run('UPDATE conv_participants SET role="admin" WHERE conv_id=? AND user_id=?', [convId, oldest.user_id]);
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Forward message
router.post('/messages/:id/forward', async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { to_conv_id } = req.body;

    const msg = await db.get('SELECT * FROM messages WHERE id=? AND deleted=0', [req.params.id]);
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    const fromMember = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [msg.conv_id, userId]);
    if (!fromMember) return res.status(403).json({ error: 'Forbidden' });

    const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [to_conv_id, userId]);
    if (!member) return res.status(403).json({ error: 'Not a member of target' });

    const origAuthor = await db.get('SELECT username FROM users WHERE id=?', [msg.user_id]);
    const fwdBody = `⤻ ${origAuthor?.username || '?'}:\n${msg.body}`;
    const now = Math.floor(Date.now() / 1000);

    const r = await db.run(
      'INSERT INTO messages(conv_id, user_id, body, image, created_at, updated_at) VALUES(?,?,?,?,?,?)',
      [to_conv_id, userId, fwdBody.slice(0, 5000), msg.image || '', now, now]);
    await db.run('UPDATE conversations SET updated_at=? WHERE id=?', [now, to_conv_id]);

    const newMsg = await db.get(`
      SELECT m.*, u.username as author, u.avatar_url as author_avatar, u.role as author_role
      FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?`, [r.lastInsertRowid]);

    res.json(newMsg);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
