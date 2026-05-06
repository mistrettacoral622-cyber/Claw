# 开天 Claw — 安全与架构问答

> 版本：v0.3.0 | 更新日期：2026-04-22

---

## 1. 克隆（分身）特性的安全机制

这里的"克隆"指的是 **AI 智能体实例**（分身），不是用户数据的克隆。每个分身是一个独立的 AI Agent，有自己的人设、模型配置、工作区目录和会话历史。

涉及敏感数据的安全机制：

- **工作区隔离**：每个分身的数据存储在独立目录 ，分身之间文件系统互不干扰
- **会话隔离**：sessionKey 格式为 `agent:{agentId}:feishu:direct:{accountId}:{senderId}`，不同分身的会话在 Gateway 层严格隔离，不会串台
- **渠道绑定隔离**：渠道账号与分身的绑定关系独立管理，一个渠道账号只能绑定到指定分身，消息不会路由到其他分身
- **删除安全**：删除分身会触发 Gateway 完整重启，确保运行时状态彻底清除，不留残留
- **权限模型**：分身有 `leader` / `worker` 角色区分，`chatAccess` 字段控制是否允许直接对话（`direct` / `leader_only`），worker 分身可以被限制为只接受 leader 分身的指令

---

## 2. 隐私政策

**直接结论：当前代码库中没有独立的隐私政策文件，UI 上也没有隐私政策入口。** 这是一个明确的缺口。

目前代码中与隐私相关的实际行为：

| 数据类型 | 收集方式 | 是否可关闭 |
|---------|---------|-----------|
| machineId（设备指纹） | `node-machine-id` 生成，上报 PostHog | 关闭遥测后停止上报 |
| app 版本、OS、架构 | 每次启动上报 PostHog | 关闭遥测后停止上报 |
| app_installed / app_opened 事件 | 首次安装和每次启动 | 关闭遥测后停止上报 |
| Gateway 重启/重连事件 | 运行时上报 | 关闭遥测后停止上报 |

遥测默认开启（`telemetryEnabled: true`），用户可在 Settings → About 面板手动关闭。PostHog 接收端为 `https://us.i.posthog.com`。

**建议**：需要补充一份正式隐私政策文档，并在首次启动引导（Setup Wizard）中展示并要求用户确认，同时在 Settings 页面提供入口链接。

---

## 3. 内容安全机制

**当前没有内置的内容安全检测模块。** 代码库中未发现任何内容审核、敏感词过滤、违规检测相关代码。

现有的相关机制：

- **渠道访问策略**（`electron/channels/shared/policy.ts`）：控制谁可以给 Bot 发消息（open / pairing / allowlist 模式），这是访问控制而非内容安全
- **人工审核触发**：Settings 中有"通过通知组件强制唤醒人类监管审核"的配置项，属于人工兜底
- **外部 AI 提供商的内容过滤**：Anthropic、OpenAI 等提供商在 API 层有自己的内容策略，但这不在 KTClaw 控制范围内

**结论**：内容安全完全依赖外部 AI 提供商的通用能力，产品本身没有独立的内容安全层。如果面向企业场景，这是一个需要补充的能力。

---

## 4. 用户管理与数据收集

**KTClaw 是本地桌面应用，没有云端用户账号体系，没有用户注册/登录流程。**

收集的用户标识数据：

| 标识 | 生成方式 | 存储位置 | 用途 |
|------|---------|---------|------|
| `machineId` | `node-machine-id`（基于硬件指纹） | Electron store 本地 + PostHog 云端 | 遥测去重 |
| `deviceId` | Ed25519 公钥的 SHA256 指纹 | `~/.openclaw/clawx-device-identity.json`（权限 0600） | Gateway 身份认证 |

渠道侧的用户数据（来自飞书/微信等 IM）：

- `senderId`：IM 平台的用户 open_id
- `accountId`：Bot 账号 ID
- `chatId`：会话/群组 ID

这些数据**仅在本地内存和本地文件中流转**，不上传到任何云端服务。

**没有云端用户数据表**，因为这不是 SaaS 产品，没有服务端数据库。如果未来要做云同步或多设备，这部分需要重新设计。

---

## 5. 多 IM 消息融合机制

各渠道消息在进入 Gateway 前，会被归一化为统一的 `InboundContext` 结构：

```
飞书消息 ──┐
微信消息 ──┤  各渠道 adapter 解析
钉钉消息 ──┘
              ↓
        InboundContext {
          body / rawBody    ← 消息正文
          from              ← 发送方（feishu:{senderId}）
          to                ← 目标（chat:{chatId}）
          sessionKey        ← 会话路由键
          provider          ← 来源渠道标识
          originatingChannel
        }
              ↓
        sessionKey 路由到对应分身会话
        agent:{agentId}:{channel}:{type}:{id}
```

sessionKey 是融合的核心——它把"哪个分身 + 哪个渠道 + 哪个会话"编码成一个唯一键，Gateway 用它来维持跨渠道的会话连续性。同一个分身可以同时接收来自飞书和微信的消息，各自维护独立的会话上下文，互不干扰。

---

## 6. "任务"对应 OpenClaw 中的概念

三个概念是不同层次的东西：

| 概念 | 对应层 | 说明 |
|------|--------|------|
| **Session** | 运行时层 | Claude API 的一次执行上下文，有 running/blocked/completed 等状态，跟踪工具调用、transcript |
| **Cron Job** | 调度层 | 定时触发器，每次触发会创建一个 Session，sessionKey 格式为 `agent:{agentId}:cron:{jobId}:run:{runId}` |
| **Task** | 业务层 | Kanban 看板上的工作项，有 todo/in-progress/review/done 状态，可以关联多个 Session |

"任务监控"里的"任务"对应的是 **Cron Job**（定时任务），而不是 Session。Cron Job 的每次运行会产生一个 Session，运行日志存储在 `~/.openclaw/cron/runs/{jobId}.jsonl`。

---

## 7. 端口监听与手机侧信道

**所有本地服务都只监听 localhost**：
- Host API：`127.0.0.1:3210`
- OpenClaw Gateway：`127.0.0.1:18789`（默认）

**手机侧不直接连接 KTClaw**，信道建立方式是：

```
手机用户
    │  在 IM App（飞书/微信/钉钉）里发消息给 Bot
    ▼
IM 平台服务器（飞书云/微信服务器）
    │  WebSocket 长连接 或 Webhook 回调
    ▼
KTClaw 渠道层（运行在桌面机器上）
    │  本地 IPC
    ▼
OpenClaw Gateway → AI 响应 → 原路返回
```

手机和 KTClaw 之间**没有直接网络连接**，IM 平台的服务器充当中继。KTClaw 主动向飞书/微信服务器建立出站连接（WebSocket 或轮询），手机侧的消息经由 IM 平台转发过来。这也意味着 KTClaw 所在的机器需要能访问外网的 IM 平台 API。
