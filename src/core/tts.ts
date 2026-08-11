/**
 * Sentence-aware streaming TTS player using AudioWorklet.
 *
 * 三步正交流程 (edge-tts 后端):
 *   1. split(text)        → sentences[] (纯正则分句, 无归一化)
 *   2. normalize(sentence) → tts_text    (pydantic-ai 单句转换, 滑动窗口预取)
 *   3. audio/speech(tts_text) → PCM       (纯 TTS, 无前处理)
 *
 * 滑动窗口: [currentIndex, currentIndex+N) 并发跑 (normalize → PCM) 整句流水线,
 * N 句同时在不同阶段, 抵消 LLM 归一化延迟。seekTo(index) 从任意句重启窗口。
 *
 * 关键修复: maybeStart 不再等 30s preBuffer (逐句模式单句几秒永远达不到),
 * 有 PCM 即播放; underrun 靠窗口预取避免, 不 suspend audioContext。
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
  /** (已弃用, 逐句模式靠窗口预取) 保留兼容。 */
  preBufferSecs: number
  /** 滑动窗口大小 (默认 5): 当前句 + 后 N 句保持已转换+已合成。 */
  windowSize: number
}

export interface RemoteVoice {
  id: string
  name: string
  engine: string
  locale: string
  gender: string
}

/** 分句结果: 只含原始文本, ttsText 运行时由 normalize 填充。 */
export interface Sentence {
  index: number
  original: string
}

export interface PlaybackProgress {
  text: string
  playedSecs: number
  bufferedSecs: number
  totalEstimate: number
  preBufferTarget: number
  phase: 'buffering' | 'playing' | 'paused'
  sentenceIndex: number
  sentenceTotal: number
}

export interface TTSPlayerCallbacks {
  onStateChange?: (state: TTSState) => void
  onError?: (message: string) => void
  onProgress?: (p: PlaybackProgress) => void
  onSentences?: (sentences: Sentence[]) => void
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

/* ---------- 第一步: split (分句) ---------- */

function localSplit(text: string): Sentence[] {
  const parts = text.match(/[^。!?\n]+[。!?]?\n?/g) || [text]
  const out: Sentence[] = []
  let i = 0
  for (const p of parts) {
    const t = p.trim()
    if (t) out.push({ index: i++, original: t })
  }
  return out
}

/** 调 /api/v1/tts/split 分句 (纯正则, 不归一化)。失败 fallback 本地分句。 */
export async function splitText(
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
      url = config.apiUrl!.replace(
        /\/v1\/audio\/speech\/?$/,
        '/api/v1/tts/split',
      )
      headers['Authorization'] = `Bearer ${config.apiKey}`
    } else {
      url = '/api/tts/split'
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text }),
    })
    if (!resp.ok) throw new Error(`split HTTP ${resp.status}`)
    const data = await resp.json()
    const arr: any[] = data.sentences || []
    if (!arr.length) return localSplit(text)
    return arr.map((s, i) => ({ index: i, original: s.text ?? '' }))
  } catch (e: any) {
    console.warn('[TTS] split failed, fallback to local:', e)
    return localSplit(text)
  }
}

/* ---------- 第二步: normalize (单句归一化) ---------- */

/** 调 /api/v1/tts/normalize 单句归一化。失败 fallback 原文。 */
export async function normalizeText(
  text: string,
  config: Partial<TTSConfig>,
): Promise<string> {
  if (!text.trim()) return text
  const useDirect = !!(config.apiUrl && config.apiKey)
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    let url: string
    if (useDirect) {
      url = config.apiUrl!.replace(
        /\/v1\/audio\/speech\/?$/,
        '/api/v1/tts/normalize',
      )
      headers['Authorization'] = `Bearer ${config.apiKey}`
    } else {
      url = '/api/tts/normalize'
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text }),
    })
    if (!resp.ok) throw new Error(`normalize HTTP ${resp.status}`)
    const data = await resp.json()
    return data.tts_text || text
  } catch (e: any) {
    console.warn('[TTS] normalize failed, return original:', e)
    return text
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
      if (msg === null) { this.ended = true; return }
      if (msg === 'flush') {
        this.wpos = 0; this.rpos = 0; this.ended = false; this.endedNotified = false; return
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
    _workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
    )
  }
  return _workletUrl
}

