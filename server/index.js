const express = require('express')
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')

const app = express()
app.set('etag', 'strong')
const MARKDOWN_DIR = process.env.MD_DIR
  ? path.resolve(process.env.MD_DIR)
  : path.join(__dirname, '../')
const PUBLIC_DIR = path.join(__dirname, '../dist')

const TTS_API_URL = process.env.TTS_API_URL || ''
const TTS_API_KEY = process.env.TTS_API_KEY || ''
const TTS_MODEL = process.env.TTS_MODEL || 'qwen'

function resolveAsset(dir, prefix, pattern) {
  const files = fs.readdirSync(path.join(PUBLIC_DIR, dir))
  const match = files.find(f => f.match(pattern))
  return match ? `/${dir}/${match}` : `/${dir}/${prefix}`
}

const JS_BUNDLE = resolveAsset(
  'js',
  'web-main.js',
  /^web-main\.[a-f0-9]{8}\.js$/,
)
const CSS_BUNDLE = resolveAsset(
  'css',
  'web-main.css',
  /^web-main\.[a-f0-9]{8}\.css$/,
)

const INDEX_HTML_RAW = fs
  .readFileSync(path.join(__dirname, 'index.html'), 'utf8')
  .replace('<!-- CSS_BUNDLE -->', CSS_BUNDLE)
  .replace('<!-- JS_BUNDLE -->', JS_BUNDLE)

app.use(
  express.static(PUBLIC_DIR, {
    maxAge: '365d',
    immutable: true,
    setHeaders: (res, fp) => {
      if (path.basename(fp) === 'index.html') {
        res.setHeader('Cache-Control', 'no-cache')
      }
    },
  }),
)

app.use(
  '/raw',
  express.static(MARKDOWN_DIR, {
    setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
  }),
)

app.get('/api/dir', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache')
  const rawDir = req.query.path || '/'
  const relDir = rawDir === '/' ? '/' : rawDir.replace(/\/+$/, '')
  const absDir = path.join(MARKDOWN_DIR, relDir)

  if (!absDir.startsWith(MARKDOWN_DIR)) {
    return res.status(403).json({ error: 'Access denied' })
  }

  fs.readdir(absDir, { withFileTypes: true }, (err, entries) => {
    if (err) {
      return res.status(404).json({ error: 'Directory not found' })
    }

    const prefix = relDir === '/' ? '/' : relDir + '/'
    const files = []
    const dirs = []

    if (relDir !== '/') {
      const parentDir = path.dirname(relDir)
      dirs.push({
        name: '..',
        path: parentDir === '.' ? '/' : parentDir,
        isDirectory: true,
      })
    }

    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(entry => {
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'dist'
        )
          return
        const entryPath = prefix + entry.name
        if (entry.isDirectory()) {
          dirs.push({ name: entry.name, path: entryPath, isDirectory: true })
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push({ name: entry.name, path: entryPath, isDirectory: false })
        }
      })

    res.json({ currentDir: relDir, dirs, files })
  })
})

app.post('/api/tts', express.json({ limit: '2mb' }), async (req, res) => {
  const { text, voice } = req.body || {}
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' })
  }
  if (!TTS_API_URL || !TTS_API_KEY) {
    return res
      .status(503)
      .json({ error: 'TTS service is not configured on the server' })
  }

  let ttsRes
  try {
    ttsRes = await fetch(TTS_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TTS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        input: text,
        voice: voice || 'alloy',
      }),
    })
  } catch (e) {
    return res
      .status(502)
      .json({ error: 'TTS upstream unreachable: ' + e.message })
  }

  if (!ttsRes.ok) {
    const errBody = await ttsRes.text().catch(() => '')
    return res
      .status(ttsRes.status)
      .json({ error: 'TTS request failed', detail: errBody })
  }

  res.setHeader('Content-Type', 'audio/wav')
  res.setHeader('Cache-Control', 'no-cache')

  const cleanup = () => {
    try {
      ttsRes.body.cancel()
    } catch (_) {
      /* noop */
    }
  }
  req.on('close', cleanup)

  try {
    Readable.fromWeb(ttsRes.body).pipe(res)
  } catch (e) {
    cleanup()
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream pipe failed: ' + e.message })
    }
  }
})

const sendIndex = (req, res) => {
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(INDEX_HTML_RAW)
}

app.use((req, res, next) => {
  if (req.path.endsWith('.md')) {
    return sendIndex(req, res)
  }
  const absPath = path.join(MARKDOWN_DIR, req.path)
  fs.stat(absPath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      return sendIndex(req, res)
    }
    next()
  })
})

app.get('/', sendIndex)

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Markdown Web Server is running on http://localhost:${PORT}`)
})
