const db = require('./db/init');

// Track online users: userId -> Set of socketIds
const onlineUsers = new Map();

// ─── Socket Rate Limiter ─────
const socketRateLimits = new Map(); // `${userId}:${event}` -> { count, resetAt }

function socketRateLimit(userId, event, maxPerMin = 30) {
  const key = `${userId}:${event}`;
  const now = Date.now();
  let entry = socketRateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60000 };
  }
  entry.count++;
  socketRateLimits.set(key, entry);
  return entry.count > maxPerMin;
}

// Cleanup rate limit entries every 2 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of socketRateLimits) { if (now > v.resetAt) socketRateLimits.delete(k); }
}, 120000);

// ─── Validate image URL ─────
function isValidImageUrl(url) {
  if (!url) return true; // empty is ok
  return typeof url === 'string' && url.startsWith('/uploads/') && url.length <= 500 && !/[<>"']/.test(url);
}

function setupSocket(io, sessionMiddleware) {
  // Share session with socket.io
  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
  });

  io.use((socket, next) => {
    const user = socket.request.session?.user;
    if (!user) return next(new Error('AUTH_REQUIRED'));
    socket.userId = user.id;
    socket.username = user.username;
    next();
  });

  io.on('connection', async (socket) => {
    const userId = socket.userId;
    console.log(`[MSG] ${socket.username} connected (${socket.id})`);

    // Track online
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);

    // Update last_seen
    await db.run('UPDATE users SET last_seen=? WHERE id=?', [Math.floor(Date.now()/1000), userId]);

    // Join rooms for all conversations
    const convs = await db.all('SELECT conv_id FROM conv_participants WHERE user_id=?', [userId]);
    convs.forEach(c => socket.join(`conv:${c.conv_id}`));

    // Broadcast online status
    broadcastOnlineStatus(io);

    // ─── Send message ─────
    socket.on('msg:send', async (data, ack) => {
      try {
        if (socketRateLimit(userId, 'msg:send', 20)) return ack?.({ error: 'Too fast, slow down' });

        const { conv_id, body, image, reply_to_id } = data;
        if (!body?.trim() && !image) return ack?.({ error: 'Empty' });
        if (image && !isValidImageUrl(image)) return ack?.({ error: 'Invalid image URL' });

        const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [conv_id, userId]);
        if (!member) return ack?.({ error: 'Not a member' });

        if (reply_to_id) {
          const validReply = await db.get('SELECT id FROM messages WHERE id=? AND conv_id=?', [reply_to_id, conv_id]);
          if (!validReply) return ack?.({ error: 'Invalid reply target' });
        }

        const now = Math.floor(Date.now()/1000);
        const r = await db.run(
          'INSERT INTO messages(conv_id, user_id, body, image, reply_to_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
          [conv_id, userId, (body||'').slice(0,5000), (image||'').slice(0,500), reply_to_id || null, now, now]);
        await db.run('UPDATE conversations SET updated_at=? WHERE id=?', [now, conv_id]);

        const msg = await db.get(`
          SELECT m.*, u.username as author, u.avatar_url as author_avatar, u.role as author_role
          FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?`, [r.lastInsertRowid]);

        // Get reply info if present
        if (msg.reply_to_id) {
          const replyMsg = await db.get(`SELECT m.body, m.image, u.username as author FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?`, [msg.reply_to_id]);
          if (replyMsg) { msg.reply_author = replyMsg.author; msg.reply_body = replyMsg.body; msg.reply_image = replyMsg.image; }
        }

        // Ensure ALL participants are in the socket room (handles new conversations)
        const participants = await db.all('SELECT user_id FROM conv_participants WHERE conv_id=?', [conv_id]);
        for (const p of participants) {
          const pSockets = onlineUsers.get(p.user_id);
          if (pSockets) {
            for (const sid of pSockets) {
              const pSocket = io.sockets.sockets.get(sid);
              if (pSocket && !pSocket.rooms.has(`conv:${conv_id}`)) {
                pSocket.join(`conv:${conv_id}`);
                // Notify this user about the new conversation
                pSocket.emit('conv:new', { conv_id });
              }
            }
          }
        }

        // Broadcast to all participants in this conversation
        io.to(`conv:${conv_id}`).emit('msg:new', msg);
        ack?.({ ok: true, msg });
      } catch(e) { ack?.({ error: e.message }); }
    });

    // ─── Edit message ─────
    socket.on('msg:edit', async (data, ack) => {
      try {
        if (socketRateLimit(userId, 'msg:edit', 15)) return ack?.({ error: 'Too fast' });
        const { msg_id, body } = data;
        const msg = await db.get('SELECT * FROM messages WHERE id=?', [msg_id]);
        if (!msg || msg.user_id !== userId) return ack?.({ error: 'Forbidden' });
        if (msg.deleted) return ack?.({ error: 'Deleted' });

        const now = Math.floor(Date.now()/1000);
        await db.run('UPDATE messages SET body=?, edited=1, updated_at=? WHERE id=?',
          [body.slice(0,5000), now, msg_id]);
        io.to(`conv:${msg.conv_id}`).emit('msg:edited', { msg_id, body, updated_at: now });
        ack?.({ ok: true });
      } catch(e) { ack?.({ error: e.message }); }
    });

    // ─── Delete message ─────
    socket.on('msg:delete', async (data, ack) => {
      try {
        if (socketRateLimit(userId, 'msg:delete', 15)) return ack?.({ error: 'Too fast' });
        const { msg_id } = data;
        const msg = await db.get('SELECT * FROM messages WHERE id=?', [msg_id]);
        if (!msg) return ack?.({ error: 'Not found' });
        const isAdmin = socket.request.session?.user?.role === 'admin';
        if (msg.user_id !== userId && !isAdmin) return ack?.({ error: 'Forbidden' });

        await db.run('UPDATE messages SET deleted=1, body="", image="" WHERE id=?', [msg_id]);
        io.to(`conv:${msg.conv_id}`).emit('msg:deleted', { msg_id, conv_id: msg.conv_id });
        ack?.({ ok: true });
      } catch(e) { ack?.({ error: e.message }); }
    });

    // ─── Typing indicator ─────
    socket.on('typing:start', async (data) => {
      if (socketRateLimit(userId, 'typing', 30)) return;
      const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [data.conv_id, userId]);
      if (!member) return;
      socket.to(`conv:${data.conv_id}`).emit('typing:start', {
        conv_id: data.conv_id, user_id: userId, username: socket.username
      });
    });
    socket.on('typing:stop', async (data) => {
      const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [data.conv_id, userId]);
      if (!member) return;
      socket.to(`conv:${data.conv_id}`).emit('typing:stop', {
        conv_id: data.conv_id, user_id: userId
      });
    });

    // ─── Mark as read ─────
    socket.on('conv:read', async (data) => {
      const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [data.conv_id, userId]);
      if (!member) return;
      const now = Math.floor(Date.now()/1000);
      await db.run('UPDATE conv_participants SET last_read=? WHERE conv_id=? AND user_id=?',
        [now, data.conv_id, userId]);
    });

    // ─── Group: notify members of changes ─────
    socket.on('group:updated', async (data) => {
      const member = await db.get('SELECT * FROM conv_participants WHERE conv_id=? AND user_id=?', [data.conv_id, userId]);
      if (!member || member.role !== 'admin') return;
      io.to(`conv:${data.conv_id}`).emit('group:updated', data);
    });

    // ─── Group: kick member (remove from room) ─────
    socket.on('group:kick', async (data) => {
      const { conv_id, user_id: kickedId } = data;
      const member = await db.get('SELECT * FROM conv_participants WHERE conv_id=? AND user_id=?', [conv_id, userId]);
      if (!member || member.role !== 'admin') return;
      const kickedSockets = onlineUsers.get(kickedId);
      if (kickedSockets) {
        for (const sid of kickedSockets) {
          const s = io.sockets.sockets.get(sid);
          if (s) {
            s.leave(`conv:${conv_id}`);
            s.emit('group:kicked', { conv_id });
          }
        }
      }
      io.to(`conv:${conv_id}`).emit('group:updated', { conv_id });
    });

    // ─── Group: add member to room ─────
    socket.on('group:addmember', async (data) => {
      const { conv_id, user_id: addedId } = data;
      const member = await db.get('SELECT * FROM conv_participants WHERE conv_id=? AND user_id=?', [conv_id, userId]);
      if (!member || member.role !== 'admin') return;
      const addedSockets = onlineUsers.get(addedId);
      if (addedSockets) {
        for (const sid of addedSockets) {
          const s = io.sockets.sockets.get(sid);
          if (s) {
            s.join(`conv:${conv_id}`);
            s.emit('conv:new', { conv_id });
          }
        }
      }
      io.to(`conv:${conv_id}`).emit('group:updated', { conv_id });
    });

    // ─── Forward message ─────
    socket.on('msg:forward', async (data, ack) => {
      try {
        if (socketRateLimit(userId, 'msg:forward', 10)) return ack?.({ error: 'Too fast' });
        const { msg_id, to_conv_id } = data;
        const msg = await db.get('SELECT * FROM messages WHERE id=? AND deleted=0', [msg_id]);
        if (!msg) return ack?.({ error: 'Not found' });

        const fromMember = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [msg.conv_id, userId]);
        if (!fromMember) return ack?.({ error: 'Forbidden' });

        const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [to_conv_id, userId]);
        if (!member) return ack?.({ error: 'Not a member' });

        const origAuthor = await db.get('SELECT username FROM users WHERE id=?', [msg.user_id]);
        const fwdBody = `⤻ ${origAuthor?.username || '?'}:\n${msg.body}`;
        const now = Math.floor(Date.now()/1000);

        const r = await db.run(
          'INSERT INTO messages(conv_id, user_id, body, image, created_at, updated_at) VALUES(?,?,?,?,?,?)',
          [to_conv_id, userId, fwdBody.slice(0,5000), msg.image || '', now, now]);
        await db.run('UPDATE conversations SET updated_at=? WHERE id=?', [now, to_conv_id]);

        const newMsg = await db.get(`
          SELECT m.*, u.username as author, u.avatar_url as author_avatar, u.role as author_role
          FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?`, [r.lastInsertRowid]);

        // Ensure target room members see it
        const participants = await db.all('SELECT user_id FROM conv_participants WHERE conv_id=?', [to_conv_id]);
        for (const p of participants) {
          const pSockets = onlineUsers.get(p.user_id);
          if (pSockets) {
            for (const sid of pSockets) {
              const pSocket = io.sockets.sockets.get(sid);
              if (pSocket && !pSocket.rooms.has(`conv:${to_conv_id}`)) {
                pSocket.join(`conv:${to_conv_id}`);
              }
            }
          }
        }

        io.to(`conv:${to_conv_id}`).emit('msg:new', newMsg);
        ack?.({ ok: true });
      } catch(e) { ack?.({ error: e.message }); }
    });

    // ─── Join new conversation room ─────
    socket.on('conv:join', async (data) => {
      const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [data.conv_id, userId]);
      if (!member) return; // Not a member — deny room join
      socket.join(`conv:${data.conv_id}`);
    });

    // ─── WebRTC Signaling ─────
    socket.on('webrtc-offer', async (data) => {
      const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [data.conv_id, userId]);
      if (!member) return;
      socket.to(`conv:${data.conv_id}`).emit('webrtc-offer', { ...data, from_user_id: userId, from_username: socket.username });
    });
    socket.on('webrtc-answer', async (data) => {
      const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [data.conv_id, userId]);
      if (!member) return;
      socket.to(`conv:${data.conv_id}`).emit('webrtc-answer', { ...data, from_user_id: userId });
    });
    socket.on('webrtc-candidate', async (data) => {
      const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [data.conv_id, userId]);
      if (!member) return;
      socket.to(`conv:${data.conv_id}`).emit('webrtc-candidate', { ...data, from_user_id: userId });
    });
    socket.on('webrtc-end', async (data) => {
      const member = await db.get('SELECT id FROM conv_participants WHERE conv_id=? AND user_id=?', [data.conv_id, userId]);
      if (!member) return;
      socket.to(`conv:${data.conv_id}`).emit('webrtc-end', { ...data, from_user_id: userId });
    });

    // ─── Disconnect ─────
    socket.on('disconnect', async () => {
      console.log(`[MSG] ${socket.username} disconnected`);
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) onlineUsers.delete(userId);
      }
      await db.run('UPDATE users SET last_seen=? WHERE id=?', [Math.floor(Date.now()/1000), userId]);
      broadcastOnlineStatus(io);
    });
  });
}

function broadcastOnlineStatus(io) {
  const online = Array.from(onlineUsers.keys());
  io.emit('users:online', online);
}

function getOnlineUsers() {
  return Array.from(onlineUsers.keys());
}

module.exports = { setupSocket, getOnlineUsers };
