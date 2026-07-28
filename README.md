# cfqm

> Cloudflare Workers 版 Emby 事件监听 → 多渠道通知。无服务器、全球 CDN、自带 HTTPS。

`cfqm` 部署在 Cloudflare Workers 上，接收 Emby 的 Webhook 事件（入库 / 播放 / 停止），按可配置规则推送到 Telegram / Bark / 自定义 Webhook。配置存在 Cloudflare KV 里，通过 Telegram 管理 Bot 在线修改，改完即时生效。

## 功能

- 🎬 **Emby 事件监听**：接收 Emby Webhook，解析入库 / 播放 / 停止事件
- 📡 **多渠道推送**：Telegram（含海报）、Bark、通用 Webhook
- 📋 **通知规则**：每种事件独立开关、文案模板、是否带海报
- 🖼️ **海报自动构造**：根据 Emby 地址 + item_id 自动拼海报 URL
- 🤖 **TG 管理 Bot**：管理员在 Telegram 点按钮改规则和渠道，改完即时生效
- ☁️ **无服务器**：跑在 Cloudflare Workers 上，免费额度每天 10 万次请求
- 🔒 **自带 HTTPS**：Emby webhook 直接 `https://xxx.workers.dev/emby/webhook`

## 与 Python 版 qm 的区别

| | qm (Python) | cfqm (Workers) |
|---|---|---|
| 运行环境 | 独立服务器 | Cloudflare Workers |
| 配置存储 | config.yaml 文件 | Cloudflare KV |
| TG Bot 模式 | 长轮询 (polling) | Webhook 回调 |
| 端口暴露 | 需要 Tunnel 或开放端口 | 自带 HTTPS，无需配置 |
| 成本 | 服务器费用 | 免费额度足够 |
| 白名单联动 | 直连 MySQL | HTTP API 中转 |

## 部署

### 前置条件

- Cloudflare 账号
- Node.js + npm

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 KV 命名空间

```bash
npx wrangler kv:namespace create CONFIG
```

把返回的 `id` 填入 `wrangler.toml` 里的 `your-kv-namespace-id`。

### 3. 设置 Secrets

```bash
# 必填
npx wrangler secret put TG_ADMIN_BOT_TOKEN
npx wrangler secret put TG_WEBHOOK_SECRET
npx wrangler secret put TG_ADMIN_CHAT_ID
npx wrangler secret put EMBY_SERVER_URL
npx wrangler secret put EMBY_API_KEY

# 可选（embyboss 白名单联动）
npx wrangler secret put EMBYBOSS_API_URL
npx wrangler secret put WHITELIST_TITLE
```

### 4. 部署

```bash
npm run deploy
```

### 5. 配置 Emby Webhook

进入 Emby 后台 → 设置 → 高级 → Webhooks，URL 填：
```
https://<your-worker-name>.<your-subdomain>.workers.dev/emby/webhook
```

勾选事件：
- 媒体库 — 新片入库
- 播放 — 开始
- 播放 — 停止

### 6. 配置 TG 管理 Bot

```bash
# 先生成一个随机 secret（例如用 openssl）
TG_SECRET=$(openssl rand -hex 24)

# 设置 Telegram webhook，secret_token 由 Telegram 在推送时带在请求头里
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/tg/webhook&secret_token=$TG_SECRET"
```

然后把这个 secret 写进 Workers：
```bash
npx wrangler secret put TG_WEBHOOK_SECRET
# 粘贴上面生成的 $TG_SECRET
```

注意：Telegram 推送 webhook 时会带 `X-Telegram-Bot-Api-Secret-Token` 请求头，Workers 用这个鉴权。URL 里不要出现 Bot token。

`TG_ADMIN_CHAT_ID` 是你的 Telegram 数字 ID（不是用户名）。配置后只有该 ID 能操作管理 Bot；未配置时不限制（不建议生产环境）。

然后在 Telegram 给 Bot 发 `/start`，即可管理通知规则和渠道。

## 初始配置

首次部署后配置为空。通过以下方式设置渠道：

**方式 A：用 TG Bot**
发 `/start` → 通知规则管理 / 通知渠道管理

**方式 B：直接写 KV**

Emby 地址和 API Key 推荐用 secret 设置（见步骤 3）。下面是 KV 配置示例，主要放渠道和规则：

```bash
npx wrangler kv:key put --binding=CONFIG app_config '{
  "channels": [
    {
      "id": "my-tg",
      "type": "telegram",
      "name": "我的 TG",
      "enabled": true,
      "config": {
        "bot_token": "推送Bot的token",
        "chat_id": "目标chat_id"
      },
      "events": ["media_added", "playback_start", "playback_stop"]
    }
  ],
  "rules": {
    "media_added": { "enabled": true, "titleTemplate": "🎬 新片入库", "bodyTemplate": "{{title}} ({{year}}) 已加入 {{library}}", "image": true },
    "playback_start": { "enabled": true, "titleTemplate": "▶️ 播放开始", "bodyTemplate": "{{title}}\\n{{user}}\\n设备：{{device}}\\n客户端：{{client}}", "image": true },
    "playback_stop": { "enabled": true, "titleTemplate": "⏹️ 播放停止", "bodyTemplate": "{{title}}\\n{{user}}\\n设备：{{device}}\\n客户端：{{client}}\\n\\n观看时长: {{position}}", "image": true }
  }
}'
```

注意：
- `embyServerUrl` / `embyApiKey` 也可放在 KV 里，但 secret 优先级更高。
- `embyApiKey` 会自动附加到海报图片 URL，避免 Emby 图片接口因未认证返回 401。

## 模板变量

在 `titleTemplate` / `bodyTemplate` 中使用 `{{变量名}}`：

| 变量 | 含义 |
|------|------|
| `{{title}}` | 片名 |
| `{{user}}` | 用户名（白名单用户显示尊称） |
| `{{device}}` | 播放设备 |
| `{{client}}` | 客户端名 |
| `{{year}}` | 年份 |
| `{{library}}` | 媒体库 |
| `{{position}}` | 播放位置 / 观看时长 |
| `{{progress}}` | 进度百分比（仅停止） |

## embyboss 白名单联动

cfqm 不能直连 MySQL，需要 embyboss 暴露一个 HTTP 接口：

```
GET /api/whitelist?emby_id=<emby_user_id>
→ { "whitelist": true/false }
```

设置 secret `EMBYBOSS_API_URL` 指向 embyboss 的 API 地址即可启用。可选通过 `WHITELIST_TITLE` 自定义尊称（默认：尊敬的白名单用户）。

## 管理员认证

TG 管理 Bot 通过两层鉴权：
1. `TG_WEBHOOK_SECRET`：Telegram 每次推送都带 `X-Telegram-Bot-Api-Secret-Token` 头，Workers 校验该头
2. `TG_ADMIN_CHAT_ID`：只有指定 Telegram 用户能操作管理 Bot（强烈建议配置）

## 本地开发

```bash
npm run dev
```

## License

MIT
