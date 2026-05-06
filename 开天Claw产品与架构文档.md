# 开天 Claw — 产品与架构全景文档

> 版本：v0.3.0 | 更新日期：2026-04-22

---

## 整体架构全景

```
  用户 / 企业渠道
  飞书 · 微信 · 钉钉 · WeCom · QQ Bot
          │
          │  Bot 消息入站 / 出站
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       开天 Claw 桌面应用                             │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  React 渲染进程（UI 层）                                      │   │
│  │  对话 · 智能体广场 · 渠道管理 · 技能市场 · 团队控制台           │   │
│  └──────────────────────┬──────────────────────────────────────┘   │
│                         │  IPC（沙箱隔离，渲染进程无 Node 权限）      │
│  ┌──────────────────────▼──────────────────────────────────────┐   │
│  │  Electron 主进程（控制面）                                    │   │
│  │  • Host API :3210（会话 token 认证，仅 127.0.0.1）            │   │
│  │  • 凭证管理（OS 钥匙串加密）                                  │   │
│  │  • 渠道运行时（速率限制 · 去重 · 健康检查）                    │   │
│  │  • OAuth 流程（Device Flow / Browser Flow）                  │   │
│  │  • 自动更新 · 系统托盘                                        │   │
│  └──────────────────────┬──────────────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────────────┘
                          │  WS（JSON-RPC 2.0）/ HTTP / IPC 降级
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway（AI 运行时）                    │
│                                                                     │
│   智能体编排  ·  技能执行  ·  MCP 工具调用  ·  提供商抽象层           │
│                                                                     │
│   设备身份握手  ·  Token 自动刷新  ·  进程隔离 & 熔断恢复             │
└──────────────────────────┬──────────────────────────────────────────┘
                           │  HTTPS / API
                           ▼
        AI 提供商（Anthropic · OpenAI · Google · Deepseek · Ollama · …）
```

---

## 一、产品定位

开天 Claw（KTClaw）是一款**桌面端 AI 智能体控制台**，基于 Electron 构建，跨平台支持 macOS / Windows / Linux。它是 OpenClaw AI 智能体运行时的图形化前端，让用户无需命令行即可完整管理 AI 智能体、渠道、技能和自动化工作流。

核心价值主张：
- 把企业级 AI 智能体能力装进一个桌面应用
- 多渠道（飞书、微信、钉钉等）统一接入，一处配置全局生效
- 技能市场 + MCP 协议，让智能体能力可插拔扩展
- 团队协作视角：角色分工、任务看板、进度播报

---

## 二、产品需求与功能清单

### 2.1 核心功能模块

#### 对话（Chat）
- 多智能体对话，支持 `@agent` 路由到指定智能体
- 斜杠命令：`/new` 新建会话、`/stop` 停止、`/cwd` 切换工作目录、`/memory` 查看记忆、`/cron` 定时任务、`/settings` 设置、`/export` 导出
- 富文本渲染：Markdown、KaTeX 数学公式、代码高亮、本地文件链接
- 图像理解：支持视觉模型，无视觉路径时自动提示并推荐本地技能（截图、浏览器）
- 消息流式输出，工具调用可视化

#### 智能体广场（Agents / Employee Square）
- 英雄卡片网格展示所有智能体
- 智能体详情页：角色配置（`leader` / `worker`）、记忆管理、技能绑定、活动日志
- 基于角色的访问控制（RBAC）

#### 渠道管理（Channels）
- 支持渠道：飞书（Lark）、微信、企业微信（WeCom）、钉钉、QQ Bot
- 每个渠道支持多账号，可设置默认账号
- 会话绑定：渠道会话与智能体会话映射
- 飞书专属：扫码创建/绑定 Bot、用户授权流程、凭证恢复向导

#### 定时任务（Cron）
- 可视化创建 AI 定时任务（Cron 表达式）
- 运行历史、错误上下文、投递目标配置
- 支持多渠道投递（飞书群、微信等）

