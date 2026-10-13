'use strict';

const express = require('express');
const compression = require('compression');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/* Configuration (see .env.example) */

const PORT = Number(process.env.PORT) || 3000;
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';
const FFMPEG_LOCATION = process.env.FFMPEG_LOCATION || '';
const COOKIES_FILE = process.env.YTDLP_COOKIES || '';
const PROXY = process.env.YTDLP_PROXY || '';
const MAX_FILESIZE = process.env.MAX_FILESIZE || '';
const MAX_JOBS = Number(process.env.MAX_JOBS) || 3;
const TRUST_PROXY = process.env.TRUST_PROXY || '';
const INFO_TIMEOUT_MS = 45 * 1000;
const PREPARE_TIMEOUT_MS = 15 * 60 * 1000;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const AFTER_SERVE_TTL_MS = 2 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TMP_ROOT = path.join(os.tmpdir(), 'getclip');

const THUMB_HOSTS = ['ytimg.com', 'ggpht.com', 'googleusercontent.com', 'cdninstagram.com', 'fbcdn.net'];
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const IG_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am']);

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* URL validation */

function parseSupportedUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let text = raw.trim();
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text;

  let u;
  try { u = new URL(text); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;

  const host = u.hostname.toLowerCase();
  const p = u.pathname;
  let platform = null;

  if (YT_HOSTS.has(host)) {
    if (host === 'youtu.be') {
      if (/^\/[\w-]{11}/.test(p)) platform = 'youtube';
    } else if (p === '/watch' && /^[\w-]{11}$/.test(u.searchParams.get('v') || '')) {
      platform = 'youtube';
    } else if (/^\/(shorts|live|embed)\/[\w-]{11}/.test(p)) {
      platform = 'youtube';
    }
  } else if (IG_HOSTS.has(host)) {
    if (/^\/(p|reel|reels|tv)\/[\w-]+/.test(p)
      || /^\/[\w.]+\/(p|reel|tv)\/[\w-]+/.test(p)
      || /^\/stories\/[\w.]+\/\d+/.test(p)
      || /^\/share\/(reel|p)\/[\w-]+/.test(p)) {
      platform = 'instagram';
    }
  }

  if (!platform) return null;
  return { platform, url: u.toString() };
}

/* yt-dlp wrapper */

function baseArgs() {
  const args = ['--no-warnings', '--no-playlist', '--playlist-items', '1', '--socket-timeout', '20', '--retries', '3'];
  if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);
  if (PROXY) args.push('--proxy', PROXY);
  if (FFMPEG_LOCATION) args.push('--ffmpeg-location', FFMPEG_LOCATION);
  return args;
}

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    const err = [];
    let outSize = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new AppError(504, 'timeout', 'The source took too long to respond. Please try again.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      outSize += chunk.length;
      if (outSize > 25 * 1024 * 1024) child.kill('SIGKILL');
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk) => { if (err.length < 400) err.push(chunk); });

    child.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (e.code === 'ENOENT') {
        reject(new AppError(503, 'engine_missing', 'The download engine is not installed on the server.'));
      } else {
        reject(e);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

function mapError(stderr) {
  const s = String(stderr || '').toLowerCase();
  const firstLine = String(stderr || '').split('\n').find((l) => l.trim()) || '';
  console.error('[yt-dlp]', firstLine.slice(0, 300));

  if (s.includes('ffmpeg') && (s.includes('not found') || s.includes('not installed'))) {
    return new AppError(503, 'ffmpeg_missing', 'The server is missing ffmpeg, which is needed for this format.');
  }
  if (s.includes('private video') || s.includes('this video is private')) {
    return new AppError(403, 'private', 'This video is private and cannot be downloaded.');
  }
  if (s.includes('confirm your age') || s.includes('age-restricted') || s.includes('age restricted')) {
    return new AppError(403, 'age_restricted', 'This video is age restricted and cannot be downloaded.');
  }
  if (s.includes('not a bot') || s.includes('confirm you')) {
    return new AppError(503, 'verification', 'YouTube asked the server to verify it is not a bot. Please try again later.');
  }
  if (s.includes('login required') || s.includes('requires login') || s.includes('not logged in') || s.includes('log in')) {
    return new AppError(403, 'login_required', 'This content requires a login, so it is probably private or restricted. Only public content can be downloaded.');
  }
  if (s.includes('live event') || s.includes('is live') || s.includes('premieres in')) {
    return new AppError(422, 'live', 'Live streams and premieres cannot be downloaded until they have ended.');
  }
  if (s.includes('there is no video in this post') || s.includes('no video formats')) {
    return new AppError(422, 'no_video', 'No video was found at this link. Photo posts are not supported.');
  }
  if (s.includes('video unavailable') || s.includes('has been removed') || s.includes('not available') || s.includes('does not exist') || s.includes('404')) {
    return new AppError(404, 'unavailable', 'This video is unavailable. It may have been removed or restricted in the server region.');
  }
  if (s.includes('unsupported url')) {
    return new AppError(400, 'unsupported_url', 'This link is not supported.');
  }
  if (s.includes('429') || s.includes('too many requests') || s.includes('rate-limit') || s.includes('rate limit')) {
    return new AppError(429, 'source_rate_limited', 'The source is limiting requests right now. Please try again in a few minutes.');
  }
  if (s.includes('file is larger than max-filesize') || s.includes('max-filesize')) {
    return new AppError(413, 'too_large', 'This file is larger than the size limit this server allows.');
  }
  return new AppError(502, 'fetch_failed', 'Could not fetch this link. Check the link and try again.');
}

/* Concurrency and rate limiting */

let activeJobs = 0;
async function withSlot(fn) {
  if (activeJobs >= MAX_JOBS) {
    throw new AppError(503, 'busy', 'The server is busy right now. Please try again in a moment.');
  }
  activeJobs += 1;
  try { return await fn(); } finally { activeJobs -= 1; }
}

const buckets = new Map();
function rateLimit(name, limit, windowMs = 60 * 1000) {
  return (req, res, next) => {
    const key = name + ':' + req.ip;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset < now) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.reset - now) / 1000)));
      return next(new AppError(429, 'rate_limited', 'Too many requests. Please wait a minute and try again.'));
    }
    return next();
  };
}

