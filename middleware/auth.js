function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Admin or moderator
function requireMod(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  if (!['admin','moderator'].includes(req.session.user.role))
    return res.status(403).json({ error: 'Moderator access required' });
  next();
}

function requireNotBanned(req, res, next) {
  if (req.session.user && req.session.user.role === 'banned') {
    return res.status(403).json({ error: 'Your account has been banned' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireMod, requireNotBanned };
