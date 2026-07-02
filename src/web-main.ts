import Event from '@/core/event'
import Ele, { svg } from '@/core/ele'
import { initPlugins } from '@/plugins'
import lifecycle from '@/core/lifecycle'
import className from '@/config/class-name'
import { getDefaultData } from '@/core/data'
import { mdRender } from '@/core/markdown'
import { getHeads, setTheme, toTheme } from '@/shared'
import sideIcon from '@/images/icon_side.svg'
import goTopIcon from '@/images/icon_go_top.svg'
import {
  TTSPlayer,
  extractTextForTTS,
  loadTTSConfig,
  saveTTSConfig,
  type TTSState,
  type TTSConfig,
} from '@/core/tts'
import '@/style/index.less'
import throttle from 'lodash.throttle'

const FOLDER_SVG = `<svg viewBox="0 0 24 24" width="1.2em" height="1.2em" fill="currentColor"><path d="M3.2 21Q1 21 1 18.75V5.25Q1 3 3.2 3h6.18q.54 0 .93.4l1.61 1.65q.19.2.46.2H20.8Q23 5.25 23 7.5V18.75Q23 21 20.8 21zm1-2.25h15.6q.55 0 .55-.55V8.5q0-.55-.55-.55h-8.29q-.54 0-.93-.4L9.19 5.9q-.19-.2-.46-.2H4.2q-.55 0-.55.55v11.5q0 .55.55.55"/></svg>`

const SPEAKER_SVG = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`

const PAUSE_SVG = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`

const PLAY_SVG = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>`

const STOP_SVG = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M6 6h12v12H6V6z"/></svg>`

