/**
 * Streaming TTS player using AudioWorklet.
 *
 * Purpose: play text-to-speech audio with minimal first-sound latency by
 * streaming raw PCM (24 kHz / 16-bit / mono, wrapped in a WAV container)
 * through an AudioWorklet ring buffer.
 *
 * Design decisions:
 *  - AudioWorklet (not MediaSource): the upstream returns WAV/PCM, which MSE
 *    handles poorly. AudioWorklet gives us sample-accurate control.
 *  - Ring buffer inside the worklet: smooths network jitter.
 *  - Backpressure on the main thread: pauses stream reading when the ring
 *    buffer holds more than MAX_BUFFER_AHEAD seconds of unplayed audio.
 *  - Pause/resume: delegated to AudioContext.suspend() / resume().
 *  - Stop: AbortController aborts the fetch; AudioContext.close() frees the
 *    audio graph.
 */

const TTS_SAMPLE_RATE = 24000
const WAV_HEADER_SIZE = 44
const MAX_BUFFER_AHEAD = 8

export type TTSState = 'idle' | 'loading' | 'playing' | 'paused'

export interface TTSPlayerCallbacks {
  onStateChange?: (state: TTSState) => void
  onError?: (message: string) => void
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
    const available =
      (this.wpos - this.rpos + this.bufSize) % this.bufSize
    if (available === 0) {
      if (this.ended && !this.endedNotified) {
        this.port.postMessage('ended')
        this.endedNotified = true
      }
      return true
    }
    for (let i = 0; i < ch.length; i++) {
      if (this.rpos !== this.wpos) {
        ch[i] = this.rbuf[this.rpos]
        this.rpos = (this.rpos + 1) % this.bufSize
      } else {
        ch[i] = 0
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
  private startTime = 0
  private voice: string
  private callbacks: TTSPlayerCallbacks

  constructor(callbacks: TTSPlayerCallbacks = {}, voice: string = 'alloy') {
    this.callbacks = callbacks
    this.voice = voice
  }

  getState(): TTSState {
    return this.state
  }

  private setState(state: TTSState) {
    if (this.state === state) return
    this.state = state
    this.callbacks.onStateChange?.(state)
  }

  /**
   * Begin streaming TTS for the given text.
   * Aborts any previous playback first.
   */
  async play(text: string): Promise<void> {
    if (!text.trim()) return

    this.stopInternal()

    this.setState('loading')

    try {
      this.audioContext = new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
      this.startTime = this.audioContext.currentTime
      this.samplesSent = 0

      await this.audioContext.audioWorklet.addModule(getWorkletUrl())

      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-player')
      this.workletNode.connect(this.audioContext.destination)

      this.workletNode.port.onmessage = (e: MessageEvent) => {
        if (e.data === 'ended') {
          this.setState('idle')
          this.cleanup()
        }
      }

      this.abortController = new AbortController()

      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: this.voice }),
        signal: this.abortController.signal,
      })

      if (!response.ok) {
        const err = await response
          .json()
          .catch(() => ({ error: `HTTP ${response.status}` }))
        throw new Error(err.error || `HTTP ${response.status}`)
      }

      if (!response.body) throw new Error('No response body')

      this.setState('playing')

      const reader = response.body.getReader()
      let headerStripped = false
      let leftover: Uint8Array | null = null

      while (true) {
        /* ---- backpressure ---- */
        if (this.audioContext && this.state === 'playing') {
          const realElapsed = this.audioContext.currentTime - this.startTime
          const audioSent = this.samplesSent / TTS_SAMPLE_RATE
          if (audioSent - realElapsed > MAX_BUFFER_AHEAD) {
            await sleep(100)
            continue
          }
        }

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

        const oddByte = chunk.length & 1
        if (oddByte) {
          leftover = chunk.slice(chunk.length - 1)
          chunk = chunk.slice(0, chunk.length - 1)
        }

        if (chunk.length < 2) continue

        const float32 = pcmToInt16Float(chunk)
        this.samplesSent += float32.length

        if (this.workletNode) {
          this.workletNode.port.postMessage(float32, [float32.buffer])
        }
      }

      // Signal end-of-stream to the worklet
      this.workletNode?.port.postMessage(null)
    } catch (e: any) {
      if (e.name === 'AbortError') return
      this.callbacks.onError?.(e.message || String(e))
      this.setState('idle')
      this.cleanup()
    }
  }

  /** Pause playback. */
  pause(): void {
    if (this.state !== 'playing') return
    this.audioContext?.suspend()
    this.setState('paused')
  }

  /** Resume playback. */
  resume(): void {
    if (this.state !== 'paused') return
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
