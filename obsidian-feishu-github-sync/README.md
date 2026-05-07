# Feishu GitHub Sync

Obsidian 插件：实现飞书文档 ↔ Obsidian ↔ GitHub 三端双向同步。

## 功能

- **飞书文档同步**：读写飞书 Docs 文档
- **GitHub 同步**：推送/拉取笔记到 GitHub 仓库
- **双向同步**：支持 Obsidian 与飞书/GitHub 双向同步
- **文件监听**：自动检测文件变化并同步
- **定时同步**：可配置自动同步间隔
- **冲突处理**：支持 `keep_both`、`local_wins`、`remote_wins` 三种策略

## 安装

1. 下载/克隆本仓库
2. `npm install`
3. `npm run build`
4. 将 `dist/` 目录下的文件复制到 Obsidian 插件目录：

```bash
cp -r dist/* ~/.obsidian/plugins/obsidian-feishu-github-sync/
```

5. 在 Obsidian 设置 → 第三方插件 中启用 "Feishu GitHub Sync"

## 配置

### 飞书配置

1. 在 [飞书开放平台](https://open.feishu.cn) 创建应用
2. 开通文档相关权限（`docx` read/write）
3. 获取 `App ID` 和 `App Secret`

### GitHub 配置

1. 创建 [Personal Access Token](https://github.com/settings/tokens)
2. 需要 `repo` 权限
3. 格式：`owner/repo`（如 `username/obsidian-notes`）

## 使用

### 命令面板

- `Feishu GitHub Sync: Sync all` - 执行完整同步
- `Feishu GitHub Sync: Push to GitHub` - 仅推送到 GitHub
- `Feishu GitHub Sync: Pull from GitHub` - 仅从 GitHub 拉取

### 自动同步

在设置中启用 `Auto-sync`，配置同步间隔（分钟）

## 开发

```bash
npm install
npm run dev    # 监听模式
npm run build  # 构建
```

## License

MIT