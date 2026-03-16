const db = require('../db/init');

// Cache banned words, refresh every 60 seconds
let cachedWords = [];
let lastFetch   = 0;

async function getBannedWords() {
  const now = Date.now();
  if (now - lastFetch > 60_000 || cachedWords.length === 0 && lastFetch === 0) {
    const rows  = await db.all('SELECT word FROM banned_words');
    cachedWords = rows.map(r => r.word.toLowerCase());
    lastFetch   = now;
  }
  return cachedWords;
}

// Invalidate cache (call after adding/removing words)
function invalidateCache() {
  lastFetch = 0;
}

// Replace banned words in text with ***
async function filterText(text) {
  if (!text) return text;
  const words = await getBannedWords();
  if (words.length === 0) return text;

  let result = text;
  for (const word of words) {
    // Match whole word, case-insensitive, Unicode-safe
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\wа-яА-ЯёЁa-zA-Z0-9])${escaped}(?![\\wа-яА-ЯёЁa-zA-Z0-9])`, 'gi');
    result = result.replace(re, '*'.repeat(word.length));
  }
  return result;
}

module.exports = { filterText, invalidateCache };
