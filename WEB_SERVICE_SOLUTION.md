# 将 md-reader 作为 Web 服务的架构方案（纯前端渲染，Web 服务托管）

根据需求，核心目标是**使用前端渲染（保持现有交互和渲染逻辑），并将 Markdown 文件和所有的静态资源（JS/CSS）从服务器加载，而不是以 Chrome 插件的形式运行**。

`md-reader` 原本是一个 Chrome 扩展，其主要逻辑（`src/main.ts`）依赖于监听当前页面的 `document.contentType` 以及通过 `getRawContainer` 获取页面的原始 Markdown 文本（浏览器直接打开 `.md` 时的文本节点）。

要将其改造为一个普通的 Web 服务，我们需要提供一个静态 HTML 页面作为入口。这个页面会加载改写后的前端 JS 脚本，由前端去服务器请求 Markdown 文本（或者由服务器模板注入文本），然后再在浏览器端执行同样的 Markdown-It 渲染过程。

## 1. 核心思路

1.  **构建静态托管服务**：使用 Express、Nginx 或类似服务器提供 Web 服务。该服务将托管修改后的 `md-reader` 静态资源（HTML、JS、CSS）。
2.  **修改入口 HTML**：不再依赖 Chrome 扩展的注入，而是提供一个标准的 `index.html`。页面中包含用于挂载内容的节点和引用打包后 JS/CSS 的 `<script>` 与 `<link>` 标签。
3.  **适配数据获取方式**：在原本的扩展中，Markdown 文本是从浏览器直接展示的 `body > pre` 中获取的（`getRawContainer`）。在 Web 服务模式下，我们需要让前端 JS 通过 `fetch` 或者 URL 参数请求后端的 Markdown 文件并加载内容。
4.  **移除扩展 API 依赖**：移除 `chrome.runtime.sendMessage` 和 `chrome.runtime.onMessage` 等 Chrome API 调用，改用纯前端的事件或状态管理。

## 2. 改造步骤

### 第一步：修改打包配置以构建 Web 版本

修改 `webpack.common.js` 和打包脚本。原项目将入口打包为 `content.js`、`background.js` 等，这是典型的扩展结构。我们需要为其添加一个 Web 专用入口，并借助 `HtmlWebpackPlugin` 生成 HTML。

```javascript
// build/webpack.web.js (新建)
const { resolve } = require('path')
const { merge } = require('webpack-merge')
const common = require('./webpack.common.js')
const HtmlWebpackPlugin = require('html-webpack-plugin')

module.exports = merge(common, {
  entry: {
    app: resolve(__dirname, '../src/web-main.ts'), // 新的 Web 入口
  },
  // 覆盖 output 等配置，不再输出到 extension，而是输出到 dist
  output: {
    filename: 'js/[name].js',
    path: resolve(__dirname, '../dist'),
    publicPath: '/'
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: resolve(__dirname, '../public/index.html'),
      filename: 'index.html'
    })
  ]
})
```

### 第二步：创建 HTML 模板

在 `public/index.html` 中提供基础骨架：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Markdown Reader Web</title>
  <!-- 主题依赖 -->
  <link rel="stylesheet" href="https://unpkg.com/@md-reader/theme/dist/index.css">
</head>
<body class="md-reader" data-theme="light">
  <!-- 用于存放通过 AJAX 获取的原始 Markdown 的容器 -->
  <pre id="raw-markdown-container" style="display: none;"></pre>
</body>
</html>
```

### 第三步：适配前端主逻辑（`src/web-main.ts`）

我们需要基于 `src/main.ts` 创建一个 `web-main.ts`，去除 Chrome API 依赖，并加入网络请求获取 `.md` 文件的逻辑。

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

// 1. 获取要渲染的 Markdown 文件 URL (可通过查询参数传递，例如 /?file=example.md)
const urlParams = new URLSearchParams(window.location.search);
const fileUrl = urlParams.get('file') || '/example.md'; // 默认文件

async function initWebApp() {
  const configData = getDefaultData({}); // 使用默认配置，因为没有 storage 了
  let mdRaw = '';

  try {
    // 2. 通过 fetch 从服务器获取 Markdown 内容
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error('File not found');
    mdRaw = await response.text();
  } catch (e) {
    document.body.innerHTML = '<h1>Markdown file load failed.</h1>';
    return;
  }

  // 3. 将内容存入 raw container 适配旧逻辑
  const rawContainer = document.getElementById('raw-markdown-container');
  if (rawContainer) rawContainer.textContent = mdRaw;

  // 4. 复用 md-reader 原本的初始化和渲染流程
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

  // 渲染侧边栏 TOC (省略具体细节，直接复用原版 renderSide 的实现)
  // renderSide();

  // 挂载到 body
  lifecycle.mount([mdBody, mdSide]);
}

initWebApp();
```

### 第四步：部署一个简单的静态 Web Server

项目打包生成 `dist/` 目录后，里面包含了 `index.html` 以及编译后的前端渲染脚本。

我们只需要使用一个最简单的 Web 服务器即可托管它，并将 Markdown 文件和这些静态资源放在一起。

使用 Express 搭建示例：

```javascript
// server/index.js
const express = require('express');
const path = require('path');
const app = express();

// 1. 静态托管前端打包好的 js、css 和 index.html
app.use(express.static(path.join(__dirname, '../dist')));

// 2. 静态托管 Markdown 文件存放目录，允许前端 fetch 这些文件
app.use('/files', express.static(path.join(__dirname, '../markdown_files')));

// 例如：访问 http://localhost:3000/?file=/files/doc.md
// 前端 web-main.js 就会 fetch /files/doc.md 并进行前端渲染

app.listen(3000, () => {
  console.log('Web server is running on http://localhost:3000');
});
```

## 总结

这种方案下，**渲染依然发生在浏览器端**，原有的交互（点击复制代码、侧边栏跳转、代码高亮等）能够100%保留。我们所做的仅仅是：
1. 取消了 Chrome 扩展的打包形式和 API 调用。
2. 将 `md-reader` 的所有前端逻辑打包成标准的网页 JS 资源。
3. 利用普通的 Web 服务器托管这些 JS 资源和 Markdown 文本，前端通过 AJAX 拉取文本后执行原本的渲染流程。
