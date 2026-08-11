/**
 * Sentence-aware streaming TTS player using AudioWorklet.
 *
 * Purpose: play text-to-speech audio with per-sentence seeking,
 * highlight and sliding-window prefetch.
 *
 * Design decisions:
 *  - Text is first segmented via /api/tts/segment into Sentence[].
 *  - Each sentence is requested individually (same /api/tts endpoint,
 *    streaming WAV).  A sliding window prefetches the next N sentences
 *    as whole-PCM buffers (strategy A: integral-sentence cache).
 *  - AudioWorklet ring buffer (60 s) receives PCM in sentence order.
 *  - The worklet is NOT aware of sentence boundaries — sentence offsets
 *    (samplesSent before feeding each sentence) let us map the play head
 *    back to the current sentence index.
 *  - seek = abort in-flight fetches + flush ring buffer + restart window.
 *  - Pre-buffer / under-run suspend logic is preserved and works across
 *    sentence boundaries (buffer accumulates over multiple sentences).
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
  /** Sliding-window size in sentences (default 3). */
  windowSize: number
}

export interface RemoteVoice {
  id: string
  name: string
  engine: string
  locale: string
  gender: string
}

/** A single segmented sentence: original text + normalized TTS text. */
export interface Sentence {
  index: number
  original: string
  ttsText: string
}

export interface PlaybackProgress {
  /** Text of the sentence currently being spoken. */
  text: string
  /** Seconds of audio played so far. */
  playedSecs: number
  /** Seconds of audio buffered ahead of the play head. */
  bufferedSecs: number
  /** Rough estimate of total audio duration (chars / 4). */
  totalEstimate: number
  /** Pre-buffer target in seconds. */
  preBufferTarget: number
  /** Current phase: buffering / playing / paused. */
  phase: 'buffering' | 'playing' | 'paused'
  /** Index of the sentence currently being spoken. */
  sentenceIndex: number
  /** Total number of sentences. */
  sentenceTotal: number
}