#### 技能市场（Skills）
- 浏览、安装、卸载、配置技能
- 预装技能：
  - 文档处理：PDF、XLSX、DOCX、PPTX
  - 搜索：Brave Web Search、Tavily Search、Bocha Search
  - 工具：Find Skills、Self-Improving Agent
- 技能 API Key 管理（`BRAVE_SEARCH_API_KEY` 等）

#### 团队控制台（Team）
- TeamOverview：团队全局视图，角色感知界面
- TeamMap：团队拓扑可视化
- TaskKanban：工作看板，任务可见性
- BroadcastChat：广播消息

#### 设置（Settings）
- 模型提供商配置（API Key、自定义端点）
- 代理设置（企业网络支持）
- 主题（深色/浅色）、语言（i18n）
- 自动更新渠道选择

#### 首次引导（Setup Wizard）
- 检测系统语言自动预选
- 飞书 Bot 创建引导
- 提供商账号配置引导

### 2.2 支持的 AI 提供商

| 类型 | 提供商 |
|------|--------|
| 官方 | Anthropic、OpenAI、Google、Deepseek、智谱、百川、Moonshot、Siliconflow |
| 兼容 | OpenRouter、Ark（字节）、MiniMax、Qwen（通义） |
| 本地 | Ollama |
| 自定义 | 用户自定义 OpenAI 兼容端点 |

---

## 三、整体架构

### 3.1 架构分层

```
┌─────────────────────────────────────────────────────────────────┐
│                    开天 Claw 桌面应用                            │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         Electron 主进程（Node.js）                        │  │
│  │  • 窗口 & 应用生命周期管理                                 │  │
│  │  • Gateway 进程监管（OpenClaw）                           │  │
│  │  • 系统集成（托盘、通知、系统钥匙串）                       │  │
│  │  • Host API 服务器（HTTP :3210）                          │  │
│  │  • IPC 处理器（渲染进程通信）                              │  │
│  │  • 自动更新编排                                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                         │                                       │
│                    IPC（权威控制面）                              │
│                         ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         React 渲染进程                                    │  │
│  │  • React 19 + TypeScript                                 │  │
│  │  • Zustand 状态管理                                       │  │
│  │  • 统一 host-api / api-client 调用                        │  │
│  │  • 富文本 Markdown 渲染                                   │  │
│  │  • Tailwind CSS + shadcn/ui                              │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              主进程控制传输策略（WS → HTTP → IPC 降级）
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Host API & 主进程代理层                         │
│  • hostapi:fetch（主进程代理，规避 CORS）                        │
│  • gateway:httpProxy（渲染进程不直接调用 Gateway HTTP）           │
│  • 统一错误映射 & 重试/退避                                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                  WS / HTTP / IPC 降级链
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  OpenClaw Gateway                               │
│  • AI 智能体运行时 & 编排                                        │
│  • 消息渠道管理                                                  │
│  • 技能/插件执行环境                                             │
│  • 提供商抽象层                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 核心设计原则

1. **进程隔离**：AI 运行时在独立进程，UI 始终响应
2. **单一入口**：渲染进程请求全部经过 `host-api/api-client`，协议细节对 UI 透明
3. **主进程拥有传输**：Electron 主进程控制 WS/HTTP 使用和 IPC 降级
4. **优雅恢复**：内置重连、超时、退避逻辑
5. **安全存储**：OS 原生钥匙串存储 API Key
6. **CORS 安全**：本地 HTTP 访问由主进程代理

### 3.3 目录结构

```
ClawX-main/
├── electron/                    # 主进程（Node.js 运行时）
│   ├── api/                    # Host API 服务器（HTTP + IPC 代理）
│   │   ├── routes/             # 23+ 路由模块
│   │   ├── server.ts           # HTTP 服务器（:3210）
│   │   ├── context.ts          # 请求上下文 & 依赖
│   │   └── event-bus.ts        # 事件分发
│   ├── gateway/                # OpenClaw Gateway 进程管理
│   │   ├── manager.ts          # 生命周期 & WebSocket 管理
│   │   ├── process-launcher.ts # 进程启动
│   │   ├── protocol.ts         # JSON-RPC 2.0 定义
│   │   └── config-sync.ts      # 配置同步到 Gateway
│   ├── services/               # 业务逻辑层
│   │   ├── providers/          # 提供商账号管理
│   │   ├── secrets/            # OS 钥匙串集成
│   │   ├── mcp/                # MCP 运行时
│   │   └── session-runtime-manager.ts
│   ├── channels/               # 多渠道集成
│   │   ├── feishu/             # 飞书 Bot
│   │   ├── wechat/             # 微信 Bot
│   │   ├── shared/             # 分块、去重、健康检查
│   │   └── registry.ts
│   ├── utils/                  # 工具函数
│   └── main/                   # Electron 主进程入口
│       ├── index.ts            # 应用生命周期
│       ├── ipc-handlers.ts     # IPC 通道注册
│       ├── tray.ts             # 系统托盘
│       └── updater.ts          # 自动更新
├── src/                        # React 渲染进程
│   ├── pages/                  # 路由级组件（懒加载）
│   ├── components/             # 可复用 UI 组件
│   ├── stores/                 # Zustand 状态
│   ├── lib/                    # 前端工具库
│   └── i18n/                   # 国际化资源
├── tests/
│   ├── unit/                   # Vitest 单元测试
│   └── e2e/                    # Playwright E2E 测试
└── scripts/                    # 构建 & 工具脚本
```

---

## 四、Gateway 通信协议

### 4.1 协议规范

Gateway 使用 **JSON-RPC 2.0** 标准，通过 WebSocket 通信（主），HTTP 为降级。

```typescript
// 请求
{ jsonrpc: "2.0", id: "uuid-v4", method: "agent.chat", params: {...} }