/* ---------- Helpers ---------- */

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

function pcmToInt16Float(bytes: Uint8Array): Float32Array {
  const sampleCount = bytes.length >> 1
  const result = new Float32Array(sampleCount)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < sampleCount; i++)
    result[i] = view.getInt16(i * 2, true) / 32768
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
  private windowSize = 5

  private samplesSent = 0
  private playStartTime = 0
  private sentenceOffsets: number[] = []
  /** [idx] = 归一化后的 tts_text (第二步产物)。 */
  private normalizeCache = new Map<number, string>()
  /** [idx] = 完整 PCM (第三步产物)。 */
  private audioCache = new Map<number, Float32Array>()
  private fetching = new Set<number>()
  private sentenceControllers = new Map<number, AbortController>()
  private masterAbort: AbortController | null = null
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
    this.windowSize = config.windowSize ?? 5
  }

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

  /** 播放整篇: split → setup → playFrom(0)。 */
  async play(text: string): Promise<void> {
    if (!text.trim()) return
    this.stopInternal()
    this.currentText = text
    this.setState('loading')
    try {
      this.sentences = await splitText(text, this.config)
    } catch (e: any) {
      this.callbacks.onError?.('split: ' + (e.message || String(e)))
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

  /** 从任意句开始: abort + flush + 重启窗口。 */
  async seekTo(index: number): Promise<void> {
    if (index < 0 || index >= this.sentences.length) return
    if (!this.audioContext || !this.workletNode) return
    if (index === this.currentIndex && this.startedPlaying) return
    await this.playFrom(index)
  }

  private async setupAudio(): Promise<void> {
    this.audioContext = new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
    if (this.audioContext.state === 'running') await this.audioContext.suspend()
    this.playStartTime = 0
    this.samplesSent = 0
    this.lastProgressTime = 0
    this.userPaused = false
    this.startedPlaying = false
    this.sentenceOffsets = []
    this.audioCache.clear()
    this.normalizeCache.clear()
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

  /** 驱动播放: 从 index 开始喂入循环。 */
  private async playFrom(index: number): Promise<void> {
    if (!this.audioContext || !this.workletNode) return
    this.epoch++
    const myEpoch = this.epoch
    this.abortFetches()
    this.currentIndex = index
    this.lastReportedIndex = -1
    this.workletNode.port.postMessage('flush')
    this.samplesSent = 0
    this.startedPlaying = false
    if (this.audioContext.state === 'running') await this.audioContext.suspend()
    if (this.state !== 'paused') this.setState('loading')

    this.ensureWindow(index)

    let next = index
    while (next < this.sentences.length) {
      if (this.epoch !== myEpoch) return
      const pcm = await this.waitForAudio(next, myEpoch)
      if (this.epoch !== myEpoch) return
      if (!this.workletNode || !this.audioContext) return
      this.sentenceOffsets[next] = this.samplesSent
      if (pcm.length > 0) {
        /* Read pcm.length BEFORE postMessage transfers the buffer —
         * a transferred ArrayBuffer detaches the view, after which
         * TypedArray.length returns 0 (byteLength becomes 0). */
        this.samplesSent += pcm.length
        try {
          this.workletNode.port.postMessage(pcm, [pcm.buffer])
        } catch (_) {
          /* noop — buffer transfer failure shouldn't crash playback */
        }
      }
      await this.maybeStart()
      this.emitProgress()
      next++
      this.ensureWindow(next)
    }
    if (this.epoch !== myEpoch) return
    this.workletNode?.port.postMessage(null)
    /* 等尾音播完 (worklet fires 'ended')。 */
    while (
      (this.state === 'playing' || this.state === 'buffering') &&
      this.epoch === myEpoch
    ) {
      if (
        this.state === 'buffering' &&
        this.audioContext &&
        this.startedPlaying
      ) {
        await this.audioContext.resume()
      }
      await sleep(300)
      this.emitProgress()
    }
  }

  /** 预取窗口 [from, from+windowSize): 并发跑 normalize→PCM 整句流水线。 */
  private ensureWindow(fromIndex: number): void {
    const end = Math.min(this.sentences.length, fromIndex + this.windowSize)
    for (let i = fromIndex; i < end; i++) {
      if (!this.audioCache.has(i) && !this.fetching.has(i)) {
        this.fetchSentenceFull(i)
      }
    }
  }

  /** 单句完整流水线: normalize → fetch PCM → audioCache。 */
  private fetchSentenceFull(i: number): void {
    this.fetching.add(i)
    const ctrl = new AbortController()
    this.sentenceControllers.set(i, ctrl)
    if (this.masterAbort) {
      this.masterAbort.signal.addEventListener('abort', () => ctrl.abort())
    }
    ;(async () => {
      try {
        /* 第二步: normalize (有 cache 用 cache) */
        let ttsText = this.normalizeCache.get(i)
        if (ttsText == null) {
          ttsText = await normalizeText(this.sentences[i].original, this.config)
          if (this.epoch >= 0) this.normalizeCache.set(i, ttsText)
        }
        if (ctrl.signal.aborted) return
        /* 第三步: 纯 TTS */
        const pcm = await this.fetchSentencePCM(ttsText, ctrl.signal)
        this.audioCache.set(i, pcm)
      } catch (e: any) {
        if (e?.name === 'AbortError') return
        this.callbacks.onError?.(`sentence ${i}: ${e?.message || String(e)}`)
        this.audioCache.set(i, new Float32Array(0))
      } finally {
        this.fetching.delete(i)
        this.sentenceControllers.delete(i)
      }
    })()
  }

  /** 阻塞直到句子 i 的 PCM 就绪 (或 epoch 变)。 */
  private async waitForAudio(
    i: number,
    myEpoch: number,
  ): Promise<Float32Array> {
    while (this.epoch === myEpoch && !this.audioCache.has(i)) {
      if (
        this.epoch === myEpoch &&
        !this.fetching.has(i) &&
        !this.audioCache.has(i)
      ) {
        this.fetchSentenceFull(i)
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

  /** 第三步: 调 audio/speech 拿单句 PCM (纯 TTS, 无前处理)。 */
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
    const resp = await fetch(url, { method: 'POST', headers, body, signal })
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
      if (chunk.length & 1) {
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

  /** 有 PCM 即播放 (不再等 30s preBuffer —— 逐句模式靠窗口预取避免 underrun)。 */
  private async maybeStart(): Promise<void> {
    if (this.startedPlaying || !this.workletNode || !this.audioContext) return
    if (this.samplesSent === 0) return
    await this.audioContext.resume()
    this.workletNode.connect(this.audioContext.destination)
    this.playStartTime = this.audioContext.currentTime
    this.startedPlaying = true
    this.setState('playing')
    this.emitProgress()
  }

  private emitProgress(): void {
    if (!this.audioContext) return
    const now = Date.now()
    if (now - this.lastProgressTime < PROGRESS_INTERVAL) return
    this.lastProgressTime = now
    const buffered = this.samplesSent / TTS_SAMPLE_RATE
    const played =
      this.audioContext.state === 'running' && this.startedPlaying
        ? Math.max(0, this.audioContext.currentTime - this.playStartTime)
        : 0
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
      preBufferTarget: this.config.preBufferSecs ?? 0,
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

  pause(): void {
    if (this.state !== 'playing') return
    this.userPaused = true
    this.audioContext?.suspend()
    this.setState('paused')
  }
  resume(): void {
    if (this.state !== 'paused') return
    this.userPaused = false
    this.audioContext?.resume()
    this.setState('playing')
  }
  togglePause(): void {
    if (this.state === 'playing') this.pause()
    else if (this.state === 'paused') this.resume()
  }
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
    this.normalizeCache.clear()
    this.startedPlaying = false
  }
}
