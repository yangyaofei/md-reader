# md-reader Web 架构实现文档

本文档详细说明如何将原本以 Chrome 扩展为核心的 `md-reader` 改造为支持纯 Web 服务部署的架构，同时保持原有扩展功能的完整性，做到一套核心代码，两端运行。

## 1. 架构与改造思路

我们的目标是让用户可以通过浏览器直接访问形如 `http://your-server/path/to/doc.md` 的 URL，直接预览渲染后的 Markdown。同时：
- **不使用 Nginx**，而是基于 Node.js (Express) 构建独立服务。
- **复用前端渲染逻辑**，原有的 `src/core/markdown.ts`、样式、主题、插件配置等保持不变，避免重复开发。
- **剥离 Chrome API**，原有 `main.ts` 中强依赖 `chrome.storage`、`chrome.runtime.sendMessage` 的部分不适用于 Web 环境，需要建立独立的 Web 入口。

### 请求流程

1. **用户访问 Markdown 路径**：例如 `GET /docs/api.md`
2. **Node 服务端拦截请求**：
   - 如果后缀是 `.md`，不再直接返回纯文本。
   - 返回一个统一的基础 HTML 骨架 (`server/index.html`)。
3. **前端接管并获取原始数据**：
   - 基础 HTML 骨架加载专为 Web 端打包的核心脚本 `/js/web-main.js`。
   - `/js/web-main.js` 启动后，读取当前页面 URL (`window.location.pathname`)。
   - 前端发起 `fetch('/raw/docs/api.md')` 请求，要求服务器返回真实的 Markdown 纯文本。
4. **前端完成渲染**：
   - 服务端针对 `/raw` 路由透传本地的真实文件内容。
   - 前端获取到纯文本后，复用 `md-reader` 核心的渲染逻辑生成 DOM 树并挂载。

## 2. 具体修改点与新增文件

为了不破坏现有的 Chrome 扩展代码（如 `main.ts`、`background.ts` 等），本次改造采用**增量添加**的方式。

### 2.1 新增 Webpack 配置 `build/webpack.web.js`

由于 Web 端的入口和输出路径不同，新建一份 Web 专用的打包配置，继承自 `webpack.common.js`。

- **职责**：指定入口为新的 `src/web-main.ts`，输出到 `dist/js/web-main.js`。
- **注意**：我们不生成 Chrome 扩展的 `manifest.json` 或 `popup.html`，只输出必要的 JS/CSS 资源。

### 2.2 新增 Web 端专有入口 `src/web-main.ts`

这是核心改造点。原有的 `src/main.ts` 强依赖 `chrome.*` API 和 `document.contentType` 判断。我们新建 `web-main.ts`，专注于 Web 端的生命周期。

- **核心步骤**：
  1. 初始化默认配置 (`getDefaultData`) 和插件系统 (`initPlugins`)。
  2. 获取当前 URL 的 `pathname`，如果不是 `.md` 结尾则不处理或给出提示。
  3. 拼接 `/raw` 前缀，通过 `fetch` 请求原始 Markdown 文本。
  4. 构建虚拟的 `rawContainer` (`<pre id="raw-markdown-container">`) 隐藏插入页面，以兼容原有 `lifecycle` 逻辑。
  5. 调用 `mdRender` 将获取到的文本渲染为 HTML。
  6. 创建 `main` (内容区) 和 `ul` (侧边栏目录) 节点并挂载 (`lifecycle.mount`)。
  7. 构建侧边栏 (`renderSide`)。

### 2.3 新增服务端骨架 HTML `server/index.html`

为单页应用风格的加载提供入口。

- **职责**：包含基础的 HTML 结构，并且引用前端打包输出的样式 (`/css/app.css`) 和脚本 (`/js/app.js` 或 `/js/web-main.js`)。
- **特点**：所有 `.md` 请求都会由 Express 统一返回此页面。

### 2.4 新增 Express 服务脚本 `server/index.js`

这是替代 Nginx 的服务端实现。

- **职责**：
  1. **静态资源托管**：将 Webpack 打包的 `dist` 目录暴露，以供加载 JS/CSS。
  2. **原始文件代理**：提供 `/raw` 路由，映射到存放 Markdown 文件的目录 (例如 `markdown_files` 或项目根目录下的示例文件夹)，返回 `text/plain` 原始数据。
  3. **单页路由拦截**：拦截 `/*.md` 请求，全部返回 `server/index.html`。

### 2.5 修改 `package.json` 增加脚本

为了方便运行和构建 Web 服务，新增以下 NPM Scripts：

- `"build:web"`: 使用 `webpack --config ./build/webpack.web.js` 进行构建。
- `"serve:web"`: 使用 `node server/index.js` 启动本地预览服务。
- 新增依赖 `express`。

## 3. 对现有代码的引用分析

新的 `web-main.ts` 仅仅是**引用**现有的核心模块，**没有修改**任何现有的核心业务代码。

引用的主要现存模块包括：
- `src/core/markdown.ts`: 负责调用 `markdown-it` 进行语法解析并生成 HTML 字符串。
- `src/core/lifecycle.ts`: 负责页面的初始化样式挂载。
- `src/core/data.ts`: 提供 `getDefaultData` 以获取默认主题、开关配置。
- `src/plugins/index.ts`: 初始化事件系统插件。
- `src/shared/index.ts`: 包含各种帮助函数（例如 `getHeads`, `setTheme` 等）。

通过这种方式，我们隔离了“宿主环境逻辑”（Web vs Chrome Extension）与“核心渲染逻辑”，实现了优雅的跨端支持。