/* Building the list of options from yt-dlp metadata */

const sizeOf = (f) => f.filesize || f.filesize_approx || 0;

function labelFor(f) {
  const note = /^(\d{3,4})p/.exec(f.format_note || '');
  if (note) return Number(note[1]);
  const short = Math.min(f.width || f.height, f.height);
  return short;
}

function resolutionName(p) {
  if (p >= 2160) return '2160p (4K)';
  if (p >= 1440) return '1440p (2K)';
  return p + 'p';
}

function buildOptions(platform, meta) {
  const formats = Array.isArray(meta.formats) ? meta.formats : [];
  const hasVideo = (f) => f.vcodec && f.vcodec !== 'none' && f.height;
  const audioOnly = (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none');

  const videos = formats.filter(hasVideo);
  const audios = formats.filter(audioOnly).sort((a, b) => (b.abr || 0) - (a.abr || 0));
  const bestAudio = audios[0];
  const bestAudioSize = bestAudio ? sizeOf(bestAudio) : 0;

  const videoOptions = [];

  if (platform === 'youtube') {
    const byLabel = new Map();
    videos.forEach((f) => {
      const label = labelFor(f);
      if (!label || label < 100) return;
      const current = byLabel.get(label);
      if (!current || sizeOf(f) > sizeOf(current.best)) {
        byLabel.set(label, { best: f, fps: Math.max(f.fps || 0, current ? current.fps : 0) });
      } else {
        current.fps = Math.max(current.fps, f.fps || 0);
      }
    });
    [...byLabel.entries()].sort((a, b) => b[0] - a[0]).forEach(([label, entry]) => {
      const f = entry.best;
      const muxed = f.acodec && f.acodec !== 'none';
      const total = sizeOf(f) ? sizeOf(f) + (muxed ? 0 : bestAudioSize) : 0;
      videoOptions.push({
        label: resolutionName(label),
        note: entry.fps > 30 ? 'Video, ' + Math.round(entry.fps) + ' fps' : 'Video',
        size: total,
        request: { kind: 'video', height: f.height }
      });
    });
  } else {
    const sorted = [...videos].sort((a, b) => (b.height - a.height) || ((b.tbr || 0) - (a.tbr || 0)));
    const hd = sorted[0];
    const sd = sorted[sorted.length - 1];
    if (hd) {
      videoOptions.push({
        label: 'HD',
        note: hd.width ? hd.width + 'x' + hd.height + ', MP4' : 'MP4',
        size: sizeOf(hd) ? sizeOf(hd) + (hd.acodec && hd.acodec !== 'none' ? 0 : bestAudioSize) : 0,
        request: { kind: 'video', tier: 'hd' }
      });
      if (sd && (sd.height < hd.height || ((sd.tbr || 0) && (sd.tbr || 0) < (hd.tbr || 0) * 0.8))) {
        videoOptions.push({
          label: 'SD',
          note: sd.width ? sd.width + 'x' + sd.height + ', MP4' : 'MP4',
          size: sizeOf(sd) ? sizeOf(sd) + (sd.acodec && sd.acodec !== 'none' ? 0 : bestAudioSize) : 0,
          request: { kind: 'video', tier: 'sd' }
        });
      }
    }
  }

  if (!videoOptions.length) {
    throw new AppError(422, 'no_video', 'No video was found at this link. Photo posts are not supported.');
  }

  const audioOptions = [];
  if (platform === 'youtube') {
    [64, 128, 320].forEach((bitrate) => {
      audioOptions.push({
        label: 'MP3 ' + bitrate + ' kbps',
        note: 'Encoded from source audio',
        size: meta.duration ? Math.round((bitrate * 1000 / 8) * meta.duration) : 0,
        request: { kind: 'audio', format: 'mp3', bitrate }
      });
    });
    const hasM4a = audios.some((f) => f.ext === 'm4a');
    audioOptions.push({
      label: 'M4A',
      note: hasM4a ? 'Original audio stream' : 'Converted to AAC',
      size: bestAudioSize,
      request: { kind: 'audio', format: 'm4a' }
    });
  } else {
    audioOptions.push({
      label: 'M4A',
      note: 'Audio extracted from the video',
      size: 0,
      request: { kind: 'audio', format: 'm4a' }
    });
    audioOptions.push({
      label: 'MP3 192 kbps',
      note: 'Encoded from source audio',
      size: meta.duration ? Math.round((192 * 1000 / 8) * meta.duration) : 0,
      request: { kind: 'audio', format: 'mp3', bitrate: 192 }
    });
  }

  return { videoOptions, audioOptions };
}

function pickThumbnail(meta) {
  let url = meta.thumbnail;
  if (!url && Array.isArray(meta.thumbnails) && meta.thumbnails.length) {
    url = meta.thumbnails[meta.thumbnails.length - 1].url;
  }
  if (typeof url !== 'string' || !url.startsWith('https://')) return '';
  return '/api/thumb?u=' + encodeURIComponent(url);
}

/* Download specification */

function parseSpec(body) {
  const bad = () => new AppError(400, 'bad_request', 'That format is not valid. Reload the page and try again.');
  if (!body || typeof body !== 'object') throw bad();

  if (body.kind === 'video') {
    if (body.tier !== undefined) {
      if (body.tier !== 'hd' && body.tier !== 'sd') throw bad();
      return { kind: 'video', tier: body.tier };
    }
    const height = Number(body.height);
    if (!Number.isInteger(height) || height < 100 || height > 4500) throw bad();
    return { kind: 'video', height };
  }

  if (body.kind === 'audio') {
    if (body.format === 'm4a') return { kind: 'audio', format: 'm4a' };
    if (body.format === 'mp3') {
      const bitrate = Number(body.bitrate);
      if (![64, 128, 192, 256, 320].includes(bitrate)) throw bad();
      return { kind: 'audio', format: 'mp3', bitrate };
    }
  }
  throw bad();
}

function formatArgs(spec) {
  if (spec.kind === 'video') {
    if (spec.height) {
      const h = spec.height;
      return ['-f', 'bv*[height=' + h + ']+ba/b[height=' + h + ']', '-S', 'ext:mp4:m4a', '--merge-output-format', 'mp4/mkv'];
    }
    if (spec.tier === 'hd') {
      return ['-f', 'bv*+ba/b', '-S', 'res,ext:mp4:m4a', '--merge-output-format', 'mp4/mkv'];
    }
    return ['-f', 'wv*+wa/w', '-S', 'res,ext:mp4:m4a', '--merge-output-format', 'mp4/mkv'];
  }
  if (spec.format === 'm4a') {
    return ['-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a'];
  }
  return ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', spec.bitrate + 'K'];
}

/* Prepared files */

const jobs = new Map();

async function removeJob(token) {
  const job = jobs.get(token);
  if (!job) return;
  jobs.delete(token);
  try { await fsp.rm(job.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

const MIME = {
  mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4'
};

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
}

/* App */

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  next();
});

app.use(compression());

const json = express.json({ limit: '4kb' });

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/info', json, rateLimit('info', 20), async (req, res, next) => {
  try {
    const parsed = parseSupportedUrl(req.body && req.body.url);
    if (!parsed) {
      throw new AppError(400, 'unsupported_url', 'This link is not supported. Use a YouTube video or Shorts link, or an Instagram Reel, post or story link.');
    }

    const r = await withSlot(() => run([...baseArgs(), '-J', '--', parsed.url], INFO_TIMEOUT_MS));
    if (r.code !== 0 || !r.stdout) throw mapError(r.stderr);

    let meta;
    try { meta = JSON.parse(r.stdout); } catch (e) { throw new AppError(502, 'bad_metadata', 'Could not read the video details. Please try again.'); }
    if (Array.isArray(meta.entries)) meta = meta.entries.find(Boolean) || {};
    if (meta.is_live) throw new AppError(422, 'live', 'Live streams cannot be downloaded until they have ended.');

    const { videoOptions, audioOptions } = buildOptions(parsed.platform, meta);
    res.json({
      platform: parsed.platform,
      title: String(meta.title || '').slice(0, 300),
      uploader: String(meta.uploader || meta.channel || '').slice(0, 120),
      duration: Number(meta.duration) || 0,
      thumbnail: pickThumbnail(meta),
      videoOptions,
      audioOptions
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/prepare', json, rateLimit('prepare', 10), async (req, res, next) => {
  let dir;
  try {
    const parsed = parseSupportedUrl(req.body && req.body.url);
    if (!parsed) throw new AppError(400, 'unsupported_url', 'This link is not supported.');
    const spec = parseSpec(req.body);

    await fsp.mkdir(TMP_ROOT, { recursive: true });
    dir = await fsp.mkdtemp(path.join(TMP_ROOT, 'job-'));

    const args = [
      ...baseArgs(),
      ...formatArgs(spec),
      '--windows-filenames', '--no-mtime', '--no-part',
      '-o', path.join(dir, '%(title).100B.%(ext)s')
    ];
    if (MAX_FILESIZE) args.push('--max-filesize', MAX_FILESIZE);
    args.push('--', parsed.url);

    const r = await withSlot(() => run(args, PREPARE_TIMEOUT_MS));
    if (r.code !== 0) throw mapError(r.stderr);

    const files = (await fsp.readdir(dir)).filter((n) => !/\.(part|ytdl|temp)$/i.test(n));
    if (!files.length) throw new AppError(502, 'no_output', 'The file could not be created. Please try again.');

    let chosen = null;
    for (const name of files) {
      const stat = await fsp.stat(path.join(dir, name));
      if (!chosen || stat.size > chosen.size) chosen = { name, size: stat.size };
    }
    if (!chosen || chosen.size === 0) throw new AppError(502, 'empty_output', 'The file came out empty. Please try again.');

    const ext = path.extname(chosen.name).slice(1).toLowerCase();
    const token = crypto.randomBytes(18).toString('base64url');
    jobs.set(token, {
      dir,
      file: path.join(dir, chosen.name),
      name: chosen.name,
      size: chosen.size,
      mime: MIME[ext] || 'application/octet-stream',
      expires: Date.now() + TOKEN_TTL_MS
    });
    dir = null;

    res.json({ downloadUrl: '/api/file/' + token, filename: chosen.name, size: chosen.size });
  } catch (err) {
    if (dir) fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    next(err);
  }
});

app.get('/api/file/:token', (req, res) => {
  const job = jobs.get(req.params.token);
  if (!job || job.expires < Date.now()) {
    return res.status(404).json({ error: { code: 'expired', message: 'This download has expired. Prepare the file again.' } });
  }

  res.setHeader('Content-Type', job.mime);
  res.setHeader('Content-Length', String(job.size));
  res.setHeader('Content-Disposition', contentDisposition(job.name));
  res.setHeader('Cache-Control', 'no-store');

  const stream = fs.createReadStream(job.file);
  stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  res.on('close', () => { job.expires = Math.min(job.expires, Date.now() + AFTER_SERVE_TTL_MS); });
  stream.pipe(res);
});

app.get('/api/thumb', rateLimit('thumb', 120), async (req, res) => {
  try {
    const u = new URL(String(req.query.u || ''));
    const allowed = THUMB_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
    if (u.protocol !== 'https:' || u.port || !allowed) return res.status(400).end();

    const upstream = await fetch(u, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Getclip/1.0)' }
    });
    const type = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !/^image\/(jpeg|png|webp|gif|avif)/.test(type)) return res.status(502).end();

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return res.status(502).end();

    res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
    return res.send(buf);
  } catch (e) {
    return res.status(502).end();
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
});

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    err = new AppError(400, 'bad_request', 'The request could not be read.');
  }
  if (!(err instanceof AppError)) {
    console.error(err);
    err = new AppError(500, 'server_error', 'Something went wrong on the server. Please try again.');
  }
  res.status(err.status).json({ error: { code: err.code, message: err.message } });
});

/* Housekeeping */

setInterval(() => {
  const now = Date.now();
  for (const [token, job] of jobs) {
    if (job.expires < now) removeJob(token);
  }
  for (const [key, bucket] of buckets) {
    if (bucket.reset < now) buckets.delete(key);
  }
}, 30 * 1000).unref();

// Clear leftovers from a previous run.
fsp.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});

app.listen(PORT, () => {
  console.log('Getclip listening on http://localhost:' + PORT);
});