#!/usr/bin/env node
/**
 * Build the "Moments" gallery for life.html.
 *
 * Scans assets/images/life/** (excluding the generated `optimized/` folder),
 * reads EXIF capture time + GPS, exports web-optimized WebP images plus tiny
 * blur-up placeholders, and writes data/life.json.
 *
 * Usage:
 *   npm install
 *   node scripts/build-life.js                # geocodes unknown locations via Nominatim
 *   node scripts/build-life.js --no-geocode   # offline: unknown coords show as lat,lon
 *
 * Requirements: Node 18+ (global fetch).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const convert = require('heic-convert');
const exifr = require('exifr');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const LIFE_DIR = path.join(ROOT, 'assets/images/life');
const OUT_DIR = path.join(LIFE_DIR, 'optimized');
const DATA_FILE = path.join(ROOT, 'data/life.json');
const GEOCODE_CACHE = path.join(__dirname, '.geocode-cache.json');

const MAX_PX = 2000;          // longest side of the exported image
const WEBP_QUALITY = 82;      // exported image quality
const LQIP_PX = 32;           // blur-up placeholder longest side
const LQIP_QUALITY = 45;

// Display name + ordering of the topic folders (unknown folders are appended).
const CATEGORY_LABELS = { cats: 'Cats', japan: 'Japan', landscape: 'Landscape', love: 'Love' };
const CATEGORY_ORDER = ['cats', 'japan', 'landscape', 'love'];

// GPS may be absent; assign a known location to specific files by base name.
const NO_GPS_RULES = [
  { test: (base) => /^cat\d/.test(base), location: 'Peking University, Beijing' }
];

// Offline place lookup. First matching rule wins. Bounds are intentionally loose.
const PLACES = [
  { name: 'Peking University, Beijing', test: (lat, lon) => lat > 39.97 && lat < 40.00 && lon > 116.29 && lon < 116.32 },
  { name: 'Haidian, Beijing',           test: (lat, lon) => lat > 39.90 && lat < 40.02 && lon >= 116.32 && lon < 116.42 },
  { name: 'Changping, Beijing',         test: (lat, lon) => lat > 40.00 && lat < 40.40 && lon > 116.00 && lon < 116.40 },
  { name: 'Kobe, Japan',                test: (lat, lon) => lat > 34.50 && lat < 34.90 && lon > 135.00 && lon < 135.50 },
  { name: 'Nara, Japan',                test: (lat, lon) => lat > 34.50 && lat < 34.90 && lon > 135.60 && lon < 136.10 },
  { name: 'Shanghai, China',            test: (lat, lon) => lat > 30.50 && lat < 31.80 && lon > 121.00 && lon < 122.00 }
];

const GEODECODE = !process.argv.includes('--no-geocode');
const IMAGE_RE = /\.(heic|heif|jpg|jpeg|png|tiff?|webp|avif)$/i;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const NOMINATIM_UA = 'life-gallery-build/1.0 (personal site; contact: site owner)';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const toPosix = (p) => p.split(path.sep).join('/');

function titleCase(s) {
  return String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function categoryOf(abs) {
  const parts = path.relative(LIFE_DIR, abs).split(path.sep);
  if (parts.length < 2) return 'other';
  return parts[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'optimized') out.push(...walk(p));
    } else if (IMAGE_RE.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function isHeic(buf) {
  return buf.length > 12 &&
    buf.toString('ascii', 4, 8) === 'ftyp' &&
    ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs']
      .includes(buf.toString('ascii', 8, 12));
}

// exifr returns Devices dates normalised to UTC; convert back to camera-local
// wall-clock time using OffsetTimeOriginal when present.
function localParts(exif) {
  if (!exif) return null;
  const raw = exif.DateTimeOriginal || exif.CreateDate;
  if (!raw) return null;
  if (raw instanceof Date) {
    let t = raw.getTime();
    const off = exif.OffsetTimeOriginal || exif.OffsetTime;
    if (typeof off === 'string' && /^[+-]\d{2}:\d{2}$/.test(off)) {
      const sign = off[0] === '-' ? -1 : 1;
      const [oh, om] = off.slice(1).split(':').map(Number);
      t += sign * (oh * 60 + om) * 60000;
    }
    const d = new Date(t);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  const m = String(raw).match(/(\d{4})[-:/](\d{2})[-:/](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], day: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(GEOCODE_CACHE, 'utf8')); } catch (e) { return {}; }
}
function saveCache(cache) {
  try { fs.writeFileSync(GEOCODE_CACHE, JSON.stringify(cache, null, 2) + '\n'); } catch (e) {}
}

async function reverseGeocode(lat, lon, cache) {
  const key = lat.toFixed(4) + ',' + lon.toFixed(4);
  if (cache[key]) return cache[key];
  const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=en' +
    '&lat=' + lat + '&lon=' + lon;
  const res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
  if (!res.ok) throw new Error('Nominatim HTTP ' + res.status);
  const j = await res.json();
  const a = j.address || {};
  const city = a.city || a.town || a.village || a.county || a.state || '';
  const country = a.country || '';
  const name = [city, country].filter(Boolean).join(', ') || j.display_name || (lat.toFixed(3) + ', ' + lon.toFixed(3));
  cache[key] = name;
  saveCache(cache);
  await sleep(1100); // respect Nominatim's 1 req/sec policy
  return name;
}

async function resolveLocation(item, cache) {
  if (!item.hasGPS) {
    for (const rule of NO_GPS_RULES) if (rule.test(item.base)) return rule.location;
    return '';
  }
  for (const place of PLACES) if (place.test(item.lat, item.lon)) return place.name;
  if (GEODECODE) {
    try { return await reverseGeocode(item.lat, item.lon, cache); }
    catch (e) { console.warn('  ! geocode failed for ' + item.lat + ',' + item.lon + ': ' + e.message); }
  }
  return item.lat.toFixed(4) + ', ' + item.lon.toFixed(4);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async function main() {
  if (typeof fetch !== 'function') {
    console.error('Node 18+ is required (global fetch missing).');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = walk(LIFE_DIR).sort();
  if (!files.length) {
    console.error('No images found under ' + LIFE_DIR);
    process.exit(1);
  }

  const cache = loadCache();
  const photos = [];
  const kept = new Set();
  let failed = 0;

  for (const abs of files) {
    const rel = toPosix(path.relative(ROOT, abs));
    const base = path.basename(abs, path.extname(abs));
    const outName = base + '.webp';
    kept.add(outName);

    try {
      const buf = fs.readFileSync(abs);

      let meta = null;
      try { meta = await exifr.parse(buf); }
      catch (e) { /* images without EXIF are fine */ }

      const work = isHeic(buf) ? await convert({ buffer: buf, format: 'JPEG', quality: 0.92 }) : buf;

      const info = await sharp(work)
        .rotate()
        .resize(MAX_PX, MAX_PX, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toFile(path.join(OUT_DIR, outName));

      const lqip = await sharp(work).rotate().resize(LQIP_PX, LQIP_PX, { fit: 'inside' })
        .webp({ quality: LQIP_QUALITY }).toBuffer();

      const parts = localParts(meta);
      const date = parts ? `${parts.y}-${pad(parts.mo)}-${pad(parts.day)}T${pad(parts.h)}:${pad(parts.mi)}:${pad(parts.s)}` : '';
      const dateLabel = parts ? `${parts.day} ${MONTHS[parts.mo - 1]} ${parts.y}` : '';
      const hasGPS = !!(meta && typeof meta.latitude === 'number' && typeof meta.longitude === 'number');

      photos.push({
        id: base,
        src: toPosix(path.relative(ROOT, path.join(OUT_DIR, outName))),
        full: rel,
        lqip: 'data:image/webp;base64,' + lqip.toString('base64'),
        w: info.width,
        h: info.height,
        location: '',
        category: categoryOf(abs),
        date,
        dateLabel,
        year: parts ? parts.y : 0,
        _lat: hasGPS ? meta.latitude : null,
        _lon: hasGPS ? meta.longitude : null,
        _hasGPS: hasGPS
      });

      console.log('  ' + base.padEnd(14) + (info.width + 'x' + info.height).padEnd(11) +
        categoryOf(abs).padEnd(11) + (fs.statSync(path.join(OUT_DIR, outName)).size / 1024).toFixed(0) + 'KB');
    } catch (e) {
      failed++;
      console.error('  ! failed ' + rel + ': ' + e.message);
    }
  }

  // Assign locations (may hit the network for unknown coordinates).
  for (const p of photos) {
    p.location = await resolveLocation({ base: p.id, hasGPS: p._hasGPS, lat: p._lat, lon: p._lon }, cache);
    delete p._lat; delete p._lon; delete p._hasGPS;
  }

  // Remove optimized files whose source no longer exists.
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith('.webp') && !kept.has(f)) {
      fs.unlinkSync(path.join(OUT_DIR, f));
      console.log('  - removed stale ' + f);
    }
  }

  // Newest first, undated last.
  photos.sort((a, b) => (a.date === b.date) ? a.id.localeCompare(b.id) : (a.date < b.date ? 1 : -1));

  const present = [];
  photos.forEach((p) => { if (present.indexOf(p.category) === -1) present.push(p.category); });
  const ordered = CATEGORY_ORDER.filter((c) => present.includes(c))
    .concat(present.filter((c) => !CATEGORY_ORDER.includes(c)));
  const categories = [{ id: 'all', label: 'All' }].concat(
    ordered.map((id) => ({ id, label: CATEGORY_LABELS[id] || titleCase(id) }))
  );

  const payload = { generatedAt: new Date().toISOString(), categories, photos };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2) + '\n');

  const counts = {};
  photos.forEach((p) => { counts[p.category] = (counts[p.category] || 0) + 1; });
  console.log('\nWrote ' + photos.length + ' photos to ' + path.relative(ROOT, DATA_FILE));
  console.log('Categories: ' + categories.map((c) => c.label + '(' + (c.id === 'all' ? photos.length : counts[c.id] || 0) + ')').join(', '));
  if (failed) console.warn(failed + ' file(s) failed — see above.');
})().catch((e) => { console.error(e); process.exit(1); });