// 响应
{ jsonrpc: "2.0", id: "uuid-v4", result: {...} }
// 或错误
{ jsonrpc: "2.0", id: "uuid-v4", error: { code: -32001, message: "..." } }

// 通知（服务端主动推送，无 id，无需响应）
{ jsonrpc: "2.0", method: "event.message", params: {...} }
```

### 4.2 Gateway 专属错误码

| 错误码 | 含义 |
|--------|------|
| -32001 | NOT_CONNECTED |
| -32002 | AUTH_REQUIRED |
| -32003 | PERMISSION_DENIED |
| -32004 | RESOURCE_NOT_FOUND |
| -32005 | RATE_LIMITED |
| -32006 | INTERNAL_GATEWAY_ERROR |

### 4.3 Gateway 生命周期管理

```
启动阶段诊断：
  stop-system-service → find-existing → connect → start-process → wait-ready → doctor-repair

重连策略：
  指数退避 + 熔断器（GatewayRestartGovernor）
  最大重试后进入 60 秒冷却期
  自动恢复，无需用户干预

心跳机制：
  每 30 秒 ping/pong
  12 秒超时，连续 3 次失败触发重连
  Windows 跳过心跳（减少重连抖动）

热重载：
  Unix：SIGUSR1 信号触发进程内重载
  Windows：回退到完整重启
```

### 4.4 设备身份

Gateway 握手使用设备身份标识，存储于 `userData/clawx-device-identity.json`，首次启动自动生成。

---

## 五、安全架构

开天 Claw 的安全设计贯穿 KTClaw 桌面层与 OpenClaw 运行时两个维度，核心思路是**纵深防御**：每一层都有独立的安全边界，单层被突破不会导致全局失守。

### 5.1 凭证安全：零明文落盘

所有 AI 提供商的 API Key 和 OAuth Token 均通过 OS 原生加密机制保护，在磁盘上从不以明文形式存在：

- Windows 使用 DPAPI，macOS 使用 Keychain，Linux 使用 Secret Service
- 在此之上叠加 Electron safeStorage 二次加密，格式带版本号便于未来迁移
- 无法获得 OS 加密能力时，系统直接拒绝持久化，而非降级为明文存储
- 凭证全程不写入任何日志或遥测

这意味着即便攻击者拿到了本地存储文件，也无法在不控制操作系统账户的前提下还原出原始密钥。

### 5.2 进程隔离：UI 与运行时严格分离

KTClaw 采用 Electron 的三进程模型，每层权限最小化：

```
渲染进程（UI）
  └─ 沙箱隔离，无 Node.js 直接访问权限
  └─ 所有敏感操作必须经 IPC 请求主进程代理

