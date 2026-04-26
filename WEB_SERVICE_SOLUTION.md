# 将 md-reader 作为 Web 服务的架构方案

`md-reader` 核心上是一个在客户端运行的 Chrome 插件，依靠浏览器提供的环境渲染和高亮 Markdown。为了将其转变为一个能够读取并渲染服务器上 Markdown 文件的 Web 服务，我们需要将渲染逻辑从客户端剥离，迁移到 Node.js 环境中。

## 1. 核心思路

1. **分离渲染核心与浏览器依赖**：
   `md-reader` 的 Markdown 渲染主要在 `src/core/markdown.ts` 中完成。该文件中包含了一些依赖 DOM 和前端特性的代码（例如 `highlight.js` 直接生成带 `SVG` 复制按钮的代码、引用的 `Ele` 类封装）。
   需要剥离这些浏览器依赖（`window`, `document`, DOM API 等），只保留 `markdown-it` 及其插件配置。
2. **构建服务端入口**：
   使用 Node.js 框架（如 Express、Koa 或 Fastify）来接收网络请求。服务器读取本地或者远程的 Markdown 文件内容。
3. **输出完整 HTML**：
   将 Markdown 内容通过剥离依赖后的 `markdown-it` 转换为 HTML 字符串。
   然后将这个 HTML 字符串嵌入到一个基础 HTML 模板中。该模板需要引入原版 `md-reader` 依赖的 CSS 样式文件（如 `@md-reader/theme` 的主题样式和内置代码高亮样式）。

## 2. 改造步骤

### 第一步：抽象纯净的 Markdown 渲染器

在现有的 `src/core/markdown.ts` 基础上，创建一个服务端专用的渲染器 `server-markdown.ts`。

主要的改动是移除所有与 UI 强绑定的元素：
- 移除 `copyButton.ele.outerHTML` 的拼接。
- 移除对 `@/images/icon_success.svg` 和 `Ele` 的导入。
- 确保所有的 `markdown-it` 插件在 Node 环境中也能正常运行（绝大多数插件都是同构的）。

```typescript
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
// 导入其他 markdown-it 插件...

export function initServerRender() {
  const md = new MarkdownIt({
    html: true,
    breaks: false,
    linkify: true,
    xhtmlOut: true,
    typographer: true,
    highlight(str: string, language: string) {
      if (language && hljs.getLanguage(language)) {
        try {
          return `<pre class="hljs-pre md-reader__code-block"><code class="hljs" lang="${language}">${
            hljs.highlight(str, { language, ignoreIllegals: true }).value
          }</code></pre>`
        } catch (err) {
          console.error(err)
        }
      }
      return `<pre class="hljs-pre md-reader__code-block"><code class="hljs ${language}">${md.utils.escapeHtml(str)}</code></pre>`
    }
  })
  // 注册各类插件
  // md.use(...)
  return md
}
```

### 第二步：搭建 Node.js Web 服务

在项目中引入 `express`，建立一个简单的服务器：

```bash
npm install express
npm install -D @types/express ts-node
```

创建 `server/index.ts`：

```typescript
import express from 'express'
import fs from 'fs'
import path from 'path'
import { initServerRender } from './server-markdown' // 第一步中创建的渲染器

const app = express()
const mdRenderer = initServerRender()

app.get('/render', (req, res) => {
  const fileQuery = req.query.file as string
  if (!fileQuery) {
    return res.status(400).send('Missing "file" parameter')
  }

  const filePath = path.resolve(__dirname, '../data', fileQuery)

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found')
  }

  const markdownContent = fs.readFileSync(filePath, 'utf-8')

  // 过滤 Frontmatter（可选，复用原逻辑）
  const filteredCode = markdownContent.replace(/^---[\s\S]+?---\n/, '')
  const htmlContent = mdRenderer.render(filteredCode)

  // 基础 HTML 骨架，引入 md-reader-theme 以保留原生样式
  const fullHtml = `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Markdown Reader Server</title>
    <!-- 引入 md-reader 的主题样式 -->
    <link rel="stylesheet" href="https://unpkg.com/@md-reader/theme/dist/index.css">
    <style>
      /* 可在此处加入必要的样式重置和适配 */
      body.md-reader { padding: 2rem; max-width: 900px; margin: auto; }
    </style>
  </head>
  <body class="md-reader" data-theme="light">
    <main class="md-reader__body">
      <article class="md-reader__content">
        ${htmlContent}
      </article>
    </main>
  </body>
  </html>
  `

  res.send(fullHtml)
})

app.listen(3000, () => {
  console.log('Markdown Web Service listening on http://localhost:3000')
})
```

### 第三步：运行和测试

配置 `package.json` 的 scripts 快速启动服务：
```json
"scripts": {
  "start:server": "ts-node server/index.ts"
}
```

将你想渲染的 Markdown 文件放入服务允许读取的目录（例如 `data/` 目录），然后访问 `http://localhost:3000/render?file=test.md`，即可看到完全继承了 `md-reader` 主题与组件的网页内容。

## 3. 进阶功能考量

1. **缓存机制**：对于不频繁变更的 Markdown 文件，渲染后的 HTML 应该被缓存（内存缓存或 Redis），避免高并发下重新解析消耗 CPU。
2. **热更新支持**：如果希望客户端页面能在文件变动时自动刷新，可以在 Node 服务端监听文件变更（`fs.watch` 或 `chokidar`），并通过 WebSocket (如 `socket.io`) 通知前端刷新页面，这正是原先 Chrome Extension 中 `pollingTimer` 功能的服务端替代版。
3. **侧边栏大纲（TOC）**：目前服务端直接吐出的 HTML 缺少侧边栏，如果需要实现类似 Extension 的目录树，可以利用 `markdown-it-table-of-contents`，或者在生成的 HTML 中解析 H1-H6 标签，交由前端的一段极小 JS 脚本来动态生成侧边栏。
