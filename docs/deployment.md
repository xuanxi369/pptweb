# PPT InteractiveWebPage — 部署指南

## 前置条件

- Node.js 18+
- Cloudflare 账户 (免费即可)
- Wrangler CLI (`npm i -g wrangler`)

## 1. 登录 Cloudflare

```bash
wrangler login
```

## 2. 创建 KV Namespace

```bash
cd worker
wrangler kv:namespace create "KV"
```

输出类似:
```
{ binding = "KV", id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

将 `id` 填入 `wrangler.toml` 的 `[[kv_namespaces]]` 部分。

## 3. 创建 R2 Bucket

```bash
wrangler r2 bucket create PAGES
```

## 4. 配置 API Keys (Secrets)

```bash
# DeepSeek API Key
wrangler secret put DEEPSEEK_API_KEY

# Claude API Key (可选)
wrangler secret put CLAUDE_API_KEY
```

## 5. 更新 wrangler.toml

取消注释并填入实际 ID:

```toml
[[kv_namespaces]]
binding = "KV"
id = "你的KV_NAMESPACE_ID"

[[r2_buckets]]
binding = "R2"
bucket_name = "PAGES"
```

## 6. 部署 Worker

```bash
wrangler deploy
```

记下输出的 Worker URL，例如:
```
https://ppt-evolution-worker.你的子域.workers.dev
```

## 7. 更新前端 WORKER_URL

编辑 `frontend/public/app.html`，将 `WORKER_URL` 替换为实际 Worker URL:

```javascript
const WORKER_URL = 'https://ppt-evolution-worker.你的子域.workers.dev';
```

## 8. 部署前端到 Cloudflare Pages

```bash
cd frontend
npx wrangler pages deploy public --project-name ppt-interactive-webpage
```

## 9. 配置 Pages 路由 (可选)

如果希望用自定义域名访问生成的页面:

1. 在 Cloudflare Dashboard → Pages → ppt-interactive-webpage → Settings → Functions
2. 添加路由规则: `/p/*` → Worker

或者直接通过 Worker URL 访问: `https://worker-url/p/{id}`

## API 端点一览

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/config` | GET | 提供商配置 |
| `/api/evolve` | POST | AI 演化 (SSE 流式) |
| `/api/store` | POST | 存储 HTML 到 R2 |
| `/api/page/:id` | GET | 获取页面元数据 |
| `/api/page/:id` | DELETE | 删除页面 |
| `/p/:id` | GET | 访问生成的页面 |

## 环境变量

| 变量 | 类型 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | Secret | DeepSeek API 密钥 |
| `CLAUDE_API_KEY` | Secret | Claude API 密钥 |
| `ALLOWED_ORIGIN` | Var | CORS 允许的源 (默认 *) |
| `MODEL_PROVIDER` | Var | 默认 AI 提供商 |

## 限制

- Cloudflare Workers 免费版: 10ms CPU 时间/请求
- Cloudflare Workers 付费版 ($5/月): 30s CPU 时间/请求
- R2: 免费 10GB 存储 + 1000 万次 Class A 操作/月
- KV: 免费 100K 读/天 + 1000 写/天
- 页面默认 30 天过期 (可调整 `PAGE_TTL_SECONDS`)

## 本地开发

```bash
# 终端 1: Worker
cd worker
wrangler dev

# 终端 2: 前端
cd frontend/public
python3 -m http.server 3000
```

访问 http://localhost:3000
