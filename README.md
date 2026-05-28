# PPT InteractiveWebPage

> 让文档活起来 — 上传 PDF/图片，AI 将其重构为沉浸式 3D 交互网页。

## 项目概览

```
┌──────────────────────────────────────────────────────┐
│  Frontend (Cloudflare Pages)                         │
│  index.html  → Portal 着陆页                          │
│  app.html    → 核心工具页 (上传/配置/执行/结果)         │
│  demo.html   → 3D 交互模板 (Three.js + GSAP)         │
├──────────────────────────────────────────────────────┤
│  Backend (Cloudflare Worker)                         │
│  /api/evolve    → AI 演化 (SSE 流式)                  │
│  /api/store     → R2 存储 + 永久链接                  │
│  /p/:id         → 生成页面检索                        │
│  Rate Limit + Cache + Retry                          │
├──────────────────────────────────────────────────────┤
│  Storage                                             │
│  R2: 生成的 HTML 页面                                 │
│  KV: 元数据 + 速率限制 + 响应缓存                     │
└──────────────────────────────────────────────────────┘
```

## 快速开始

### 本地开发 (无需部署)

```bash
# 1. 启动前端静态服务器
cd frontend/public
python3 -m http.server 3000

# 2. 打开浏览器
# http://localhost:3000/index.html  → Portal 页
# http://localhost:3000/app.html    → 工具页
# http://localhost:3000/demo.html   → 3D 演示页

# 3. (可选) 启动 Worker 本地开发
cd worker
npm install -g wrangler
wrangler dev
```

### 部署到 Cloudflare

```bash
# 完整部署步骤见 docs/deployment.md
# 快速版:
cd worker
wrangler kv:namespace create "KV"     # 创建 KV
wrangler r2 bucket create PAGES       # 创建 R2
wrangler secret put DEEPSEEK_API_KEY  # 配置 API Key
wrangler deploy                       # 部署 Worker

cd ../frontend
npx wrangler pages deploy public --project-name ppt-interactive-webpage
```

## 文件结构

```
ppt-interactive-webpage/
├── frontend/public/
│   ├── index.html          # Portal 着陆页 (498 行)
│   ├── app.html            # 核心工具页 (905 行)
│   └── demo.html           # 3D 交互模板 (592 行)
├── worker/
│   ├── wrangler.toml       # Worker 配置
│   └── src/
│       └── index.js        # Worker API 网关 (541 行)
├── docs/
│   ├── deployment.md       # 部署指南
│   └── plans/
│       └── implementation-plan.md
└── README.md               # 本文件
```

## 核心功能

### 1. 多格式上传
- **PDF**: pdf.js 客户端解析 → 文本提取 + 高分辨率渲染
- **图片**: JPG/PNG/WebP/TIFF → Base64 编码
- 拖拽上传 + 文件预览缩略图
- 快捷键 ⌘U 快速上传

### 2. AI 双引擎
- **DeepSeek** (deepseek-chat): OpenAI 兼容格式
- **Claude** (claude-sonnet-4): Anthropic Messages 格式
- SSE 流式响应 + 统一格式转换
- 自动重试 (429/500/503, 指数退避)

### 3. 3D 交互生成
- Three.js WebGL 场景 (几何体 + 光源)
- GSAP ScrollTrigger 滚动叙事
- 鼠标视差追踪 (物理 Lerp)
- Canvas 2D 粒子系统
- 自包含 HTML (离线可运行)

### 4. 云存储
- R2 永久存储 + 内容去重
- KV 元数据 + 30 天自动过期
- 永久链接: /p/{12位hex ID}

### 5. 安全与限流
- 每 IP 每分钟 10 次请求限制
- 输入验证 (50~500K 字符)
- API Key 仅会话内使用
- CORS 跨域保护

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `⌘U` | 上传文件 |
| `⌘Enter` | 执行演化 |
| `⌘K` | 快速开始 |
| `Esc` | 关闭面板 |

## 技术栈

| 组件 | 技术 |
|------|------|
| 前端 | HTML5 + Tailwind CSS CDN + Vanilla JS |
| 3D 渲染 | Three.js r128 (WebGL) |
| 动画 | GSAP 3.12 + ScrollTrigger |
| PDF 解析 | pdf.js 3.11 (客户端) |
| 后端 | Cloudflare Workers |
| 存储 | Cloudflare R2 + KV |
| AI | DeepSeek API + Claude API |

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/config` | GET | 提供商配置 |
| `/api/evolve` | POST | AI 演化 (SSE 流式) |
| `/api/store` | POST | 存储 HTML 到 R2 |
| `/p/:id` | GET | 访问生成的页面 |
| `/api/page/:id` | GET | 页面元数据 |
| `/api/page/:id` | DELETE | 删除页面 |

## Cloudflare 免费额度

| 资源 | 免费额度 |
|------|----------|
| Workers | 100K 请求/天 |
| R2 | 10GB 存储 + 1000万次操作/月 |
| KV | 100K 读/天 + 1000 写/天 |
| Pages | 无限静态请求 |

## License

MIT
