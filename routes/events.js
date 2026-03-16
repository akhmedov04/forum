const express = require('express');
const router  = express.Router();
const db      = require('../db/init');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/events
// Fetch upcoming events including RSVP counts
router.get('/', async (req, res) => {
  try {
    const events = await db.all(`
      SELECT e.*, u.username as creator_name,
             (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id AND r.status = 'going') as going_count,
             (SELECT status FROM event_rsvps r WHERE r.event_id = e.id AND r.user_id = ?) as user_status
      FROM events e
      JOIN users u ON e.created_by = u.id
      ORDER BY e.event_date ASC
    `, [req.session.user.id]);
    
    res.json(events);
  } catch (err) {
    console.error('[EVENTS FETCH ERROR]', err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// POST /api/events
// Create a new event
router.post('/', async (req, res) => {
  const { title, description, event_date, location } = req.body;
  if (!title || !event_date) return res.status(400).json({ error: 'Title and date are required' });

  try {
    const r = await db.run(
      'INSERT INTO events (title, description, event_date, location, created_by) VALUES (?, ?, ?, ?, ?)',
      [title.trim(), description?.trim() || '', parseInt(event_date, 10), location?.trim() || '', req.session.user.id]
    );

    // Auto-RSVP the creator
    await db.run(
      'INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, ?)',
      [r.lastInsertRowid, req.session.user.id, 'going']
    );

    res.json({ success: true, eventId: r.lastInsertRowid });
  } catch (err) {
    console.error('[EVENT CREATE ERROR]', err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// POST /api/events/:id/rsvp
// Toggle RSVP status
router.post('/:id/rsvp', async (req, res) => {
  const { status } = req.body;
  if (!['going', 'not_going'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    // Upsert logic for SQLite
    await db.run(`
      INSERT INTO event_rsvps (event_id, user_id, status)
      VALUES (?, ?, ?)
      ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status
    `, [req.params.id, req.session.user.id, status]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('[EVENT RSVP ERROR]', err);
    res.status(500).json({ error: 'Failed to RSVP' });
  }
});

module.exports = router;
