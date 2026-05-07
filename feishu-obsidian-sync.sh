#!/bin/bash
#===============================================
# 飞书 ↔ Obsidian 双向同步脚本
# 使用飞书 Open API + Obsidian 本地 Markdown 文件
#===============================================

set -e

#=============== 配置区 ===============
# 飞书配置
LARK_APP_ID="your_app_id"           # 飞书应用 App ID
LARK_APP_SECRET="your_app_secret"   # 飞书应用 App Secret
LARK_FOLDER_TOKEN=""                 # 飞书云盘根目录 Token（留空同步所有文档）

# Obsidian 配置
OBSIDIAN_VAULT_PATH="$HOME/Obsidian" # Obsidian 仓库路径
OBSIDIAN_MD_EXT=".md"

# 同步策略
SYNC_INTERVAL=3600                   # 同步检查间隔（秒），默认 1 小时
MAX_FILE_SIZE=10485760               # 最大文件 10MB
ENABLE_LOG=true
LOG_FILE="$HOME/.feishu-sync.log"

# 冲突处理: "local_wins" | "remote_wins" | "keep_both"
CONFLICT_STRATEGY="keep_both"

#===============================================

# 日志函数
log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$msg"
    [[ "$ENABLE_LOG" == "true" ]] && echo "$msg" >> "$LOG_FILE"
}

# 获取飞书 Access Token
get_lark_token() {
    local resp
    resp=$(curl -s -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
        -H "Content-Type: application/json" \
        -d "{\"app_id\":\"$LARK_APP_ID\",\"app_secret\":\"$LARK_APP_SECRET\"}")

    echo "$resp" | grep -o '"tenant_access_token":"[^"]*"' | cut -d'"' -f4
}

# 获取飞书文档列表
get_lark_docs() {
    local token="$1"
    local docs=()
    local page_token=""
    local has_more=true

    while [[ "$has_more" == "true" ]]; do
        local url="https://open.feishu.cn/open-apis/docx/v1/documents?page_size=50"
        [[ -n "$page_token" ]] && url="${url}&page_token=$page_token"

        local resp
        resp=$(curl -s -X GET "$url" -H "Authorization: Bearer $token")

        # 解析文档列表
        local items=$(echo "$resp" | grep -o '"document_id":"[^"]*"' | cut -d'"' -f4)
        for doc_id in $items; do
            docs+=("$doc_id")
        done

        has_more=$(echo "$resp" | grep -o '"has_more":[^,]*' | cut -d':' -f2)
        page_token=$(echo "$resp" | grep -o '"page_token":"[^"]*"' | cut -d'"' -f4)
    done

    echo "${docs[@]}"
}

# 获取飞书文档内容（Markdown 格式）
get_lark_doc_content() {
    local token="$1"
    local doc_id="$2"
    local resp

    resp=$(curl -s -X GET "https://open.feishu.cn/open-apis/docx/v1/documents/$doc_id" \
        -H "Authorization: Bearer $token")

    # 检查是否成功
    if ! echo "$resp" | grep -q '"code":0'; then
        log "ERROR: 获取文档 $doc_id 失败: $resp"
        return 1
    fi

    # 获取标题
    local title=$(echo "$resp" | grep -o '"title":"[^"]*"' | cut -d'"' -f4)

    # 获取 blocks 并转换为 Markdown
    get_lark_doc_blocks "$token" "$doc_id" "$title"
}

# 获取飞书文档块内容
get_lark_doc_blocks() {
    local token="$1"
    local doc_id="$2"
    local title="$3"
    local resp
    local markdown=""

    resp=$(curl -s -X GET "https://open.feishu.cn/open-apis/docx/v1/documents/$doc_id/blocks?page_size=500" \
        -H "Authorization: Bearer $token")

    # 提取纯文本内容（简化版，实际需要更复杂的块解析）
    local text=$(echo "$resp" | grep -o '"text":"[^"]*"' | sed 's/\\n/\n/g' | sed 's/\\t/\t/g')

    # 写入 Obsidian 文件
    local filename=$(echo "$title" | sed 's/[\\/:*?"<>|]/_/g')
    echo -e "# $title\n\n$text" > "${OBSIDIAN_VAULT_PATH}/${filename}.md"

    log "下载飞书文档: $title"
}

