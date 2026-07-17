/**
 * Streaming TTS player using AudioWorklet.
 *
 * Purpose: play text-to-speech audio with pre-buffer for smooth playback.
 *
 * Design decisions:
 *  - AudioWorklet ring buffer (60 s) receives PCM from the fetch stream.
 *  - Worklet is NOT connected to audio-destination until the ring buffer
 *    holds preBufferSecs worth of audio.  This eliminates startup stutter.
 *  - During playback, if the buffer shrinks below preBufferSecs/2 the
 *    AudioContext is suspended (="buffering") until the buffer refills.
 *  - The user-pause (⏸) state is separate from the auto-buffering state.
 *  - OnProgress callback fires every second with playback position so the
 *    UI can show which text is being spoken.
 */
const TTS_SAMPLE_RATE = 24000
const WAV_HEADER_SIZE = 44
const CONFIG_KEY = 'md-reader__tts-config'
const PROGRESS_INTERVAL = 1000 // ms

export type TTSState = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering'

export interface TTSConfig {
  apiUrl: string
  apiKey: string
  model: string
  voice: string
  speed: number
  /** Seconds of audio to buffer before starting playback (default 30). */
  preBufferSecs: number
}

export interface RemoteVoice {
  id: string
  name: string
  engine: string
  locale: string
  gender: string
}

export interface PlaybackProgress {
  /** Full text being spoken. */
  text: string
  /** Seconds of audio played so far. */
  playedSecs: number
  /** Seconds of audio buffered ahead of the play head. */
  bufferedSecs: number
  /** Rough estimate of total audio duration (chars / 4). */
  totalEstimate: number
}

export interface TTSPlayerCallbacks {
  onStateChange?: (state: TTSState) => void
  onError?: (message: string) => void
  onProgress?: (p: PlaybackProgress) => void
}

/* ---------- localStorage persistence ---------- */

export function loadTTSConfig(): Partial<TTSConfig> {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}')
  } catch {
    return {}
  }
}

export function saveTTSConfig(config: Partial<TTSConfig>): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
}

/* ---------- Direct TTS API access ---------- */

function normalizeVoice(v: any): RemoteVoice {
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
}

/**
 * Fetch models + voices from the TTS API.
 * Calls the TTS API directly when apiUrl+apiKey are configured;
 * falls back to the server proxy /api/tts/config otherwise.
 */
export async function fetchTTSConfig(config: Partial<TTSConfig>): Promise<{
  models: string[]
  voices: RemoteVoice[]
  serverConfigured: boolean
  error?: string
}> {
  if (config.apiUrl && config.apiKey) {
    const baseUrl = config.apiUrl.replace(/\/audio\/speech\/?$/, '')
    const authHdr = { Authorization: `Bearer ${config.apiKey}` }
    try {
      const [modelsResp, voicesResp] = await Promise.all([
        fetch(`${baseUrl}/models`, { headers: authHdr }),
        fetch(`${baseUrl}/audio/voices`, { headers: authHdr }),
      ])
      let models: string[] = []
      let voices: RemoteVoice[] = []
      if (modelsResp.ok) {
        const md = await modelsResp.json()
        models = (md.data || []).map((m: any) => m.id)
      }
      if (voicesResp.ok) {
        const vd = await voicesResp.json()
        voices = (Array.isArray(vd) ? vd : vd.data || []).map(normalizeVoice)
      }
      return { models, voices, serverConfigured: false }
    } catch (e: any) {
      return {
        models: [],
        voices: [],
        serverConfigured: false,
        error: e.message || String(e),
      }
    }
  }

  /* Fall back to server proxy */
  try {
    const params = new URLSearchParams()
    if (config.apiUrl) params.set('apiUrl', config.apiUrl)
    if (config.apiKey) params.set('apiKey', config.apiKey)
    const resp = await fetch(`/api/tts/config?${params.toString()}`)
    if (resp.ok) return await resp.json()
  } catch (e: any) {
    return {
      models: [],
      voices: [],
      serverConfigured: false,
      error: e.message || String(e),
    }
  }
  return { models: [], voices: [], serverConfigured: false }
}

/* ---------- AudioWorklet processor source ---------- */

