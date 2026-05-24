# Obsidian Feishu GitHub Sync

[![GitHub](https://img.shields.io/badge/GitHub-obsidian--feishu--github--sync-blue)](https://github.com/jessicalovelife716/obsidian-feishu-github-sync)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-purple)](https://obsidian.md)

> 三端双向同步插件 — Obsidian × 飞书文档 × GitHub

---

## Overview

**Feishu GitHub Sync** 是一个 Obsidian 插件，实现 **飞书文档 (Feishu Docs)** ↔ **Obsidian** ↔ **GitHub** 三端之间的双向同步。让你在一个平台编辑，自动同步到其他两端。跨平台支持桌面端和移动端。

```
┌──────────────┐    双向同步    ┌──────────────┐    双向同步    ┌──────────────┐
│              │ ◄──────────► │              │ ◄──────────► │              │
│  飞书文档      │              │   Obsidian   │              │    GitHub    │
│  (Feishu)    │              │    本地笔记    │              │   (仓库)     │
│              │              │              │              │              │
└──────────────┘              └──────────────┘              └──────────────┘
```

---

## Features

### 三端同步

| 端 | 方向 | 能力 |
|------|---------|---------|
| **飞书文档** | ⟷ Obsidian | 读取飞书文档 → 本地 Markdown，本地 Markdown → 创建/更新飞书文档 |
| **GitHub** | ⟷ Obsidian | 基于 isomorphic-git 的纯 JS Git 操作，无需本地 Git 二进制 |
| **飞书文档** | ⟷ GitHub | 通过 Obsidian 中转的间接同步 |

### v2.0 新特性

- **跨平台兼容** — 使用 `isomorphic-git` 纯 JS 实现，桌面端和移动端均可运行
- **多语言支持** — 自动跟随系统语言，支持 8 种语言：简体中文、繁体中文、英文、西班牙文、法文、俄文、印地文、阿拉伯文
- **凭证加密存储** — App Secret 和 Token 使用 XOR + Base64 加密后存储
- **API 频率控制** — 请求队列 + 指数退避重试，优雅处理 429 限流
- **全局总控开关** — 一键暂停/恢复所有自动同步任务
- **灵活的定时策略** — 支持固定间隔、多时间点定时、工作日选择

### 自动化与频率控制

| 功能 | 说明 |
|------|---------|
| **全局总控开关** | 关闭后暂停所有自动与定时任务，仅保留手动同步 |
| **文件变更监听** | 停止输入 5 秒后自动将文件推送到飞书 |
| **启动时同步** | 启动 Obsidian 时自动静默执行完整双向同步 |
| **固定间隔** | 按设定分钟数（≥15分钟）循环同步 |
| **定时任务** | 按星期多选 + 时间点（最多3个）执行同步 |

### 飞书文档同步

- 通过飞书 Open API 认证 (`tenant_access_token` + 自动刷新)
- 列出飞书云盘中的所有文档（支持分页）
- Markdown ↔ 飞书 Block 格式互转，支持：
  - **标题** (H1/H2/H3)
  - **段落** 与 **行内格式**（粗体、斜体、行内代码、删除线）
  - **列表**（无序/有序）
  - **引用** (Blockquote)
  - **代码块** (支持语言标识)
  - **表格**（简化支持）
- 自动管理文档映射（localPath ↔ feishuDocId）
- 图片自动下载至本地附件文件夹

### GitHub 同步

- 基于 **isomorphic-git**，纯 JavaScript 实现，无需系统 Git 环境
- 兼容 Obsidian 移动端（通过 VaultAdapter 适配）
- 自动 Pull → Commit → Push 工作流
- 免密认证（GitHub Personal Access Token）
- 自动跳过无变更的文件
- 自动处理空仓库的初始克隆

### 冲突处理

三种冲突策略可选：

| 策略 | 行为 |
|---------|--------|
| `keep_both` | 保留两个版本（本地 + 远程冲突副本） |
| `local_wins` | 以本地版本为准覆盖远程 |
| `remote_wins` | 以远程版本为准覆盖本地 |

### 命令面板

| 命令 | 说明 |
|-------|------|
| `Sync All` | 执行完整三端同步 |
| `Push to GitHub` | 仅推送本地变更到 GitHub |
| `Pull from GitHub` | 仅从 GitHub 拉取变更 |
| `Sync current file to Feishu` | 将当前打开的文件同步到飞书 |
| `Pause/Resume Auto Sync` | 切换自动同步暂停/恢复 |

### 文件监控

- 监听 Obsidian 文件变更（5 秒防抖）
- 变更自动同步到飞书（跳过 Git 操作，避免循环）
- 同步期间自动暂停监听，完成后恢复

---

## Installation

### 手动安装

```bash
# 克隆仓库
git clone https://github.com/jessicalovelife716/obsidian-feishu-github-sync.git

# 进入目录
cd obsidian-feishu-github-sync

# 安装依赖
npm install

# 构建
npm run build

# 复制到 Obsidian 插件目录
cp main.js manifest.json /path/to/your/vault/.obsidian/plugins/obsidian-feishu-github-sync/
```

然后在 Obsidian **设置 → 第三方插件** 中启用 **Feishu GitHub Sync**。

---

## Configuration

### 飞书配置

1. 在 [飞书开放平台](https://open.feishu.cn) 创建一个**企业自建应用**
2. 开通以下权限：
   - `docx:document:readonly` — 读取文档
   - `docx:document` — 创建/更新文档
   - `drive:drive` — 云盘文件管理
3. 获取 **App ID** 和 **App Secret**
4. 发布应用并确保应用已被管理员审批

### GitHub 配置

1. 在 [GitHub Settings → Developer settings → Personal access tokens](https://github.com/settings/tokens) 创建一个 Token
2. 勾选 `repo` 权限（Full control of private repositories）
3. 在插件设置中填入 Token 和仓库地址（格式：`owner/repo`）
4. 确保仓库有 `.gitignore` 排除敏感文件

### 同步设置

```

同步范围与策略
├── 同步文件夹（可选，留空同步整个 Vault）
├── 附件保存路径（飞书图片下载位置）
├── 冲突策略（keep_both / local_wins / remote_wins）
└── 显示状态栏图标

自动化与频率控制
├── ⏻ 全局自动同步总控
├── 📁 文件变更监听（5秒防抖）
├── 🚀 启动时同步
├── ⏱️ 定时同步模式（关闭/固定间隔/定时任务）
│   ├── 固定间隔：≥15分钟
│   └── 定时任务：多选工作日 + 时间点（最多3个）
└──
```

---

## Data Flow

### 同步流程 (`syncAll`)

```
1. 飞书 → Obsidian
   ├── 列出所有飞书文档
   ├── 对比文档内容哈希
   ├── 冲突检测与处理
   └── 更新/创建本地文件（含 Frontmatter 元数据）

2. Obsidian → 飞书
   ├── 遍历本地文件
   ├── 跳过 Feishu/ 文件夹（防循环同步）
   ├── 查找现有飞书文档映射
   └── 创建新文档或更新已有文档

3. Obsidian → GitHub
   ├── git pull（获取远程变更）
   ├── 比较文件差异
   ├── git add + commit（如有变更）
   └── git push（推送至远程仓库）
```

### 文件变更监听流程

```
文件修改 → 5秒防抖等待 → 获取内容 → 推送到飞书
                                      └── 跳过 Git 操作（避免循环同步）
```

### 文档元数据

每个从飞书同步的文件自动添加 Frontmatter：

```yaml
---
title: 文档标题
feishu_doc_id: XtHhdS4SSoU9bLxhC2dcg3HcnEc
source: feishu
last_synced: 2026-05-20T10:30:00.000Z
---
```

---

## Development

```bash
# 安装依赖
npm install

# 构建
npm run build

# 构建产物
# - main.js（主插件，含所有源代码）
# - manifest.json（插件清单）
```

### 技术栈

- **Language**: TypeScript
- **Runtime**: Obsidian Plugin API
- **Build**: esbuild
- **Git**: isomorphic-git（纯 JS，跨平台）
- **API**: 飞书 Open API (docx)

### 项目结构

```
obsidian-feishu-github-sync/
├── src/
│   ├── services/
│   │   ├── FeishuService.ts     # 飞书 API 客户端（队列 + 退避重试）
│   │   ├── GitHubService.ts     # isomorphic-git 操作封装
│   │   ├── SyncManager.ts       # 同步协调器（锁 + 防抖 + 冲突处理）
│   │   └── VaultAdapter.ts      # Obsidian Vault → isomorphic-git FS 适配
│   ├── i18n/
│   │   ├── index.ts             # 国际化管理器（自动语言检测）
│   │   ├── en.ts / zh-CN.ts / zh-TW.ts
│   │   ├── es.ts / fr.ts / ru.ts
│   │   └── hi.ts / ar.ts
│   └── types/
│       └── index.ts             # 类型定义
├── main.ts                      # 插件入口 + 设置面板
├── main.js                      # 构建产物
├── manifest.json                # 插件清单
├── package.json                 # 依赖配置
└── tsconfig.json                # TypeScript 配置
```

---

## Security Notes

- GitHub Token 和飞书 App Secret 使用 XOR + Base64 加密存储在本地
- 建议使用 **Fine-grained Token** 并限制到最小仓库权限
- 飞书应用建议限制在指定的云盘空间内
- 确保仓库 `.gitignore` 包含 `.obsidian/plugins/` 和凭证文件
- API 请求仅在本地发出，Token 不会离开本地网络

---

## License

[MIT](LICENSE)

---

*Made with ❤️ for Obsidian × Feishu × GitHub workflow*
