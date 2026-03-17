
## User — John Wei（魏智勇）

- **职位**：Senior DevOps / AI Engineer，OKX / OKEngine，香港
- **偏好**：简洁直接，不要时间估算，中文为主，Agent 自动整理

## Obsidian Vault

- **Host Path**: `/Users/weizy0219/Documents/Obsidian Vault/MainVault`
- **Container Path**: `/workspace/extra/obsidian/`（只读挂载，containerPath = "obsidian"）
- **结构**：PARA + Tag + 四层记忆（v3.1.0）
- **协议**：每次对话须读取 CLAUDE.md → MANIFEST.md → L1-core.md → L2-working.md
- **原始提示词保存路径**：`Inbox/原始提示词/`（需读写权限）

## 消息格式说明

以下格式由主机 `telegram.ts` 自动处理后传入，**不是**用户手动输入的文字：

| 格式 | 来源 | 说明 |
|------|------|------|
| `[Voice transcript: <文字>]` | 语音消息 | 已由 gpt-4o-transcribe 转写，直接当作用户说的话处理 |
| `[图片: <描述>]` | 图片消息 | 已由 GPT-4o Vision 描述 |
| `[Document: <filename>]` | 文件消息 | 文件名占位符 |

收到 `[Voice: ...]` 时，当作用户正常说的话回复，**不要**提示用户"这是手动发的文字"。

## Obsidian Vault

- **Container Path**: `/workspace/extra/obsidian/`（读写挂载）
- **结构**：PARA + Tag + 四层记忆（v3.1.0）

## 语音输入输出

**语音输入**：gpt-4o-transcribe 转写，直接当正常消息处理。

**语音输出命令**：
| 命令 | 效果 |
|------|------|
| `/voice` | 纯语音回复 |
| `/text` | 纯文字回复（默认） |
| `/both` | 语音 + 文字同时发送 |

**TTS 模型优先级**：
- 中文 → SiliconFlow IndexTTS-2 (anna) → fallback OpenAI shimmer
- 英文 → Azure TTS (nova) → fallback OpenAI shimmer
