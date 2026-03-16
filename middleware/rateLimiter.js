// Simple in-memory rate limiter (no external deps)
// Tracks request counts per IP within sliding windows

const stores = {};

function createLimiter({ windowMs = 60000, max = 30, message = 'Too many requests, slow down.' } = {}) {
  const name = `limiter_${Date.now()}_${Math.random()}`;
  stores[name] = new Map();

  // Cleanup expired entries every windowMs
  const cleanup = setInterval(() => {
    const now = Date.now();
    const store = stores[name];
    for (const [key, entry] of store) {
      if (now - entry.start > windowMs) store.delete(key);
    }
  }, windowMs);
  cleanup.unref?.(); // Don't keep process alive

  return function rateLimitMiddleware(req, res, next) {
    const store = stores[name];
    const key = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = store.get(key);

    if (!entry || now - entry.start > windowMs) {
      entry = { count: 1, start: now };
      store.set(key, entry);
      return next();
    }

    entry.count++;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.start + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }

    next();
  };
}

// Pre-built limiters
const generalLimiter = createLimiter({ windowMs: 60000, max: 60, message: 'Too many requests. Try again in a minute.' });
const authLimiter = createLimiter({ windowMs: 15 * 60000, max: 10, message: 'Too many auth attempts. Try again in 15 minutes.' });
const postLimiter = createLimiter({ windowMs: 60000, max: 5, message: 'Posting too fast. Wait a moment before posting again.' });
const uploadLimiter = createLimiter({ windowMs: 60000, max: 5, message: 'Upload limit reached. Try again in a minute.' });
const searchLimiter = createLimiter({ windowMs: 60000, max: 20, message: 'Too many searches. Slow down.' });

module.exports = { createLimiter, generalLimiter, authLimiter, postLimiter, uploadLimiter, searchLimiter };
