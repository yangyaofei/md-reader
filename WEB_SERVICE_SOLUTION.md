# 将 md-reader 改造为基于 Web 服务的 Markdown 渲染器

根据需求：需要实现直接访问类似 `http://web-server/something.md` 就能看到渲染后的 Markdown。具体实现方式依然是**前端渲染**。并且，**不使用 Nginx，而是直接使用 Node.js (如 Express) 或 Python (如 FastAPI) 来处理请求**。

服务器的职责是：
1. 拦截对 `*.md` 的访问，返回一个包含公用渲染脚本的骨架 HTML 页面。
2. 拦截对 `/raw/*.md` 的访问，返回对应目录下的真实 Markdown 文本内容。
3. 托管 `md-reader` 所需的所有打包后的公共静态资源（JS/CSS）。

## 1. 核心架构与请求流程

**举例：用户访问 `http://localhost:3000/docs/api.md`**

1. **浏览器发送请求**：GET `/docs/api.md`
2. **Web Server 拦截**：Node.js 或 FastAPI 检测到这是一个针对 `.md` 文件的请求。它**不返回**纯文本，而是返回一个通用的 `index.html` 骨架页面。
3. **加载公共资源**：浏览器解析 `index.html`，加载 CSS 和我们打包好的核心渲染脚本 `/js/web-main.js`。
4. **前端发起数据请求**：`web-main.js` 执行。它获取当前页面的 URL 路径（即 `/docs/api.md`），将请求路径改写为指向真实文件内容的接口（例如加上前缀：`/raw/docs/api.md`），并使用 `fetch()` 发起请求获取原始 Markdown 内容。
5. **前端渲染**：获取到 Markdown 纯文本后，复用原 Chrome 插件的 `src/core/markdown.ts` 逻辑，将其转换为 HTML，并挂载到页面 DOM 中，生成侧边栏等组件。

## 2. 改造步骤与示例

### 第一步：修改打包配置生成公用 JS

我们需要将依赖 Chrome 扩展环境的 `main.ts` 改造成纯 Web 逻辑的 `web-main.ts`，并修改 Webpack 配置。

修改 `build/webpack.common.js` 或创建一个针对 Web 的配置 `build/webpack.web.js`：

```javascript
// build/webpack.web.js
const { resolve } = require('path')
const { merge } = require('webpack-merge')
const common = require('./webpack.common.js')

module.exports = merge(common, {
  entry: {
    app: resolve(__dirname, '../src/web-main.ts'), // 新的 Web 端入口
  },
  output: {
    filename: 'js/web-main.js',
    path: resolve(__dirname, '../dist'),
    publicPath: '/' // 确保嵌套路由下能够正确加载根目录的 JS
  }
  // 移除 CopyWebpackPlugin 中处理 manifest.json 和扩展页面的逻辑
})
```

### 第二步：编写纯 Web 端的渲染入口

创建 `src/web-main.ts`。在这个文件里，我们需要获取当前 URL 对应的 Markdown 原始文本，并进行渲染。

