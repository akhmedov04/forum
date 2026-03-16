const express     = require('express');
const session     = require('express-session');
const SqliteStore = require('connect-sqlite3')(session);
const compression = require('compression');
const path        = require('path');
const crypto      = require('crypto');
const http        = require('http');
const { Server }  = require('socket.io');

const { securityHeaders, sessionRefresh, limitBodySize } = require('./middleware/security');
const { generalLimiter } = require('./middleware/rateLimiter');
const { setupSocket }    = require('./socketHandler');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: false } });
const PORT   = process.env.PORT || 3000;
const HOST   = process.env.HOST || '0.0.0.0';

// Generate a random session secret if not provided (persists per process)
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.log('  ⚠  No SESSION_SECRET env var set — generated a random one.');
  console.log('     Sessions will be invalidated on server restart.');
  console.log('     Set SESSION_SECRET env var for persistent sessions.\n');
}

// ─── GLOBAL MIDDLEWARE ──────────────────────────────
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers
app.use(securityHeaders);

// Gzip compression for all responses
app.use(compression());

// Body parsing with size limits
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

// Session configuration
const sessionMiddleware = session({
  store: new SqliteStore({ db: 'sessions.db', dir: path.join(__dirname, 'db') }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'plchn.sid',
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
});
app.use(sessionMiddleware);

// Setup Socket.IO with shared session
setupSocket(io, sessionMiddleware);

// General rate limit on all API routes
app.use('/api', generalLimiter);

// Body size limit for text content
app.use('/api', limitBodySize(15000));

// ─── ROUTES ─────────────────────────────────────────
const db = require('./db/init');

// Session freshness: re-check user role/ban on every API request
app.use('/api', sessionRefresh(db));

app.use('/api/auth',         require('./routes/auth'));
app.use('/api/categories',   require('./routes/categories'));
app.use('/api/threads',      require('./routes/threads'));
app.use('/api/posts',        require('./routes/posts'));
app.use('/api/admin',        require('./routes/admin'));
app.use('/api/upload',       require('./routes/upload'));
app.use('/api/banned-words', require('./routes/banned_words'));
app.use('/api/profile',      require('./routes/profile'));
app.use('/api/bookmarks',    require('./routes/bookmarks'));
app.use('/api/reputation',   require('./routes/reputation'));
app.use('/api/messenger',    require('./routes/messenger'));
app.use('/api/events',       require('./routes/events'));

// ─── STATIC FILES ───────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'), {
  maxAge: '30d',
  immutable: true
}));

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true
}));

app.get('{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── ERROR HANDLER ──────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack);
  const message = process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
  res.status(500).json({ error: message });
});

// ─── START ──────────────────────────────────────────
db.initialize().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`\n  PLOV//CHAN running at http://localhost:${PORT}`);
    console.log(`  Messenger WebSocket: active`);
    console.log(`  Environment: ${process.env.NODE_ENV || 'development'}\n`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ❌ Port ${PORT} is already in use by another process.`);
      console.error(`  Please stop the existing process or change the PORT environment variable.\n`);
      process.exit(1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