export interface TTSPlayerCallbacks {
  onStateChange?: (state: TTSState) => void
  onError?: (message: string) => void
  onProgress?: (p: PlaybackProgress) => void
  /** Fires once after segmentation with the full sentence list. */
  onSentences?: (sentences: Sentence[]) => void
  /** Fires whenever the currently-spoken sentence index changes. */
  onSentenceChange?: (index: number) => void
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

/* ---------- Segmentation ---------- */

/**
 * Local-only fallback splitter used when the segment endpoint is
 * unavailable (non-edge-tts backend, offline, etc.).  Produces no
 * normalization — ttsText == original.
 */
function localSegment(text: string): Sentence[] {
  const parts = text.match(/[^。!?\n]+[。!?]?\n?/g) || [text]
  const out: Sentence[] = []
  let i = 0
  for (const p of parts) {
    const t = p.trim()
    if (t) out.push({ index: i++, original: t, ttsText: t })
  }
  return out
}

/**
 * Segment text into sentences with TTS normalization.
 * Calls the edge-tts /api/v1/tts/segment endpoint (direct or via proxy)
 * and falls back to local splitting on any failure.
 */
export async function segmentText(
  text: string,
  config: Partial<TTSConfig>,
): Promise<Sentence[]> {
  if (!text.trim()) return []
  const useDirect = !!(config.apiUrl && config.apiKey)
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    let url: string
    if (useDirect) {
      /* apiUrl looks like .../v1/audio/speech (openai router, no prefix).
       * segment lives under a different router (/api/v1/tts/segment), so
       * derive it from the tunnel base. */
      url = config.apiUrl!.replace(
        /\/v1\/audio\/speech\/?$/,
        '/api/v1/tts/segment',
      )
      headers['Authorization'] = `Bearer ${config.apiKey}`
    } else {
      url = '/api/tts/segment'
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, language: 'chinese', normalize: 'llm' }),
    })
    if (!resp.ok) throw new Error(`segment HTTP ${resp.status}`)
    const data = await resp.json()
    const arr: any[] = data.sentences || []
    if (!arr.length) return localSegment(text)
    return arr.map((s, i) => ({
      index: i,
      original: s.original ?? '',
      ttsText: s.tts_text ?? s.original ?? '',
    }))
  } catch (e: any) {
    /* degrade gracefully — never block playback on normalization */
    console.warn('[TTS] segment failed, fallback to local split:', e)
    return localSegment(text)
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/* ---------- TTSPlayer ---------- */

export class TTSPlayer {
  private audioContext: AudioContext | null = null
  private workletNode: AudioWorkletNode | null = null
  private state: TTSState = 'idle'
  private config: Partial<TTSConfig>
  private callbacks: TTSPlayerCallbacks

  private currentText = ''
  private sentences: Sentence[] = []
  private currentIndex = 0
  private lastReportedIndex = -1
  private windowSize = 3

  private samplesSent = 0
  private playStartTime = 0
  /** [idx] = sample offset where sentence idx begins (in cumulative stream). */
  private sentenceOffsets: number[] = []
  private audioCache = new Map<number, Float32Array>()
  private fetching = new Set<number>()
  private sentenceControllers = new Map<number, AbortController>()
  /** Aborted on stop to cancel every in-flight sentence fetch. */
  private masterAbort: AbortController | null = null
  /** Incremented on play/seek/stop so stale feed loops bail out. */
  private epoch = 0
  private startedPlaying = false
  private userPaused = false
  private lastProgressTime = 0

  constructor(
    callbacks: TTSPlayerCallbacks = {},
    config: Partial<TTSConfig> = {},
  ) {
    this.callbacks = callbacks
    this.config = config
    this.windowSize = config.windowSize ?? 3
  }

  /** Update config at runtime (e.g. when user saves settings). */
  updateConfig(config: Partial<TTSConfig>): void {
    this.config = { ...this.config, ...config }
    if (config.windowSize != null) this.windowSize = config.windowSize
  }

  getState(): TTSState {
    return this.state
  }

  getSentences(): Sentence[] {
    return this.sentences
  }

  private setState(s: TTSState) {
    if (this.state === s) return
    this.state = s
    this.callbacks.onStateChange?.(s)
  }

  /**
   * Begin playback of a full text: segment → setup audio → play from 0.
   * onSentences fires after segmentation so the UI can wrap the DOM.
   */
  async play(text: string): Promise<void> {
    if (!text.trim()) return
    this.stopInternal()
    this.currentText = text
    this.setState('loading')

    try {
      this.sentences = await segmentText(text, this.config)
    } catch (e: any) {
      this.callbacks.onError?.('segment: ' + (e.message || String(e)))
      this.setState('idle')
      return
    }
    if (!this.sentences.length) {
      this.setState('idle')
      return
    }
    this.callbacks.onSentences?.(this.sentences)

    await this.setupAudio()
    if (!this.audioContext || !this.workletNode) return
    await this.playFrom(0)
  }

  /** Seek to a sentence: abort in-flight, flush buffer, restart window. */
  async seekTo(index: number): Promise<void> {
    if (index < 0 || index >= this.sentences.length) return
    if (!this.audioContext || !this.workletNode) return
    if (index === this.currentIndex && this.startedPlaying) return
    await this.playFrom(index)
  }

  private async setupAudio(): Promise<void> {
    this.audioContext = new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
    /* Suspend immediately — currentTime must not advance during
     * pre-buffering, otherwise process() consumes the first chunk silently. */
    if (this.audioContext.state === 'running') {
      await this.audioContext.suspend()
    }
    this.playStartTime = 0
    this.samplesSent = 0
    this.lastProgressTime = 0
    this.userPaused = false
    this.startedPlaying = false
    this.sentenceOffsets = []
    this.audioCache.clear()
    this.lastReportedIndex = -1

    await this.audioContext.audioWorklet.addModule(getWorkletUrl())
    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-player')
    this.workletNode.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'ended') {
        this.setState('idle')
        this.cleanup()
      }
    }
    this.masterAbort = new AbortController()
  }

  /** Drive playback starting at `index`. Owns the feed loop. */
  private async playFrom(index: number): Promise<void> {
    if (!this.audioContext || !this.workletNode) return

    /* Cancel any previous feed loop + in-flight fetches, flush residue. */
    this.epoch++
    const myEpoch = this.epoch
    this.abortFetches()
    this.currentIndex = index
    this.lastReportedIndex = -1
    this.workletNode.port.postMessage('flush')
    this.samplesSent = 0
    this.startedPlaying = false
    if (this.audioContext.state === 'running') {
      await this.audioContext.suspend()
    }
    if (this.state !== 'paused') this.setState('loading')

    this.ensureWindow(index)

    let next = index
    while (next < this.sentences.length) {
      if (this.epoch !== myEpoch) return
      const pcm = await this.waitForSentence(next, myEpoch)
      if (this.epoch !== myEpoch) return
      if (!this.workletNode || !this.audioContext) return

      this.sentenceOffsets[next] = this.samplesSent
      if (pcm.length > 0) {
        this.workletNode.port.postMessage(pcm, [pcm.buffer])
        this.samplesSent += pcm.length
      }
      await this.maybeStart()
      await this.checkBuffer()
      this.emitProgress()
      next++
      this.ensureWindow(next)
    }

    if (this.epoch !== myEpoch) return
    /* All sentences fed — signal end of stream. */
    this.workletNode?.port.postMessage(null)

    /* Wait for the tail to finish playing (worklet fires 'ended'). */
    while (
      (this.state === 'playing' || this.state === 'buffering') &&
      this.epoch === myEpoch
    ) {
      if (this.state === 'buffering' && this.audioContext) {
        await this.audioContext.resume()
        this.setState('playing')
      }
      await sleep(300)
      this.emitProgress()
    }
  }

  /** Prefetch the window [fromIndex, fromIndex+windowSize). */
  private ensureWindow(fromIndex: number): void {
    const end = Math.min(this.sentences.length, fromIndex + this.windowSize)
    for (let i = fromIndex; i < end; i++) {
      if (!this.audioCache.has(i) && !this.fetching.has(i)) {
        this.fetchSentence(i)
      }
    }
  }

  private fetchSentence(i: number): void {
    this.fetching.add(i)
    const ctrl = new AbortController()
    this.sentenceControllers.set(i, ctrl)
    if (this.masterAbort) {
      this.masterAbort.signal.addEventListener('abort', () => ctrl.abort())
    }
    const text = this.sentences[i].ttsText
    this.fetchSentencePCM(text, ctrl.signal)
      .then(pcm => this.audioCache.set(i, pcm))
      .catch((e: any) => {
        if (e?.name === 'AbortError') return
        this.callbacks.onError?.(`sentence ${i}: ${e?.message || String(e)}`)
        /* degrade: empty PCM so feed loop advances past the failed sentence */
        this.audioCache.set(i, new Float32Array(0))
      })
      .finally(() => {
        this.fetching.delete(i)
        this.sentenceControllers.delete(i)
      })
  }

  /** Block until sentence i's PCM is cached (or epoch changes). */
  private async waitForSentence(
    i: number,
    myEpoch: number,
  ): Promise<Float32Array> {
    while (this.epoch === myEpoch && !this.audioCache.has(i)) {
      if (
        this.epoch === myEpoch &&
        !this.fetching.has(i) &&
        !this.audioCache.has(i)
      ) {
        this.fetchSentence(i)
      }
      await sleep(50)
    }
    return this.audioCache.get(i) || new Float32Array(0)
  }

  private abortFetches(): void {
    for (const ctrl of this.sentenceControllers.values()) ctrl.abort()
    this.sentenceControllers.clear()
    this.fetching.clear()
  }

  /** Fetch one sentence as a complete Float32 PCM buffer. */
  private async fetchSentencePCM(
    text: string,
    signal: AbortSignal,
  ): Promise<Float32Array> {
    if (!text.trim()) return new Float32Array(0)
    const useDirect = !!(this.config.apiUrl && this.config.apiKey)
    const url = useDirect ? this.config.apiUrl! : '/api/tts'
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (useDirect) headers['Authorization'] = `Bearer ${this.config.apiKey}`
    const speed = this.config.speed ?? 1
    const body = useDirect
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

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal,
    })
    if (!resp.ok) {
      const e = await resp
        .json()
        .catch(() => ({ error: `HTTP ${resp.status}` }))
      throw new Error(e.error || `HTTP ${resp.status}`)
    }
    if (!resp.body) throw new Error('No response body')

    const reader = resp.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let headerStripped = false
    let leftover: Uint8Array | null = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      let chunk: Uint8Array = value
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
      const odd = chunk.length & 1
      if (odd) {
        leftover = chunk.slice(chunk.length - 1)
        chunk = chunk.slice(0, chunk.length - 1)
      }
      if (chunk.length < 2) continue
      chunks.push(chunk)
      total += chunk.length
    }
    if (leftover && leftover.length >= 2) {
      const even = leftover.length & ~1
      chunks.push(leftover.slice(0, even))
      total += even
    }
    const merged = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      merged.set(c, off)
      off += c.length
    }
    return pcmToInt16Float(merged)
  }

  private async maybeStart(): Promise<void> {
    if (this.startedPlaying || !this.workletNode || !this.audioContext) return
    const preBuffer = this.config.preBufferSecs ?? 30
    if (this.samplesSent < preBuffer * TTS_SAMPLE_RATE) return
    await this.audioContext.resume()
    this.workletNode.connect(this.audioContext.destination)
    this.playStartTime = this.audioContext.currentTime
    this.startedPlaying = true
    this.setState('playing')
    this.emitProgress()
  }

  private async checkBuffer(): Promise<void> {
    if (!this.audioContext || !this.startedPlaying || this.userPaused) return
    const preBuffer = this.config.preBufferSecs ?? 30
    const played =
      this.audioContext.state === 'running'
        ? this.audioContext.currentTime - this.playStartTime
        : 0
    const buffered = this.samplesSent / TTS_SAMPLE_RATE - played

    if (this.state === 'playing' && buffered < preBuffer * 0.5) {
      await this.audioContext.suspend()
      this.setState('buffering')
    } else if (this.state === 'buffering' && buffered >= preBuffer) {
      await this.audioContext.resume()
      this.playStartTime = this.audioContext.currentTime - played
      this.setState('playing')
      this.emitProgress()
    } else if (this.state === 'playing') {
      this.emitProgress()
    }
  }

  private emitProgress(): void {
    if (!this.audioContext) return
    const now = Date.now()
    if (now - this.lastProgressTime < PROGRESS_INTERVAL) return
    this.lastProgressTime = now

    const preBuf = this.config.preBufferSecs ?? 30
    const buffered = this.samplesSent / TTS_SAMPLE_RATE
    const played =
      this.audioContext.state === 'running'
        ? Math.max(0, this.audioContext.currentTime - this.playStartTime)
        : 0

    /* Find the sentence whose offset is the greatest <= played samples. */
    let curIdx = this.currentIndex
    for (let i = this.sentenceOffsets.length - 1; i >= 0; i--) {
      const off = this.sentenceOffsets[i]
      if (off != null && off / TTS_SAMPLE_RATE <= played) {
        curIdx = i
        break
      }
    }
    if (curIdx !== this.lastReportedIndex) {
      this.lastReportedIndex = curIdx
      this.callbacks.onSentenceChange?.(curIdx)
    }

    this.callbacks.onProgress?.({
      text: this.sentences[curIdx]?.original || this.currentText,
      playedSecs: played,
      bufferedSecs: Math.max(0, buffered - played),
      totalEstimate: this.currentText.length / 4,
      preBufferTarget: preBuf,
      phase:
        this.state === 'loading' || this.state === 'buffering'
          ? 'buffering'
          : this.state === 'playing'
          ? 'playing'
          : 'paused',
      sentenceIndex: curIdx,
      sentenceTotal: this.sentences.length,
    })
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
    this.epoch++
    this.abortFetches()
    if (this.masterAbort) {
      this.masterAbort.abort()
      this.masterAbort = null
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
    this.sentences = []
    this.audioCache.clear()
    this.startedPlaying = false
  }
}