```typescript
import Event from '@/core/event'
import Ele, { svg } from '@/core/ele'
import { initPlugins } from '@/plugins'
import lifecycle from '@/core/lifecycle'
import className from '@/config/class-name'
import { getDefaultData } from '@/core/data'
import { mdRender } from '@/core/markdown'
import { getHeads, setTheme, toTheme } from '@/shared'
import '@/style/index.less'

async function initWebApp() {
  const configData = getDefaultData({}); // 使用默认配置
  let mdRaw = '';

  // 核心逻辑：获取当前访问的路径，例如 /docs/api.md
  const currentPath = window.location.pathname;

  // 如果访问的不是以 .md 结尾，或者根路径，这里可以做默认处理
  if (!currentPath.endsWith('.md')) {
    document.body.innerHTML = '<h1>请访问具体的 .md 文件</h1>';
    return;
  }

  // 拼接获取原始文件的 URL。例如后端将原始文件暴露在 /raw/docs/api.md
  const rawFileUrl = `/raw${currentPath}`;

  try {
    const response = await fetch(rawFileUrl);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    mdRaw = await response.text();
  } catch (e) {
    document.body.innerHTML = `<h1>Markdown file load failed.</h1><p>${e.message}</p>`;
    return;
  }

  // 构建一个隐藏的原始文本容器，兼容 md-reader 原有生命周期逻辑
  const rawContainer = document.createElement('pre');
  rawContainer.id = 'raw-markdown-container';
  rawContainer.style.display = 'none';
  rawContainer.textContent = mdRaw;
  document.body.appendChild(rawContainer);

  // === 以下逻辑复用原 src/main.ts 的渲染流程 ===
  let globalEvent = new Event();
  initPlugins({ event: globalEvent });
  setTheme(configData.pageTheme);

  const mdContent = new Ele<HTMLElement>('article', {
    className: `${className.MD_CONTENT} ${configData.centered ? 'centered' : ''}`,
  });

  const contentRender = (code: string = '') => {
    mdContent.ele.innerHTML = mdRender(code, {
      theme: toTheme(configData.pageTheme),
      plugins: configData.mdPlugins,
    });
  };

  contentRender(mdRaw);

  const mdBody = new Ele<HTMLElement>('main', { className: className.MD_BODY }, mdContent);
  const mdSide = new Ele<HTMLElement>('ul', { className: className.MD_SIDE });

  // (侧边栏和其它交互的初始化按需接入)

  lifecycle.mount([mdBody, mdSide]);
}

initWebApp();
```

### 第三步：设计通用骨架 HTML

创建一个基础的 HTML 模板 `dist/index.html`。无论用户访问哪一级的目录（如 `/a.md` 或 `/foo/bar/b.md`），服务器都会返回这个页面。

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Markdown Reader</title>
  <!-- 引入主题样式 -->
  <link rel="stylesheet" href="https://unpkg.com/@md-reader/theme/dist/index.css">
</head>
<body class="md-reader" data-theme="light">
  <!-- web-main.js 会在这里动态注入渲染后的 DOM -->
  <!-- 注意路径使用绝对路径 /js/web-main.js，保证在多级路由下加载正常 -->
  <script src="/js/web-main.js"></script>
</body>
</html>
```

### 第四步：编写服务端代码 (Node.js/Express)

我们需要编写一个 Express 脚本，用于托管资源和处理路由转发。

新建 `server/index.js`：

```javascript
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const MARKDOWN_DIR = path.join(__dirname, '../markdown_files'); // 真实MD文件存放的根目录
const PUBLIC_DIR = path.join(__dirname, '../dist'); // 前端打包输出目录，包含 index.html 和 js/web-main.js

// 1. 静态托管公共 JS 和 CSS
// 访问 /js/web-main.js 时，会从 PUBLIC_DIR 寻找
app.use(express.static(PUBLIC_DIR));

// 2. 暴露真实的 Markdown 文件内容接口
// 当前端请求 /raw/something.md 时，会映射到 MARKDOWN_DIR/something.md 并返回纯文本
app.use('/raw', express.static(MARKDOWN_DIR));

// 3. 拦截所有的 .md 请求，返回通用的 index.html 骨架，由前端去加载 js 进行渲染
app.get('/*.md', (req, res) => {
  // 不论请求的具体是哪一层级的 md，都返回相同的骨架 html
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// 处理根路径或其他未匹配情况
app.get('/', (req, res) => {
  res.send('Welcome to Markdown Web Reader. Please navigate to a specific .md file (e.g., /readme.md).');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Markdown Web Server is running on http://localhost:${PORT}`);
});
```

### 总结测试

1. 确保将包含 Markdown 的文件夹放在根目录下的 `markdown_files` 目录中，例如 `markdown_files/test.md`。
2. 运行 `node server/index.js` 启动服务器。
3. 浏览器访问 `http://localhost:3000/test.md`。
   - 服务器会返回 `dist/index.html` 骨架页面。
   - 骨架页面加载 `/js/web-main.js`。
   - `web-main.js` 获取到当前路径为 `/test.md`，使用 `fetch('/raw/test.md')` 向后端请求文件内容。
   - 服务器通过 `/raw` 路由提供 `markdown_files/test.md` 的原文。
   - 前端接收到文本后，执行 `markdown-it` 解析并渲染出内容页面。
