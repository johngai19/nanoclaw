
## User — John Wei（魏智勇）

- **职位**：Senior DevOps / AI Engineer，OKX / OKEngine，香港
- **偏好**：简洁直接，不要时间估算，中文为主，Agent 自动整理

## 挂载目录

| 容器路径 | 宿主机路径 | 权限 | 说明 |
|---------|-----------|------|------|
| `/workspace/extra/obsidian/` | `/Users/weizy0219/Documents/Obsidian Vault/MainVault` | 读写 | 知识库 |
| `/workspace/extra/repos/` | `/Users/weizy0219/repos` | 读写 | 代码仓库 |
| `/workspace/group/` | `groups/telegram_main/` | 读写 | 工作目录（含 blog_backup/） |

**Obsidian 协议**：每次对话须读取 CLAUDE.md → MANIFEST.md → L1-core.md → L2-working.md
**原始提示词保存路径**：`/workspace/extra/obsidian/Inbox/原始提示词/`

## Mac 远程控制（host_exec）

此频道是主控频道（isMain=true），可以通过 IPC 在宿主机 Mac 上执行命令：

```json
// 写入文件：/workspace/ipc/tasks/{timestamp}.json
{
  "type": "host_exec",
  "command": "任何 shell 命令",
  "resultPath": "result.txt",
  "timeout": 300000
}
```

结果写回 `/workspace/group/host-exec/{resultPath}`，JSON 格式包含 stdout/stderr/exitCode。

**可用能力**：
- `bash` — 执行任何 shell 命令（git, npm, python3, curl, docker 等）
- `osascript` — 控制 Mac 应用（Finder、Safari、系统设置等）
- `open` — 打开应用/文件/URL
- `ssh` — 连接局域网 Windows 机器（192.168.3.63，用户 wei.zy@outlook.com）
- `launchctl` — 管理 macOS 服务（包括重启 NanoClaw 自身）
- Node.js 路径：`$HOME/.nvm/versions/node/v22.2.0/bin/node`

**超时**：默认 30 秒，可通过 `timeout` 字段设置（最大 300 秒/5 分钟）。
**缓冲**：最大输出 10MB。
**安全**：仅主控频道可用，wife 频道不可用。

**常用命令示例**：
```bash
# Git 操作
cd /Users/weizy0219/repos/johngai-blog && git add -A && git commit -m "msg" && git push

# 重启 NanoClaw
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 运行 Node 脚本
export PATH=$HOME/.nvm/versions/node/v22.2.0/bin:$PATH && node script.js

# 查看日志
tail -20 /Users/weizy0219/Documents/repos/nanoclaw/logs/nanoclaw.log
```

## 消息格式说明

以下格式由主机 `telegram.ts` 自动处理后传入，**不是**用户手动输入的文字：

| 格式 | 来源 | 说明 |
|------|------|------|
| `[Voice transcript: <文字>]` | 语音消息 | 已由 gpt-4o-transcribe 转写，直接当作用户说的话处理 |
| `[图片: <描述>]` | 图片消息 | 已由 GPT-4o Vision 描述 |
| `[Document: <filename>]` | 文件消息 | 文件名占位符 |

收到 `[Voice: ...]` 时，当作用户正常说的话回复，**不要**提示用户"这是手动发的文字"。

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