const SETTINGS_SVG = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94 0 .31.04.64.09.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.21.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`

const OUTLINE_SVG = `<svg viewBox="0 0 30 30" width="1.2em" height="1.2em" fill="currentColor"><path d="M5 6.5h15.31a2 2 0 0 1 0 3H5a2 2 0 0 1 0-3m4.31 7.5h15.5a2 2 0 0 1 0 3H9.31a2 2 0 0 1 0-3M5 21.5h11.5a2 2 0 0 1 0 3H5a2 2 0 0 1 0-3"/></svg>`

async function initWebApp() {
  const configData = getDefaultData({})
  const currentPath = window.location.pathname

  const globalEvent = new Event()
  initPlugins({ event: globalEvent })
  setTheme(configData.pageTheme)

  if (!currentPath.endsWith('.md')) {
    initIndexPage(currentPath)
    return
  }

  initMarkdownPage(currentPath, configData, globalEvent)
}

interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
}

async function initIndexPage(currentPath: string) {
  const dirPath =
    currentPath === '/' ? '/' : currentPath.replace(/\/$/, '') + '/'

  const container = document.createElement('div')
  container.className = 'md-reader__index'
  document.body.appendChild(container)

  const header = document.createElement('div')
  header.className = 'md-reader__index-header'
  header.innerHTML = `<h1>${FOLDER_SVG} ${dirPath === '/' ? '/' : dirPath}</h1>`
  container.appendChild(header)

  const list = document.createElement('ul')
  list.className = 'md-reader__index-list'
  container.appendChild(list)

  async function renderIndexList(dir: string) {
    try {
      const resp = await fetch(`/api/dir?path=${encodeURIComponent(dir)}`)
      if (!resp.ok) return
      const data: { dirs: DirEntry[]; files: DirEntry[]; currentDir: string } =
        await resp.json()
      header.innerHTML = `<h1>${FOLDER_SVG} ${
        data.currentDir === '/' ? '/' : data.currentDir + '/'
      }</h1>`
      list.innerHTML = ''

      data.dirs.forEach(item => {
        const li = document.createElement('li')
        li.className = 'md-reader__index-item md-reader__index-dir'
        const a = document.createElement('a')
        a.href = item.path === '/' ? '/' : item.path + '/'
        a.textContent = `📁 ${item.name}/`
        if (item.name === '..') {
          a.addEventListener('click', e => {
            e.preventDefault()
            renderIndexList(item.path)
          })
        }
        li.appendChild(a)
        list.appendChild(li)
      })

      data.files.forEach(item => {
        const li = document.createElement('li')
        li.className = 'md-reader__index-item md-reader__index-file'
        const a = document.createElement('a')
        a.href = item.path
        a.textContent = `📄 ${item.name}`
        li.appendChild(a)
        list.appendChild(li)
      })
    } catch (e) {
      list.innerHTML = '<li>Failed to load directory.</li>'
    }
  }

  renderIndexList(dirPath)
}

async function initMarkdownPage(
  currentPath: string,
  configData: ReturnType<typeof getDefaultData>,
  globalEvent: Event,
) {
  let mdRaw = ''

  const rawFileUrl = `/raw${currentPath}`

  try {
    const response = await fetch(rawFileUrl)
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
    mdRaw = await response.text()
  } catch (e: any) {
    document.body.innerHTML = `<h1>Markdown file load failed.</h1><p>${e.message}</p>`
    return
  }

  const rawContainer = document.createElement('pre')
  rawContainer.id = 'raw-markdown-container'
  rawContainer.style.display = 'none'
  rawContainer.textContent = mdRaw
  document.body.appendChild(rawContainer)

  document.body.classList.toggle(
    className.SIDE_COLLAPSED,
    configData.hiddenSide,
  )

  const mdContent = new Ele<HTMLElement>('article', {
    className: `${className.MD_CONTENT} ${
      configData.centered ? 'centered' : ''
    }`,
  })

  function fixRelativeUrls() {
    const dir = currentPath.substring(0, currentPath.lastIndexOf('/') + 1)
    const base = '/raw' + dir
    const attrs = ['src', 'href', 'data-src']
    const tags = mdContent.queryAll('img, video, audio, source, a, iframe')
    tags.forEach(el => {
      attrs.forEach(attr => {
        const val = el.getAttribute(attr)
        if (!val) return
        if (
          val.startsWith('data:') ||
          val.startsWith('http://') ||
          val.startsWith('https://') ||
          val.startsWith('mailto:') ||
          val.startsWith('#') ||
          val.startsWith('/')
        )
          return
        el.setAttribute(attr, base + val)
      })
    })
  }

  const contentRender = (code: string = '') => {
    mdContent.ele.innerHTML = mdRender(code, {
      theme: toTheme(configData.pageTheme),
      plugins: configData.mdPlugins,
    })
    fixRelativeUrls()
  }

  contentRender(mdRaw)

  mdContent.on(
    'click',
    async e => {
      globalEvent.emit('click', e.target)
    },
    true,
  )

  const mdBody = new Ele<HTMLElement>(
    'main',
    { className: className.MD_BODY },
    mdContent,
  )

  /* ---- sidebar wrapper ---- */
  const sideWrapper = new Ele<HTMLElement>('aside', {
    className: className.MD_SIDE,
  })

  /* ---- sidebar header: tab switch ---- */
  const sideHead = new Ele<HTMLElement>('div', {
    className: 'md-reader__side-head',
  })
  const tabFolderBtn = new Ele<HTMLElement>('button', {
    className: 'md-reader__side-tab',
  })
  tabFolderBtn.innerHTML = FOLDER_SVG
  const tabOutlineBtn = new Ele<HTMLElement>('button', {
    className: 'md-reader__side-tab md-reader__side-tab--active',
  })
  tabOutlineBtn.innerHTML = OUTLINE_SVG
  const tabIndicator = new Ele<HTMLElement>('span', {
    className: 'md-reader__side-tab-indicator',
  })
  sideHead.append(tabFolderBtn)
  sideHead.append(tabOutlineBtn)
  sideHead.append(tabIndicator)

  /* ---- panels ---- */
  const filePanel = new Ele<HTMLElement>('div', {
    className: 'md-reader__side-panel',
  })
  filePanel.hide()
  const tocPanel = new Ele<HTMLElement>('div', {
    className: 'md-reader__side-panel',
  })

  sideWrapper.append(sideHead)
  sideWrapper.append(filePanel)
  sideWrapper.append(tocPanel)

  /* ---- Tab switching ---- */
  function setActiveTab(tab: 'folder' | 'outline') {
    if (tab === 'folder') {
      tabFolderBtn.classList.add('md-reader__side-tab--active')
      tabOutlineBtn.classList.remove('md-reader__side-tab--active')
      filePanel.show()
      tocPanel.hide()
    } else {
      tabOutlineBtn.classList.add('md-reader__side-tab--active')
      tabFolderBtn.classList.remove('md-reader__side-tab--active')
      tocPanel.show()
      filePanel.hide()
    }
  }

  tabFolderBtn.on('click', () => setActiveTab('folder'))
  tabOutlineBtn.on('click', () => setActiveTab('outline'))

  /* ---- File navigation panel ---- */
  const fileNavList = new Ele<HTMLElement>('ul', {
    className: className.FILE_NAV_LIST,
  })
  filePanel.append(fileNavList)

  function renderFileNavItems(data: { dirs: DirEntry[]; files: DirEntry[] }) {
    fileNavList.innerHTML = ''

    data.dirs.forEach((item: DirEntry) => {
      const li = new Ele<HTMLElement>('li', {
        className: `${className.FILE_NAV_ITEM} ${className.FILE_NAV_DIR}`,
      })
      const a = new Ele<HTMLElement>('a', { href: '#' })
      a.textContent = `${item.name}/`
      a.on('click', (e: Event) => {
        e.preventDefault()
        loadFileNavDir(item.path)
      })
      li.append(a)
      fileNavList.append(li)
    })

    data.files.forEach((item: DirEntry) => {
      const li = new Ele<HTMLElement>('li', {
        className: className.FILE_NAV_ITEM,
      })
      const isCurrentFile = item.path === currentPath
      if (isCurrentFile) {
        li.classList.add(className.FILE_NAV_ITEM_ACTIVE)
      }
      const a = new Ele<HTMLElement>('a', { href: item.path })
      a.textContent = item.name
      if (isCurrentFile) {
        a.ele.style.fontWeight = 'bolder'
        a.ele.style.color = 'var(--color-primary)'
      }
      li.append(a)
      fileNavList.append(li)
    })
  }

  async function loadFileNavDir(dirPath: string) {
    try {
      const resp = await fetch(`/api/dir?path=${encodeURIComponent(dirPath)}`)
      if (!resp.ok) return
      const data = await resp.json()
      renderFileNavItems(data)
    } catch (e) {
      // silently fail
    }
  }

  {
    const currentDir =
      currentPath.substring(0, currentPath.lastIndexOf('/') + 1) || '/'
    loadFileNavDir(currentDir)
  }

  /* ---- TOC panel ---- */
  const tocList = new Ele<HTMLElement>('ul', {
    className: className.MD_SIDE + '-toc',
  })
  tocPanel.append(tocList)

  let idCache: { [content: string]: number } = Object.create(null)
  let headElements: HTMLElement[] = []
  let sideLiElements: HTMLElement[] = []
  let df: Ele<DocumentFragment> = null
  let targetIndex: number = null
  let isSideHover: boolean = false
  let reloading: boolean = false

  sideWrapper.on('mouseenter', () => {
    isSideHover = true
  })
  sideWrapper.on('mouseleave', () => {
    isSideHover = false
  })

  function renderSide() {
    idCache = Object.create(null)
    headElements = getHeads(mdContent)
    df = new Ele<DocumentFragment>('#document-fragment')
    sideLiElements = headElements.reduce(handleHeadItem, [])
    tocList.innerHTML = null
    tocList.append(df)
    setTimeout(onScroll, 0)
  }

  function handleHeadItem(
    eleList: HTMLElement[],
    head: HTMLElement,
  ): HTMLElement[] {
    const content = String(head.textContent).trim()
    const encodeContent = getDecodeContent(content)

    head.setAttribute('id', encodeContent)

    const headAnchor = new Ele<HTMLElement>('a', {
      className: className.HEAD_ANCHOR,
      href: `#${encodeContent}`,
    })
    headAnchor.textContent = '#'
    head.insertBefore(headAnchor.ele, head.firstChild)

    const link = new Ele<HTMLElement>('a', {
      title: content,
      href: `#${encodeContent}`,
    })
    link.textContent = content
    const li = new Ele<HTMLElement>('li', {
      className: `${className.MD_SIDE}-${head.tagName.toLowerCase()}`,
    })
    eleList.push(li.ele)
    li.append(link)
    df.append(li.ele)

    return eleList
  }

  function getDecodeContent(content: string): string {
    return (function unique(key: string): string {
      if (key in idCache) {
        return unique(`${key}-${idCache[key]++}`)
      } else {
        idCache[key] = 1
        return key
      }
    })(encodeURIComponent(content.toLowerCase().replace(/\s+/g, '-')))
  }

  const goTopBtn = new Ele<HTMLElement>(
    'button',
    {
      className: [className.MD_BUTTON, className.GO_TOP_BTN],
      title: 'Go top',
    },
    svg(goTopIcon),
  )
  goTopBtn.hide()
  goTopBtn.on('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }))

  function onScroll() {
    const documentScrollTop = document.documentElement.scrollTop
    goTopBtn.toggle(documentScrollTop >= 640)

    headElements.some((_, index) => {
      let sectionHeight = -20
      const item = headElements[index + 1]
      if (item) {
        sectionHeight += item.offsetTop
      }

      const hit = sectionHeight <= 0 || sectionHeight > documentScrollTop

      if (hit && (targetIndex !== index || reloading)) {
        let target = sideLiElements[targetIndex]
        target && target.classList.remove(className.MD_SIDE_ACTIVE)

        target = sideLiElements[(targetIndex = index)]
        if (target) {
          target.classList.add(className.MD_SIDE_ACTIVE)
          if (!isSideHover && target.scrollIntoView) {
            target.scrollIntoView({ block: 'nearest' })
          }
        }
      }
      return hit
    })
  }

  renderSide()
  document.addEventListener('scroll', throttle(onScroll, 100))

  /* render side expand button */
  const sideExpandBtn = new Ele<HTMLElement>(
    'button',
    {
      className: [className.MD_BUTTON, className.SIDE_EXPAND_BTN],
      title: 'Expand side',
    },
    svg(sideIcon),
  )
  sideExpandBtn.on('click', () => {
    onToggleSide()
  })

  function onToggleSide() {
    if (window.innerWidth <= 960) {
      const value = document.body.classList.toggle(className.SIDE_EXPANDED)
      mdBody.off('click', foldSide, true)
      window.removeEventListener('resize', foldSide)
      document.removeEventListener('keydown', foldSide)
      if (value) {
        setTimeout(() => {
          mdBody.on('click', foldSide, { capture: true, once: true })
          window.addEventListener('resize', foldSide, { once: true })
          document.addEventListener('keydown', foldSide, { once: true })
        }, 0)
      }
    } else {
      configData.hiddenSide = document.body.classList.toggle(
        className.SIDE_COLLAPSED,
      )
    }
  }

  function foldSide(e: UIEvent) {
    if (e.type === 'keydown' && (e as KeyboardEvent).code !== 'Escape') {
      return
    }
    document.body.classList.remove(className.SIDE_EXPANDED)
    mdBody.off('click', foldSide, true)
    window.removeEventListener('resize', foldSide)
    document.removeEventListener('keydown', foldSide)
    e.stopPropagation()
    e.preventDefault()
    return false
  }

  /* ---- TTS (text-to-speech) controls ---- */
  const ttsConfig = loadTTSConfig()

  const ttsBtn = new Ele<HTMLElement>('button', {
    className: [className.MD_BUTTON, className.TTS_BTN],
    title: 'Read aloud',
  })
  ttsBtn.innerHTML = SPEAKER_SVG
  ttsBtn.on('click', async () => {
    const text = extractTextForTTS(mdContent.ele)
    if (!text) return
    await ttsPlayer.play(text)
  })

  const ttsPauseBtn = new Ele<HTMLElement>('button', {
    className: [className.MD_BUTTON, className.TTS_PAUSE_BTN],
    title: 'Pause',
  })
  ttsPauseBtn.innerHTML = PAUSE_SVG
  ttsPauseBtn.hide()
  ttsPauseBtn.on('click', () => ttsPlayer.togglePause())

  const ttsStopBtn = new Ele<HTMLElement>('button', {
    className: [className.MD_BUTTON, className.TTS_STOP_BTN],
    title: 'Stop',
  })
  ttsStopBtn.innerHTML = STOP_SVG
  ttsStopBtn.hide()
  ttsStopBtn.on('click', () => ttsPlayer.stop())

  const ttsSettingsBtn = new Ele<HTMLElement>('button', {
    className: [className.MD_BUTTON, className.TTS_SETTINGS_BTN],
    title: 'TTS Settings',
  })
  ttsSettingsBtn.innerHTML = SETTINGS_SVG
  ttsSettingsBtn.on('click', () => openTTSModal())

  function updateTTSButtons(state: TTSState) {
    switch (state) {
      case 'idle':
        ttsBtn.show()
        ttsPauseBtn.hide()
        ttsStopBtn.hide()
        break
      case 'loading':
        ttsBtn.hide()
        ttsPauseBtn.show()
        ttsPauseBtn.innerHTML = PAUSE_SVG
        ttsPauseBtn.ele.title = 'Loading...'
        ttsStopBtn.show()
        break
      case 'playing':
        ttsBtn.hide()
        ttsPauseBtn.show()
        ttsPauseBtn.innerHTML = PAUSE_SVG
        ttsPauseBtn.ele.title = 'Pause'
        ttsStopBtn.show()
        break
      case 'paused':
        ttsBtn.hide()
        ttsPauseBtn.show()
        ttsPauseBtn.innerHTML = PLAY_SVG
        ttsPauseBtn.ele.title = 'Resume'
        ttsStopBtn.show()
        break
    }
  }

  const ttsPlayer = new TTSPlayer(
    {
      onStateChange: updateTTSButtons,
      onError: msg => {
        console.error('TTS error:', msg)
      },
    },
    ttsConfig,
  )

  /* ---- TTS Settings modal ---- */
  let ttsModal: Ele<HTMLElement> | null = null

  async function openTTSModal() {
    if (ttsModal) return

    let serverModels: string[] = []
    let serverVoices: string[] = []
    let serverConfigured = false
    try {
      const resp = await fetch('/api/tts/config')
      if (resp.ok) {
        const cfg = await resp.json()
        serverModels = cfg.models || []
        serverVoices = cfg.voices || []
        serverConfigured = !!cfg.serverConfigured
      }
    } catch (_) {
      /* noop */
    }

    const saved = loadTTSConfig()

    const overlay = new Ele<HTMLElement>('div', {
      className: className.TTS_MODAL,
    })
    overlay.ele.style.background = 'rgba(0,0,0,0.4)'

    const panel = document.createElement('div')
    panel.className = className.TTS_MODAL + '__panel'

    const fieldset = (label: string, control: string) =>
      `<div class="${className.TTS_MODAL}__field"><label>${label}</label>${control}</div>`

    const apiUrlVal = saved.apiUrl || ''
    const apiKeyVal = saved.apiKey || ''
    const modelVal = saved.model || ''
    const voiceVal = saved.voice || ''
    const speedVal = saved.speed ?? 1

    const modelOptions = (
      serverModels.length
        ? serverModels
        : ['qwen', 'tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'volcengine']
    )
      .map(
        m =>
          `<option value="${m}"${
            m === modelVal ? ' selected' : ''
          }>${m}</option>`,
      )
      .join('')

    const voiceOptions = (
      serverVoices.length
        ? serverVoices
        : [
            'alloy',
            'echo',
            'fable',
            'onyx',
            'nova',
            'shimmer',
            'zh-CN-XiaoxiaoNeural',
            'zh-CN-YunxiNeural',
          ]
    )
      .map(
        v =>
          `<option value="${v}"${
            v === voiceVal ? ' selected' : ''
          }>${v}</option>`,
      )
      .join('')

    panel.innerHTML = `
      <div class="${className.TTS_MODAL}__header">
        <span>TTS Settings</span>
        <button class="${
          className.TTS_MODAL
        }__close" title="Close">&times;</button>
      </div>
      <div class="${className.TTS_MODAL}__body">
        ${
          serverConfigured
            ? `<p class="${className.TTS_MODAL}__hint">Server already has a default API configured. Fill in below to override.</p>`
            : `<p class="${className.TTS_MODAL}__hint">No server-side TTS configured. Provide API URL and Key below.</p>`
        }
        ${fieldset(
          'API URL',
          `<input type="text" data-key="apiUrl" placeholder="https://..." value="${escapeAttr(
            apiUrlVal,
          )}" />`,
        )}
        ${fieldset(
          'API Key',
          `<input type="password" data-key="apiKey" placeholder="Bearer token" value="${escapeAttr(
            apiKeyVal,
          )}" />`,
        )}
        ${fieldset(
          'Model',
          `<select data-key="model"><option value="">(server default)</option>${modelOptions}</select>`,
        )}
        ${fieldset(
          'Voice',
          `<select data-key="voice"><option value="">(server default)</option>${voiceOptions}</select>`,
        )}
        ${fieldset(
          `Speed: <span data-key="speedLabel">${speedVal.toFixed(1)}x</span>`,
          `<input type="range" data-key="speed" min="0.5" max="2" step="0.1" value="${speedVal}" />`,
        )}
      </div>
      <div class="${className.TTS_MODAL}__footer">
        <button class="${className.TTS_MODAL}__btn--save">Save</button>
        <button class="${className.TTS_MODAL}__btn--cancel">Cancel</button>
      </div>
    `

    overlay.ele.appendChild(panel)
    document.body.appendChild(overlay.ele)
    ttsModal = overlay

    overlay.on('click', e => {
      if (e.target === overlay.ele) closeTTSModal()
    })

    panel
      .querySelector('.' + className.TTS_MODAL + '__close')!
      .addEventListener('click', closeTTSModal)
    panel
      .querySelector('.' + className.TTS_MODAL + '__btn--cancel')!
      .addEventListener('click', closeTTSModal)

    const speedInput = panel.querySelector(
      '[data-key="speed"]',
    ) as HTMLInputElement
    const speedLabel = panel.querySelector('[data-key="speedLabel"]')!
    speedInput.addEventListener('input', () => {
      speedLabel.textContent = parseFloat(speedInput.value).toFixed(1) + 'x'
    })

    panel
      .querySelector('.' + className.TTS_MODAL + '__btn--save')!
      .addEventListener('click', () => {
        const newConfig: Partial<TTSConfig> = {}
        ;['apiUrl', 'apiKey', 'model', 'voice'].forEach(k => {
          const input = panel.querySelector(`[data-key="${k}"]`) as
            | HTMLInputElement
            | HTMLSelectElement
          const val = (input as HTMLInputElement).value.trim()
          if (val) (newConfig as any)[k] = val
        })
        const speed = parseFloat(speedInput.value)
        if (!isNaN(speed) && speed > 0) newConfig.speed = speed

        saveTTSConfig(newConfig)
        ttsPlayer.updateConfig(newConfig)
        closeTTSModal()
      })
  }

  function closeTTSModal() {
    if (ttsModal) {
      ttsModal.remove()
      ttsModal = null
    }
  }

  function escapeAttr(s: string): string {
    return s.replace(/"/g, '&quot;').replace(/</g, '&lt;')
  }

  const buttonWrap = new Ele<HTMLElement>(
    'div',
    { className: className.BUTTON_WRAP_ELE },
    [sideExpandBtn, goTopBtn, ttsBtn, ttsPauseBtn, ttsStopBtn, ttsSettingsBtn],
  )

  lifecycle.mount([buttonWrap, mdBody, sideWrapper])

  function updateAnchorPosition() {
    if (window.location.hash) {
      setTimeout(() => {
        const hash = window.location.hash.slice(1)
        const target = headElements.find(head => {
          return head.getAttribute('id') === hash
        })
        if (target) {
          const top = target.offsetTop
          top && window.scrollTo(0, top)
        }
      })
    }
  }
  updateAnchorPosition()
}

initWebApp()