const WORKLET_SOURCE = `
class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.bufSize = ${TTS_SAMPLE_RATE} * 60
    this.rbuf = new Float32Array(this.bufSize)
    this.wpos = 0
    this.rpos = 0
    this.ended = false
    this.endedNotified = false
    this.port.onmessage = (e) => {
      const msg = e.data
      if (msg === null) {
        this.ended = true
        return
      }
      if (msg === 'flush') {
        this.wpos = 0
        this.rpos = 0
        this.ended = false
        this.endedNotified = false
        return
      }
      if (msg instanceof Float32Array) {
        for (let i = 0; i < msg.length; i++) {
          this.rbuf[this.wpos] = msg[i]
          this.wpos = (this.wpos + 1) % this.bufSize
        }
        this.endedNotified = false
      }
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0]
    if (!out || out.length === 0) return true
    const ch = out[0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      if (this.rpos !== this.wpos) {
        ch[i] = this.rbuf[this.rpos]
        this.rpos = (this.rpos + 1) % this.bufSize
      } else {
        ch[i] = 0
        if (this.ended && !this.endedNotified) {
          this.port.postMessage('ended')
          this.endedNotified = true
        }
      }
    }
    return true
  }
}
registerProcessor('pcm-player', PCMPlayerProcessor)
`

let _workletUrl: string | null = null

function getWorkletUrl(): string {
  if (!_workletUrl) {
    const blob = new Blob([WORKLET_SOURCE], {
      type: 'application/javascript',
    })
    _workletUrl = URL.createObjectURL(blob)
  }
  return _workletUrl
}

/* ---------- Helpers ---------- */

/**
 * Extract readable text from a rendered markdown article.
 * Removes code blocks, images, SVGs, tables and anchor links.
 */
