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

app.get('/api/tts/config', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache')

  const clientApiUrl = req.query.apiUrl
  const clientApiKey = req.query.apiKey
  const baseUrl = (clientApiUrl || TTS_API_URL || '').replace(
    /\/audio\/speech\/?$/,
    '',
  )
  const key = clientApiKey || TTS_API_KEY

  const fallback = {
    serverConfigured: !!(TTS_API_URL && TTS_API_KEY),
    defaultModel: TTS_MODEL,
    models: [],
    voices: [],
  }

  if (!baseUrl || !key) {
    return res.json(fallback)
  }

  try {
    const authHdr = { Authorization: `Bearer ${key}` }
    const [modelsResp, voicesResp] = await Promise.all([
      fetch(`${baseUrl}/models`, { headers: authHdr }),
      fetch(`${baseUrl}/audio/voices`, { headers: authHdr }),
    ])

    let models = []
    let voices = []

    if (modelsResp.ok) {
      const md = await modelsResp.json()
      models = (md.data || []).map(m => m.id)
    }

    if (voicesResp.ok) {
      const vd = await voicesResp.json()
      voices = (Array.isArray(vd) ? vd : vd.data || []).map(v => {
        if (v.ShortName) {
          return {
            id: v.ShortName,
            name: v.FriendlyName || v.ShortName,
            engine: v.engine || 'edge',
            locale: v.Locale || '',
            gender: v.Gender || '',
          }
        }
        return {
          id: v.id,
          name: v.name || v.id,
          engine: v.engine || '',
          locale: v.locale || v.language || '',
          gender: v.Gender || '',
        }
      })
    }

    res.json({
      serverConfigured: !!(TTS_API_URL && TTS_API_KEY),
      defaultModel: TTS_MODEL,
      models,
      voices,
    })
  } catch (e) {
    res.json({
      ...fallback,
      error: 'Failed to fetch from TTS API: ' + e.message,
    })
  }
})

/* Segment + normalize proxy.  Forwards to edge-tts /api/v1/tts/segment.
 * Path derivation: audio/speech (openai router, no prefix) -> /v1/audio/speech;
 * segment (tts router, prefix /api/v1) -> /api/v1/tts/segment.  Both share the
 * same tunnel base, so strip the audio/speech suffix and append the segment path. */
app.post(
  '/api/tts/segment',
  express.json({ limit: '2mb' }),
  async (req, res) => {
    const { text, language, normalize, apiUrl, apiKey } = req.body || {}
    if (text == null || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' })
    }
    if (text.trim() === '') {
      return res.json({ sentences: [] })
    }
    const base = (apiUrl || TTS_API_URL || '').replace(
      /\/v1\/audio\/speech\/?$/,
      '',
    )
    const segUrl = base + '/api/v1/tts/segment'
    const key = apiKey || TTS_API_KEY
    if (!base || !key) {
      return res.status(503).json({
        error:
          'TTS segment endpoint not configured (set apiUrl/apiKey in Settings, or TTS_API_URL/TTS_API_KEY on the server).',
      })
    }
    try {
      const upstream = await fetch(segUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          language: language || 'chinese',
          normalize: normalize || 'llm',
        }),
      })
      const data = await upstream.json()
      if (!upstream.ok) return res.status(upstream.status).json(data)
      return res.json(data)
    } catch (e) {
      return res
        .status(502)
        .json({ error: 'segment upstream unreachable: ' + e.message })
    }
  },
)

app.post('/api/tts', express.json({ limit: '2mb' }), async (req, res) => {
  const { text, voice, speed, apiUrl, apiKey, model } = req.body || {}

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' })
  }

  const url = apiUrl || TTS_API_URL
  const key = apiKey || TTS_API_KEY
  const mdl = model || TTS_MODEL

  if (!url || !key) {
    return res.status(503).json({
      error:
        'TTS not configured. Set apiUrl/apiKey in Settings, or TTS_API_URL/TTS_API_KEY on the server.',
    })
  }

  const apiBody = {
    model: mdl,
    input: text,
    voice: voice || 'alloy',
  }
  if (typeof speed === 'number' && speed >= 0.25 && speed <= 4) {
    apiBody.speed = speed
  }

  let ttsRes = null
  const abortCtrl = new AbortController()
  let pipeStarted = false
  const cleanup = () => {
    try {
      abortCtrl.abort()
    } catch (_) {
      /* noop */
    }
  }
  // Express 5: req.on('close') 在请求体读取后就触发（不是客户端断开）。
  // 用 res.on('close') 检测客户端断开（响应被关闭时才触发）。
  res.on('close', cleanup)

  try {
    ttsRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(apiBody),
      signal: abortCtrl.signal,
    })
  } catch (e) {
    if (e.name === 'AbortError') return
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
  pipeStarted = true

  try {
    const body = Readable.fromWeb(ttsRes.body)
    body.on('error', () => {})
    body.pipe(res)
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
