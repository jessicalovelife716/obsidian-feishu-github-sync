# Obsidian Feishu GitHub Sync

[![GitHub](https://img.shields.io/badge/GitHub-obsidian--feishu--github--sync-blue)](https://github.com/jessicalovelife716/obsidian-feishu-github-sync)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-Plugin-purple)](https://obsidian.md)

> 三端双向同步插件 — Obsidian × 飞书文档 × GitHub

---

## Overview

**Feishu GitHub Sync** 是一个 Obsidian 插件，实现 **飞书文档 (Feishu Docs)** ↔ **Obsidian** ↔ **GitHub** 三端之间的双向同步。让你在一个平台编辑，自动同步到其他两端。

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
| **GitHub** | ⟷ Obsidian | 将 Obsidian Vault 推送到 GitHub 仓库，从 GitHub 拉取变更 |
| **飞书文档** | ⟷ GitHub | 通过 Obsidian 中转的间接同步 |

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
- 自动管理文档映射（localPath ↔ feishuDocId ↔ githubPath）

### GitHub 同步

- 基于 `simple-git`，在 Obsidian Vault 目录内直接执行 Git 操作
- 自动 Pull → Commit → Push 工作流
- 免密认证（GitHub Personal Access Token）
- 自动跳过无变更的文件
- 支持配置分支

### 定时同步

- 每周定时自动同步（默认：**周一 9:00 AM**）
- 可自定义：日期、小时、分钟
- 一键启用/关闭定时同步
- 状态栏显示下次同步时间

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
| `Sync all` | 执行完整三端同步 |
| `Push to GitHub` | 仅推送本地变更到 GitHub |
| `Pull from GitHub` | 仅从 GitHub 拉取变更 |
| `Sync with Feishu only` | 仅在飞书 ↔ Obsidian 之间同步 |

### 文件监控

- 监听 Obsidian 文件变更（2 秒防抖）
- 自动同步变更到飞书
- 文件删除时自动删除对应飞书文档

---

## Installation

### 从 Release 安装

1. 在 Obsidian 中打开 **设置 → 第三方插件 → 社区插件市场**
2. 搜索 "Feishu GitHub Sync"
3. 点击 **安装** 并 **启用**

### 手动安装

```bash
# 克隆仓库
git clone https://github.com/jessicalovelife716/obsidian-feishu-github-sync.git

# 安装依赖
cd obsidian-feishu-github-sync
npm install

# 构建
npm run build

# 复制到 Obsidian 插件目录
cp -r dist/* ~/.obsidian/plugins/obsidian-feishu-github-sync/
```

然后在 Obsidian 设置 → 第三方插件 中启用。

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

### 同步设置

```
📅 定时同步设置
   ├── 启用自动同步（开关）
   ├── 同步日期（日～六）
   ├── 同步时间（24 小时制）
   └── 当前计划：每周一 09:00

⚡ 同步选项
   ├── 同步方向：双向 / 仅本地→远程 / 仅远程→本地
   ├── 冲突策略：keep_both / local_wins / remote_wins
   └── 同步文件夹（可选，留空表示同步整个 Vault）
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
   ├── git add + git commit（如有变更）
   └── git push（推送至远程仓库）
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

# 开发模式（监听文件变更）
npm run dev

# 构建
npm run build

# 构建产物
# - main.js（主插件）
# - manifest.json（插件清单）
```

### 技术栈

- **Language**: TypeScript
- **Runtime**: Obsidian Plugin API
- **Build**: esbuild
- **Git**: simple-git
- **API**: 飞书 Open API (docx)

### 项目结构

```
obsidian-feishu-github-sync/
├── src/
│   ├── services/
│   │   ├── FeishuService.ts   # 飞书 API 客户端
│   │   ├── GitHubService.ts   # Git 操作封装
│   │   └── SyncManager.ts     # 同步协调器
│   └── types/
│       └── index.ts           # 类型定义
├── main.ts                    # 插件入口
├── main.js                    # 构建产物
├── manifest.json              # 插件清单
├── package.json               # 依赖配置
└── tsconfig.json              # TypeScript 配置
```

---

## Security Notes

- GitHub Token 和飞书 App Secret 存储在 Obsidian 本地配置中
- 建议使用 **Fine-grained Token** 并限制到最小仓库权限
- 飞书应用建议限制在指定的云盘空间内
- 同步过程中 Token 不会离开本地网络，仅在请求 API 时使用

---

## License

[MIT](LICENSE)

---

*Made with ❤️ for Obsidian × Feishu × GitHub workflow*
