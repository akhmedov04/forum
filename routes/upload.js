const express  = require('express');
const multer   = require('multer');
const sharp    = require('sharp');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const { requireAuth, requireNotBanned } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MAX_SIZE = 5 * 1024 * 1024; // 5MB (reduced from 10MB)

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: 1 },
  fileFilter(req, file, cb) {
    if (ALLOWED_MIMES.has(file.mimetype.toLowerCase())) cb(null, true);
    else cb(new Error('Only image files allowed (JPEG, PNG, GIF, WebP)'));
  }
});

router.post('/', requireAuth, requireNotBanned, uploadLimiter, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File is too large. Maximum size is 5MB.' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const id       = crypto.randomBytes(12).toString('hex');
    const filename = `${id}.webp`;
    const outPath  = path.join(UPLOADS_DIR, filename);

    await sharp(req.file.buffer)
      .rotate()                     // Auto-rotate from EXIF
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .removeAlpha()                // Strip alpha where not needed
      .webp({ quality: 82, effort: 4 })
      .toFile(outPath);

    const stat = fs.statSync(outPath);
    res.json({ url: `/uploads/${filename}`, size: stat.size, original: req.file.originalname });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
