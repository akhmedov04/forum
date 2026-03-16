# PLOV//CHAN — Local Network Forum

A self-hosted forum designed for LAN communities. Built with Node.js, Express, SQLite, and a cyberpunk-themed single-page frontend.

## Quick Start

```bash
npm install
npm start
```

Default admin: `admin` / `admin1234` — **change immediately after first login!**

## Security Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | random (per restart) | **Set this in production!** Session encryption key |
| `PORT` | 3000 | Server port |
| `HOST` | 0.0.0.0 | Bind address |
| `NODE_ENV` | development | Set to `production` for secure cookies & hidden errors |

### Production Deployment

```bash
export SESSION_SECRET="your-long-random-secret-here"
export NODE_ENV=production
npm start
```

## Security Features

- **Rate limiting** on auth (10/15min), posts (5/min), uploads (5/min), search (20/min)
- **Session freshness** — banned/deleted users are kicked immediately
- **Bcrypt** with cost factor 12 for password hashing
- **Security headers** (X-Content-Type-Options, X-Frame-Options, CSP, etc.)
- **Input validation** — body size limits, ID parameter validation, search length caps
- **Upload security** — MIME whitelist, metadata stripping, 5MB limit, WebP conversion
- **View count protection** — only counted once per session per thread
- **Gzip compression** for all responses
- **Static file caching** with proper cache headers

## Features

- Multi-language support (EN/RU/UZ)
- Image uploads with auto-resize/compression
- Admin panel with user/board management
- Banned word filter
- Thread pinning, locking, moving
- Role system: admin, moderator, member, banned
- Responsive cyberpunk UI

## Tech Stack

- **Backend:** Express.js, SQLite (WAL mode), bcryptjs, sharp
- **Frontend:** Vanilla JS SPA, CSS custom properties
- **No external CSS/JS frameworks** — fully self-contained for LAN use