主进程（控制面）
  └─ 持有钥匙串访问权、文件系统权限
  └─ 对渲染进程暴露最小必要接口

OpenClaw Gateway（AI 运行时）
  └─ 独立子进程，崩溃不影响 UI
  └─ 通过 WebSocket 与主进程通信，有设备身份握手
```

渲染进程永远不直接调用 Gateway HTTP，全部经主进程代理，攻击面被大幅收窄。

### 5.3 本地 API 认证：会话级动态 Token

Host API 服务（`:3210`）仅监听 `127.0.0.1`，每次应用启动生成一个 32 字节随机 token，通过 IPC 下发给渲染进程。每个请求都需携带该 token，服务端逐请求校验。Token 随进程生命周期，重启即失效，不存在长期有效的静态凭证。

### 5.4 OAuth 流程：无硬编码密钥

设备授权流（Device OAuth）和浏览器授权流（Browser OAuth）均不在客户端硬编码 client_id，密钥存于 OpenClaw 扩展侧。授权全程在系统浏览器完成，KTClaw 本身不接触用户的账号密码。OAuth Token 获取后双写加密存储，由 Gateway 负责自动刷新，用户无感知。

### 5.5 渠道层防护

多渠道消息投递内置三道防线：

- **速率限制**：防止异常高频调用触发渠道封禁
- **消息去重**：幂等投递，网络抖动不会造成重复消息
- **健康检查**：持续探测渠道连接状态，异常时主动告警而非静默失败

### 5.6 供应链与代码质量

- TypeScript 严格模式全量覆盖，类型错误在编译期拦截
- `dependency-cruiser` 强制模块边界，防止依赖混乱引入隐患
- `knip` 检测并清理未使用代码，减少攻击面
- Playwright E2E 测试覆盖关键用户流程，防止安全回归

---

## 六、多渠道系统

### 6.1 渠道架构

```
electron/channels/
├── registry.ts          # Map 注册表，id → 渠道实例
├── feishu/              # 飞书（Lark）
├── wechat/              # 微信
├── shared/
│   ├── chunker.ts       # 大消息分块
│   ├── dedup.ts         # 消息去重
│   ├── health.ts        # 健康检查
│   └── media.ts         # 媒体文件上传
└── [dingtalk, qq, wecom 通过插件包接入]
```

### 6.2 渠道特性对比

| 渠道 | 接入方式 | 多账号 | 媒体 | 特殊功能 |
|------|---------|--------|------|---------|
| 飞书 | 原生 SDK | ✓ | ✓ | 扫码绑定、用户授权向导 |
| 微信 | 原生 | ✓ | ✓ | — |
| 企业微信 | 插件包 | ✓ | ✓ | — |
| 钉钉 | @soimy/dingtalk | ✓ | ✓ | — |
| QQ Bot | @sliverp/qqbot | ✓ | — | — |

### 6.3 消息流

```
渠道消息入站
    ↓
去重检查（dedup.ts）
    ↓
会话绑定查找（channel-conversation-bindings.ts）
    ↓
路由到对应智能体会话
    ↓
Gateway 处理 → AI 响应
    ↓
消息分块（chunker.ts，超长消息）
    ↓
速率限制检查
    ↓
渠道投递
```

---

## 七、技能与 MCP 系统

### 7.1 技能系统

```
技能来源优先级：
  1. 托管目录（~/.openclaw/skills）
  2. 工作区目录
  3. 额外目录（用户配置）

