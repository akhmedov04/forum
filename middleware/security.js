// Security headers middleware (lightweight helmet alternative)
function securityHeaders(req, res, next) {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // XSS protection for older browsers
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Referrer policy
  res.setHeader('Referrer-Policy', 'same-origin');
  // Permissions policy
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  // Content Security Policy
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
  // Remove X-Powered-By
  res.removeHeader('X-Powered-By');
  next();
}

// Validate that ID params are positive integers
function validateIdParam(paramName = 'id') {
  return (req, res, next) => {
    const val = req.params[paramName];
    if (val !== undefined) {
      const num = parseInt(val, 10);
      if (isNaN(num) || num < 1 || String(num) !== String(val)) {
        return res.status(400).json({ error: 'Invalid ID parameter' });
      }
      req.params[paramName] = num;
    }
    next();
  };
}

// Session freshness check — re-verify banned status from DB on each request
function sessionRefresh(db) {
  return async (req, res, next) => {
    if (req.session?.user) {
      try {
        const user = await db.get('SELECT id, username, role FROM users WHERE id = ?', [req.session.user.id]);
        if (!user) {
          // User was deleted
          req.session.destroy(() => {});
          return res.status(401).json({ error: 'Session expired — user no longer exists' });
        }
        if (user.role === 'banned') {
          req.session.destroy(() => {});
          return res.status(403).json({ error: 'Your account has been banned' });
        }
        // Update session with fresh role (in case admin changed it)
        req.session.user = { id: user.id, username: user.username, role: user.role };
      } catch (e) {
        // DB error — don't block, just log
        console.error('[sessionRefresh] error:', e.message);
      }
    }
    next();
  };
}

// Sanitize and limit body size for text content
function limitBodySize(maxChars = 10000) {
  return (req, res, next) => {
    if (req.body) {
      for (const key of ['body', 'title', 'description']) {
        if (typeof req.body[key] === 'string' && req.body[key].length > maxChars) {
          return res.status(400).json({ error: `${key} is too long (max ${maxChars} characters)` });
        }
      }
    }
    next();
  };
}

module.exports = { securityHeaders, validateIdParam, sessionRefresh, limitBodySize };