export function extractTextForTTS(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement
  clone
    .querySelectorAll(
      'pre, img, svg, table, .md-reader__head-anchor, .md-reader__btn--copy',
    )
    .forEach(el => el.remove())
  return (clone.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** Convert raw 16-bit little-endian PCM bytes to Float32 samples. */
function pcmToInt16Float(bytes: Uint8Array): Float32Array {
  const sampleCount = bytes.length >> 1
  const result = new Float32Array(sampleCount)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < sampleCount; i++) {
    result[i] = view.getInt16(i * 2, true) / 32768
  }
  return result
}

/* ---------- TTSPlayer ---------- */

export class TTSPlayer {
  private audioContext: AudioContext | null = null
  private workletNode: AudioWorkletNode | null = null
  private abortController: AbortController | null = null
  private state: TTSState = 'idle'
  private samplesSent = 0
  private playStartTime = 0
  private config: Partial<TTSConfig>
  private callbacks: TTSPlayerCallbacks
  private lastProgressTime = 0
  private currentText = ''
  private userPaused = false

  constructor(
    callbacks: TTSPlayerCallbacks = {},
    config: Partial<TTSConfig> = {},
  ) {
    this.callbacks = callbacks
    this.config = config
  }

  /** Update config at runtime (e.g. when user saves settings). */
  updateConfig(config: Partial<TTSConfig>): void {
    this.config = { ...this.config, ...config }
  }

  getState(): TTSState {
    return this.state
  }

  getBufferedSecs(): number {
    if (!this.audioContext) return 0
    return this.samplesSent / TTS_SAMPLE_RATE
  }

  private setState(state: TTSState) {
    if (this.state === state) return
    this.state = state
    this.callbacks.onStateChange?.(state)
  }

  private emitProgress() {
    if (!this.audioContext) return
    const now = performance.now()
    if (now - this.lastProgressTime < PROGRESS_INTERVAL) return
    this.lastProgressTime = now

    const played =
      this.audioContext.state === 'running'
        ? this.audioContext.currentTime - this.playStartTime
        : 0

    this.callbacks.onProgress?.({
      text: this.currentText,
      playedSecs: Math.max(0, played),
      bufferedSecs: Math.max(0, this.samplesSent / TTS_SAMPLE_RATE - played),
      totalEstimate: this.currentText.length / 4,
    })
  }

  /**
   * Begin streaming TTS with pre-buffering.
   *
   * The worklet node is created but NOT connected to destination until
   * buffered >= preBufferSecs.  If the buffer drains below half the
   * threshold during playback the AudioContext is auto-suspended
   * (state → "buffering") and resumed when it refills.
   */
  async play(text: string): Promise<void> {
    if (!text.trim()) return
    this.stopInternal()
    this.currentText = text

    const preBuffer = this.config.preBufferSecs ?? 30
    const preBufferSamples = preBuffer * TTS_SAMPLE_RATE

    this.setState('loading')

    try {
      this.audioContext = new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume()
      }
      this.playStartTime = this.audioContext.currentTime
      this.samplesSent = 0
      this.lastProgressTime = 0
      this.userPaused = false

      await this.audioContext.audioWorklet.addModule(getWorkletUrl())
      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-player')
      /* NOT connected to destination yet — buffer fills silently */

      this.workletNode.port.onmessage = (e: MessageEvent) => {
        if (e.data === 'ended') {
          this.setState('idle')
          this.cleanup()
        }
      }

      this.abortController = new AbortController()

      // --- fetch setup (same as before) ---
      const useDirect = !!(this.config.apiUrl && this.config.apiKey)
      const fetchUrl = useDirect ? this.config.apiUrl! : '/api/tts'
      const fetchHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (useDirect) {
        fetchHeaders['Authorization'] = `Bearer ${this.config.apiKey}`
      }
      const speed = this.config.speed ?? 1
      const fetchBody = useDirect
        ? JSON.stringify({
            model: this.config.model || 'qwen',
            input: text,
            voice: this.config.voice || 'alloy',
            ...(speed !== 1 && { speed }),
          })
        : JSON.stringify({
            text,
            ...(this.config.voice && { voice: this.config.voice }),
            ...(this.config.model && { model: this.config.model }),
            ...(speed !== 1 && { speed }),
          })

      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers: fetchHeaders,
        body: fetchBody,
        signal: this.abortController.signal,
      })
      if (!response.ok) {
        const err = await response
          .json()
          .catch(() => ({ error: `HTTP ${response.status}` }))
        throw new Error(err.error || `HTTP ${response.status}`)
      }
      if (!response.body) throw new Error('No response body')

      // --- streaming read loop ---
      const reader = response.body.getReader()
      let headerStripped = false
      let leftover: Uint8Array | null = null
      let startedPlaying = false

      const maybeStart = () => {
        if (startedPlaying || !this.workletNode || !this.audioContext) return
        if (this.samplesSent < preBufferSamples) return
        if (this.audioContext.state !== 'running') {
          this.audioContext.resume()
        }
        this.workletNode.connect(this.audioContext.destination)
        this.playStartTime = this.audioContext.currentTime
        startedPlaying = true
        this.setState('playing')
        this.emitProgress()
      }

      const checkBuffer = () => {
        if (!this.audioContext || !startedPlaying || this.userPaused) return

        const played =
          this.audioContext.state === 'running'
            ? this.audioContext.currentTime - this.playStartTime
            : 0
        const buffered = this.samplesSent / TTS_SAMPLE_RATE - played

        if (this.state === 'playing' && buffered < preBuffer * 0.5) {
          this.audioContext.suspend()
          this.setState('buffering')
        } else if (this.state === 'buffering' && buffered >= preBuffer) {
          this.audioContext.resume()
          this.playStartTime = this.audioContext.currentTime - played
          this.setState('playing')
          this.emitProgress()
        } else if (this.state === 'playing') {
          this.emitProgress()
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        let chunk: Uint8Array = value // mute
        if (!headerStripped) {
          if (chunk.length < WAV_HEADER_SIZE) continue
          chunk = chunk.slice(WAV_HEADER_SIZE)
          headerStripped = true
        }
        if (leftover) {
          const merged = new Uint8Array(leftover.length + chunk.length)
          merged.set(leftover)
          merged.set(chunk, leftover.length)
          chunk = merged
          leftover = null
        }
        const oddByte = chunk.length & 1
        if (oddByte) {
          leftover = chunk.slice(chunk.length - 1)
          chunk = chunk.slice(0, chunk.length - 1)
        }
        if (chunk.length < 2) continue

        const float32 = pcmToInt16Float(chunk)
        this.samplesSent += float32.length
        this.workletNode?.port.postMessage(float32, [float32.buffer])

        maybeStart()
        checkBuffer()
      }

      // --- stream ended ---
      if (!startedPlaying && this.workletNode && this.audioContext) {
        this.workletNode.connect(this.audioContext.destination)
        this.playStartTime = this.audioContext.currentTime
        this.setState('playing')
      }

      this.workletNode?.port.postMessage(null)

      // Wait for remaining audio to finish
      while (this.state === 'playing' || this.state === 'buffering') {
        if (this.state === 'buffering' && this.audioContext) {
          this.audioContext.resume()
          this.setState('playing')
        }
        await sleep(500)
        this.emitProgress()
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return
      this.callbacks.onError?.(e.message || String(e))
      this.setState('idle')
      this.cleanup()
    }
  }

  /** Pause playback (user-initiated). */
  pause(): void {
    if (this.state !== 'playing') return
    this.userPaused = true
    this.audioContext?.suspend()
    this.setState('paused')
  }

  /** Resume playback (user-initiated). */
  resume(): void {
    if (this.state !== 'paused') return
    this.userPaused = false
    this.audioContext?.resume()
    this.setState('playing')
  }

  /** Toggle pause/resume. */
  togglePause(): void {
    if (this.state === 'playing') this.pause()
    else if (this.state === 'paused') this.resume()
  }

  /** Stop playback and release all resources. */
  stop(): void {
    this.stopInternal()
    this.setState('idle')
  }

  private stopInternal(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    this.cleanup()
  }

  private cleanup(): void {
    if (this.workletNode) {
      try {
        this.workletNode.disconnect()
      } catch (_) {
        /* noop */
      }
      this.workletNode = null
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {})
      this.audioContext = null
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