技能生命周期：
  发现 → 安装（clawhub）→ 配置（API Key 等）→ 绑定到智能体 → 执行
```

### 7.2 MCP（Model Context Protocol）

- 配置存储：`~/.openclaw/mcp-servers.json`
- 传输协议：stdio、HTTP、SSE
- 工具发现：动态枚举 MCP 服务器暴露的工具
- 生命周期：启动/停止/重启 + 诊断
- 运行时管理：`electron/services/mcp/runtime-manager.ts`

---

## 八、前端架构

### 8.1 状态管理（Zustand）

| Store | 职责 |
|-------|------|
| `chat.ts` | 会话、消息、运行时状态 |
| `gateway.ts` | Gateway 连接状态 |
| `settings.ts` | 应用偏好、主题、语言 |
| `agents.ts` | 智能体列表 & 元数据 |
| `channels.ts` | 渠道配置 |
| `approvals.ts` | 审批工作流 |
| `notifications.ts` | Toast 通知 |

### 8.2 API 客户端层

```
src/lib/api-client.ts
  传输抽象：IPC（主）→ WS → HTTP（降级）
  85+ IPC 通道
  统一错误映射到 AppError 类型
  遥测：记录 API 调用时长 & 状态

src/lib/host-api.ts
  端口：localhost:3210
  认证：每次会话 token（通过 IPC 获取）
  代理模式：主进程代理 HTTP 请求
```

### 8.3 技术栈

| 层 | 技术 |
|----|------|
| 框架 | React 19 + TypeScript |
| 路由 | React Router v7（懒加载分包） |
| 状态 | Zustand 5 |
| UI | shadcn/ui（Radix UI）+ Tailwind CSS 3 |
| 动画 | Framer Motion |
| 图标 | Lucide React |
| 数学 | KaTeX |
| 构建 | Vite 7 |

---

## 九、构建与发布

### 9.1 构建流程

```bash
pnpm run build
  ├── vite build（React 渲染进程）
  ├── bundle:openclaw（OpenClaw 运行时）
  ├── bundle:openclaw-plugins（渠道插件）
  └── bundle:preinstalled-skills（技能清单）
        ↓
  electron-builder（打包为平台安装包）
```

### 9.2 支持平台

- macOS（ARM64 + x86-64）
- Windows（ARM64 + x86-64）
- Linux（ARM64 + x86-64）

### 9.3 质量门禁

| 检查项 | 工具 |
|--------|------|
| 类型检查 | TypeScript strict |
| 代码规范 | ESLint |
| 无障碍 | axe-core（lint:a11y） |
| 单元测试 | Vitest 4 |
| E2E 测试 | Playwright 1.58 |
| 未使用代码 | knip |
| 模块边界 | dependency-cruiser |
| 通信回归 | comms:replay & comms:compare |

---

## 十、遥测与监控

- **PostHog**：事件追踪（API 调用、UI 交互、Gateway 状态）
- **设备标识**：`node-machine-id` 生成匿名设备 ID
- **启动诊断**：Gateway stderr 分类 & 快照捕获
- **通信指标**：Gateway 事件路径基线 & 回归追踪

---

## 十一、关键依赖

| 类别 | 主要包 |
|------|--------|
| 运行时 | Electron 40+、Node.js 22+ |
| 前端 | React 19、React Router 7、Zustand 5 |
| UI | shadcn/ui、Framer Motion、Lucide React |
| 构建 | Vite 7、electron-builder 26、TypeScript 5.9 |
| 测试 | Vitest 4、Playwright 1.58 |
| 后端 | OpenClaw 2026.3.22、clawhub 0.5、electron-store 11 |
| 渠道 | @larksuite/openclaw-lark、@wecom/wecom-openclaw-plugin、@soimy/dingtalk、@sliverp/qqbot |
| 工具 | ws、zod、posthog-node |

---

*文档由 Claude Code 根据源码自动生成，如有出入以源码为准。*