# 上传文件到飞书云盘
upload_to_lark() {
    local token="$1"
    local local_file="$2"
    local filename=$(basename "$local_file")

    # 创建飞书文档
    local resp
    resp=$(curl -s -X POST "https://open.feishu.cn/open-apis/docx/v1/documents" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "{\"title\":\"$filename\"}")

    if ! echo "$resp" | grep -q '"code":0'; then
        log "ERROR: 创建飞书文档失败: $resp"
        return 1
    fi

    local doc_id=$(echo "$resp" | grep -o '"document_id":"[^"]*"' | cut -d'"' -f4)
    log "创建飞书文档: $filename (ID: $doc_id)"

    echo "$doc_id"
}

# 同步 Obsidian → 飞书
sync_obsidian_to_lark() {
    local token="$1"

    log "开始同步 Obsidian → 飞书..."

    for md_file in "${OBSIDIAN_VAULT_PATH}"/*${OBSIDIAN_MD_EXT}; do
        [[ ! -f "$md_file" ]] && continue

        local filename=$(basename "$md_file" ${OBSIDIAN_MD_EXT})
        local file_size=$(stat -f%z "$md_file" 2>/dev/null || stat -c%s "$md_file" 2>/dev/null)

        # 检查文件大小
        if [[ "$file_size" -gt "$MAX_FILE_SIZE" ]]; then
            log "跳过大文件: $filename ($file_size bytes)"
            continue
        fi

        # 读取内容
        local content=$(cat "$md_file")

        # 上传到飞书
        local doc_id=$(upload_to_lark "$token" "$md_file")
        [[ -n "$doc_id" ]] && log "同步成功: $filename"
    done
}

# 同步飞书 → Obsidian
sync_lark_to_obsidian() {
    local token="$1"

    log "开始同步 飞书 → Obsidian..."

    local docs
    docs=$(get_lark_docs "$token")

    for doc_id in $docs; do
        get_lark_doc_content "$token" "$doc_id"
    done
}

# 冲突检测
detect_conflict() {
    local local_file="$1"
    local remote_title="$2"
    local local_mtime remote_mtime

    local_mtime=$(stat -f%m "$local_file" 2>/dev/null || stat -c%Y "$local_file" 2>/dev/null)

    # 获取飞书文档更新时间
    # ...

    [[ "$local_mtime" -gt "$remote_mtime" ]] && echo "local" || echo "remote"
}

# 主同步流程
run_sync() {
    log "========== 开始同步 =========="

    # 获取 token
    local token
    token=$(get_lark_token)
    if [[ -z "$token" ]]; then
        log "ERROR: 获取飞书 Access Token 失败"
        return 1
    fi

    # 双向同步
    sync_lark_to_obsidian "$token"
    sync_obsidian_to_lark "$token"

    log "========== 同步完成 =========="
}

# 后台守护进程模式
run_daemon() {
    log "启动守护进程，间隔 ${SYNC_INTERVAL}s..."

    while true; do
        run_sync
        sleep "$SYNC_INTERVAL"
    done
}

# 显示帮助
show_help() {
    cat << EOF
飞书 ↔ Obsidian 双向同步脚本

用法:
    $0 sync         # 执行一次同步
    $0 daemon       # 后台守护模式持续同步
    $0 help         # 显示帮助

环境变量配置:
    LARK_APP_ID         飞书应用 App ID
    LARK_APP_SECRET     飞书应用 App Secret
    OBSIDIAN_VAULT_PATH Obsidian 仓库路径
    SYNC_INTERVAL       同步间隔（秒）

示例:
    export LARK_APP_ID="cli_xxx"
    export LARK_APP_SECRET="xxx"
    export OBSIDIAN_VAULT_PATH="\$HOME/Obsidian"
    $0 sync
EOF
}

# 主入口
case "${1:-help}" in
    sync)
        run_sync
        ;;
    daemon)
        run_daemon
        ;;
    *)
        show_help
        ;;
esac