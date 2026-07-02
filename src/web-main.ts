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
import { TTSPlayer, extractTextForTTS, type TTSState } from '@/core/tts'
import '@/style/index.less'
import throttle from 'lodash.throttle'

const FOLDER_SVG = `<svg viewBox="0 0 24 24" width="1.2em" height="1.2em" fill="currentColor"><path d="M3.2 21Q1 21 1 18.75V5.25Q1 3 3.2 3h6.18q.54 0 .93.4l1.61 1.65q.19.2.46.2H20.8Q23 5.25 23 7.5V18.75Q23 21 20.8 21zm1-2.25h15.6q.55 0 .55-.55V8.5q0-.55-.55-.55h-8.29q-.54 0-.93-.4L9.19 5.9q-.19-.2-.46-.2H4.2q-.55 0-.55.55v11.5q0 .55.55.55"/></svg>`

const SPEAKER_SVG = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`

const PAUSE_SVG = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`

const PLAY_SVG = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M8 5v14l11-7L8 5z"/></svg>`

const STOP_SVG = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M6 6h12v12H6V6z"/></svg>`

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

  const ttsPlayer = new TTSPlayer({
    onStateChange: updateTTSButtons,
    onError: msg => {
      console.error('TTS error:', msg)
    },
  })

  const buttonWrap = new Ele<HTMLElement>(
    'div',
    { className: className.BUTTON_WRAP_ELE },
    [sideExpandBtn, goTopBtn, ttsBtn, ttsPauseBtn, ttsStopBtn],
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
