import { FeishuConfig, FeishuDocInfo, FeishuBlockType } from '../types';

// ==================== API Queue & Rate Limiter ====================

interface QueuedTask<T> {
  fn: () => Promise<T>;
  resolve: (val: T) => void;
  reject: (err: any) => void;
  retries: number;
}

class ApiQueue {
  private queue: QueuedTask<any>[] = [];
  private activeCount = 0;
  private readonly MAX_CONCURRENCY = 5;
  private readonly MAX_RETRIES = 5;

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, retries: 0 });
      this.processNext();
    });
  }

  private processNext(): void {
    if (this.activeCount >= this.MAX_CONCURRENCY || this.queue.length === 0) return;

    const task = this.queue.shift()!;
    this.activeCount++;

    task
      .fn()
      .then(task.resolve)
      .catch(async (err) => {
        if (this.isRetryable(err) && task.retries < this.MAX_RETRIES) {
          task.retries++;
          const delay = Math.min(1000 * Math.pow(2, task.retries - 1), 16000);
          await new Promise((r) => setTimeout(r, delay));
          this.queue.unshift(task);
        } else {
          task.reject(err);
        }
      })
      .finally(() => {
        this.activeCount--;
        this.processNext();
      });

    this.processNext();
  }

  private isRetryable(err: any): boolean {
    if (err?.status === 429) return true;
    if (err?.status >= 500 && err?.status < 600) return true;
    if (err?.message?.includes('ECONNRESET')) return true;
    if (err?.message?.includes('ETIMEDOUT')) return true;
    return false;
  }
}

// ==================== Feishu Service ====================

export interface FeishuDocInfo {
  docId: string;
  title: string;
  updatedTime: number;
}

interface FeishuBlock {
  block_id: string;
  block_type: number;
  text_elements?: { text_run?: { content: string; bold?: boolean; italic?: boolean; code?: boolean; strikethrough?: boolean } }[];
  properties?: any;
  children?: FeishuBlock[];
}

export class FeishuService {
  private appId: string;
  private appSecret: string;
  private accessToken = '';
  private tokenExpiry = 0;
  private queue = new ApiQueue();

  constructor(config: FeishuConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
  }

  // ==================== Auth ====================

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    return this.queue.enqueue(async () => {
      const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      });

      const data = await resp.json();
      if (data.code !== 0) throw new Error(`Feishu auth failed: ${data.msg}`);

      this.accessToken = data.tenant_access_token;
      this.tokenExpiry = Date.now() + (data.expire - 60) * 1000;
      return this.accessToken;
    });
  }

  private async request<T>(
    url: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(options.headers as Record<string, string> || {}),
    };
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }

    return this.queue.enqueue(async () => {
      const resp = await fetch(url, { ...options, headers });
      if (resp.status === 429) {
        const err: any = new Error('Too Many Requests');
        err.status = 429;
        throw err;
      }
      if (!resp.ok) {
        const err: any = new Error(`Feishu API error: ${resp.status}`);
        err.status = resp.status;
        throw err;
      }
      return resp.json() as Promise<T>;
    });
  }

  // ==================== Document CRUD ====================

  async listDocuments(folderToken?: string): Promise<FeishuDocInfo[]> {
    const docs: FeishuDocInfo[] = [];
    let pageToken = '';
    let hasMore = true;

    while (hasMore) {
      let url = `https://open.feishu.cn/open-apis/docx/v1/documents?page_size=50`;
      if (pageToken) url += `&page_token=${pageToken}`;

      const data: any = await this.request(url);
      for (const doc of data.data?.items || []) {
        docs.push({
          docId: doc.document_id,
          title: doc.title || 'Untitled',
          updatedTime: doc.update_time || doc.updated_time || 0,
        });
      }

      hasMore = data.data?.has_more || false;
      pageToken = data.data?.page_token || '';
    }

    return docs;
  }

  async getDocument(docId: string): Promise<{ title: string; content: string; updatedTime: number }> {
    const data: any = await this.request(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}`,
    );

    const title = data.data?.title || 'Untitled';
    const updatedTime = data.data?.update_time || data.data?.updated_time || 0;
    const content = await this.getDocumentMarkdown(docId);

    return { title, content, updatedTime };
  }

  private async getDocumentMarkdown(docId: string): Promise<string> {
    const blocks: FeishuBlock[] = await this.fetchAllBlocks(docId);
    return blocks.map((b) => this.blockToMarkdown(b)).join('\n\n');
  }

  private async fetchAllBlocks(docId: string, pageToken = ''): Promise<FeishuBlock[]> {
    let url = `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks?page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;

    const data: any = await this.request(url);
    const items: FeishuBlock[] = data.data?.items || [];

    // Recursively fetch children for each block
    for (const block of items) {
      if (block.children && block.children.length > 0) {
        const childBlocks = await this.fetchAllBlocks(docId, pageToken);
        // Actually fetch children by block_id
        const children = await this.fetchBlockChildren(docId, block.block_id);
        block.children = children;
      }
    }

    return items;
  }

  private async fetchBlockChildren(docId: string, blockId: string): Promise<FeishuBlock[]> {
    const data: any = await this.request(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${blockId}/children?page_size=500`,
    );
    return data.data?.items || [];
  }

  // ==================== Block → Markdown ====================

  private blockToMarkdown(block: FeishuBlock, indent = ''): string {
    const type = block.block_type;
    const text = this.extractText(block);

    switch (type) {
      case FeishuBlockType.Heading1:
        return `# ${text}`;
      case FeishuBlockType.Heading2:
        return `## ${text}`;
      case FeishuBlockType.Heading3:
        return `### ${text}`;
      case FeishuBlockType.Bullet:
        return `${indent}- ${text}`;
      case FeishuBlockType.Ordered:
        return `${indent}1. ${text}`;
      case FeishuBlockType.Quote:
        return `> ${text}`;
      case FeishuBlockType.CodeBlock:
        return this.formatCodeBlock(block);
      case FeishuBlockType.Image:
        return this.formatImage(block);
      case FeishuBlockType.Divider:
        return `---`;
      case FeishuBlockType.Callout:
        return this.formatCallout(block, indent);
      case FeishuBlockType.Paragraph:
      default:
        return text || '';
    }
  }

  private extractText(block: FeishuBlock): string {
    if (!block.text_elements) return '';
    return block.text_elements
      .map((el) => {
        const run = el.text_run;
        if (!run) return '';
        let content = run.content || '';
        if (run.bold) content = `**${content}**`;
        if (run.italic) content = `*${content}*`;
        if (run.strikethrough) content = `~~${content}~~`;
        if (run.code) content = `\`${content}\``;
        return content;
      })
      .join('');
  }

  private formatCodeBlock(block: FeishuBlock): string {
    const lang = block.properties?.language || '';
    const text = this.extractText(block);
    return `\`\`\`${lang}\n${text}\n\`\`\``;
  }

  private formatImage(block: FeishuBlock): string {
    // Feishu image blocks have file_token in properties
    const fileToken = block.properties?.file_token || '';
    const width = block.properties?.width || '';
    const height = block.properties?.height || '';
    if (fileToken) {
      // Will be resolved by SyncManager to local path
      return `![](${fileToken})`;
    }
    return '';
  }

  private formatCallout(block: FeishuBlock, indent: string): string {
    const type = block.properties?.callout_type || 'note';
    const text = this.extractText(block);
    let md = `${indent}> [!${type}] ${text}`;
    if (block.children) {
      for (const child of block.children) {
        md += '\n' + this.blockToMarkdown(child, indent + '> ');
      }
    }
    return md;
  }

  // ==================== Create / Update / Delete ====================

  async createDocument(title: string, content: string): Promise<string> {
    const data: any = await this.request(
      'https://open.feishu.cn/open-apis/docx/v1/documents',
      {
        method: 'POST',
        body: JSON.stringify({ title }),
      },
    );

    const docId = data.data?.document?.document_id;
    if (!docId) throw new Error('Failed to create Feishu doc: no document_id');

    if (content.trim()) {
      await this.writeDocumentContent(docId, content);
    }

    return docId;
  }

  async updateDocument(docId: string, content: string, title?: string): Promise<void> {
    const rootBlockId = await this.getRootBlockId(docId);

    if (!rootBlockId) throw new Error('Could not find root block');

    // Clear existing blocks
    const existingBlocks = await this.fetchAllBlocks(docId);
    const blockIds = existingBlocks
      .filter((b) => b.block_id !== rootBlockId)
      .map((b) => b.block_id);

    if (blockIds.length > 0) {
      await this.batchDeleteBlocks(docId, blockIds);
    }

    // Write new content
    if (content.trim()) {
      await this.appendBlocks(docId, rootBlockId, content);
    }

    // Update title
    if (title) {
      await this.request(
        `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ title }),
        },
      );
    }
  }

  async deleteDocument(docId: string): Promise<void> {
    // Move to trash instead of permanent delete
    await this.request(
      `https://open.feishu.cn/open-apis/drive/v1/files/${docId}/trash`,
      { method: 'POST' },
    );
  }

  private async getRootBlockId(docId: string): Promise<string | null> {
    const data: any = await this.request(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks?page_size=50`,
    );
    return data.data?.items?.[0]?.block_id || null;
  }

  private async batchDeleteBlocks(docId: string, blockIds: string[]): Promise<void> {
    const batchSize = 50;
    for (let i = 0; i < blockIds.length; i += batchSize) {
      const batch = blockIds.slice(i, i + batchSize);
      await this.request(
        `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/batch_delete`,
        {
          method: 'DELETE',
          body: JSON.stringify({ block_ids: batch }),
        },
      );
    }
  }

  private async writeDocumentContent(docId: string, content: string): Promise<void> {
    const rootBlockId = await this.getRootBlockId(docId);
    if (rootBlockId) {
      await this.appendBlocks(docId, rootBlockId, content);
    }
  }

  private async appendBlocks(docId: string, afterBlockId: string, content: string): Promise<void> {
    const { blocks, images } = this.markdownToBlocks(content);

    if (blocks.length > 0) {
      await this.request(
        `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${afterBlockId}/children`,
        {
          method: 'POST',
          body: JSON.stringify({ children: blocks, index: 0 }),
        },
      );
    }

    // Upload images and insert image blocks
    for (const img of images) {
      try {
        const fileToken = await this.uploadImage(img.localPath);
        if (fileToken) {
          const imgBlock = {
            block_type: FeishuBlockType.Image,
            properties: { file_token: fileToken },
          };
          await this.request(
            `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${afterBlockId}/children`,
            {
              method: 'POST',
              body: JSON.stringify({ children: [imgBlock], index: -1 }),
            },
          );
        }
      } catch (e) {
        console.error(`Failed to upload image ${img.localPath}:`, e);
      }
    }
  }

  async findDocumentByTitle(title: string): Promise<FeishuDocInfo | null> {
    const docs = await this.listDocuments();
    return docs.find((d) => d.title === title) || null;
  }

  // ==================== Markdown → Feishu Blocks ====================

  private markdownToBlocks(content: string): { blocks: any[]; images: { localPath: string; alt: string }[] } {
    const lines = content.split('\n');
    const blocks: any[] = [];
    const images: { localPath: string; alt: string }[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Image: ![[local.png]] or ![](path)
      const imgMatch = line.match(/!\[\[([^\]]+)\]\]/);
      const mdImgMatch = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (imgMatch) {
        images.push({ localPath: imgMatch[1], alt: imgMatch[1] });
        i++;
        continue;
      }
      if (mdImgMatch) {
        images.push({ localPath: mdImgMatch[2], alt: mdImgMatch[1] });
        i++;
        continue;
      }

      // Code block
      if (line.startsWith('```')) {
        const lang = line.slice(3).trim();
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        blocks.push({
          block_type: FeishuBlockType.CodeBlock,
          text_elements: [{ text_run: { content: codeLines.join('\n') } }],
          properties: { language: lang },
        });
        i++;
        continue;
      }

      // Horizontal rule
      if (/^---\s*$/.test(line) || /^___\s*$/.test(line) || /^\*\*\*\s*$/.test(line)) {
        blocks.push({ block_type: FeishuBlockType.Divider });
        i++;
        continue;
      }

      // Heading 1
      if (line.startsWith('# ')) {
        blocks.push(this.textBlock(FeishuBlockType.Heading1, line.slice(2)));
        i++;
        continue;
      }

      // Heading 2
      if (line.startsWith('## ')) {
        blocks.push(this.textBlock(FeishuBlockType.Heading2, line.slice(3)));
        i++;
        continue;
      }

      // Heading 3
      if (line.startsWith('### ')) {
        blocks.push(this.textBlock(FeishuBlockType.Heading3, line.slice(4)));
        i++;
        continue;
      }

      // Bullet list
      if (line.startsWith('- ') || line.startsWith('* ')) {
        blocks.push(this.textBlock(FeishuBlockType.Bullet, line.slice(2)));
        i++;
        continue;
      }

      // Ordered list
      if (/^\d+\.\s/.test(line)) {
        blocks.push(this.textBlock(FeishuBlockType.Ordered, line.replace(/^\d+\.\s/, '')));
        i++;
        continue;
      }

      // Quote
      if (line.startsWith('> ')) {
        blocks.push(this.textBlock(FeishuBlockType.Quote, line.slice(2)));
        i++;
        continue;
      }

      // Empty line
      if (line.trim() === '') {
        blocks.push({ block_type: FeishuBlockType.Paragraph, text_elements: [{ text_run: { content: '' } }] });
        i++;
        continue;
      }

      // Paragraph — batch consecutive lines
      const paraLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].startsWith('#') &&
        !lines[i].startsWith('- ') &&
        !lines[i].startsWith('* ') &&
        !lines[i].startsWith('> ') &&
        !lines[i].startsWith('```') &&
        !/^\d+\.\s/.test(lines[i]) &&
        !/^---\s*$/.test(lines[i]) &&
        !/^!\[/.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i++;
      }

      if (paraLines.length > 0) {
        blocks.push(this.inlineBlock(FeishuBlockType.Paragraph, paraLines.join(' ')));
      }
    }

    return { blocks, images };
  }

  private textBlock(type: FeishuBlockType, text: string): any {
    const elements = this.parseInlineFormatting(text);
    return { block_type: type, text_elements: elements };
  }

  private inlineBlock(type: FeishuBlockType, text: string): any {
    return { block_type: type, text_elements: this.parseInlineFormatting(text) };
  }

  private parseInlineFormatting(text: string): any[] {
    const runs: any[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
      const italicMatch = remaining.match(/\*(.+?)\*/);
      const codeMatch = remaining.match(/`(.+?)`/);
      const strikeMatch = remaining.match(/~~(.+?)~~/);

      const matches = [
        { type: 'bold', match: boldMatch, idx: boldMatch?.index ?? Infinity },
        { type: 'italic', match: italicMatch, idx: italicMatch?.index ?? Infinity },
        { type: 'code', match: codeMatch, idx: codeMatch?.index ?? Infinity },
        { type: 'strike', match: strikeMatch, idx: strikeMatch?.index ?? Infinity },
      ]
        .filter((m) => m.idx < Infinity)
        .sort((a, b) => a.idx - b.idx);

      if (matches.length === 0) {
        if (remaining.trim()) {
          runs.push({ text_run: { content: remaining } });
        }
        break;
      }

      const first = matches[0];
      if (first.idx > 0) {
        runs.push({ text_run: { content: remaining.slice(0, first.idx) } });
      }

      switch (first.type) {
        case 'bold':
          runs.push({ text_run: { content: first.match![1], bold: true } });
          break;
        case 'italic':
          runs.push({ text_run: { content: first.match![1], italic: true } });
          break;
        case 'code':
          runs.push({ text_run: { content: first.match![1], code: true } });
          break;
        case 'strike':
          runs.push({ text_run: { content: first.match![1], strikethrough: true } });
          break;
      }

      remaining = remaining.slice(first.idx + first.match![0].length);
    }

    if (runs.length === 0) {
      runs.push({ text_run: { content: text } });
    }

    return runs;
  }

  // ==================== Image Operations ====================

  async downloadImage(fileToken: string, localPath: string): Promise<void> {
    // Download image from Feishu and save locally
    const token = await this.getAccessToken();
    const resp = await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/medias/${fileToken}/download`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!resp.ok) throw new Error(`Failed to download image ${fileToken}`);

    const blob = await resp.blob();
    const ab = await blob.arrayBuffer();

    // Write via adapter — SyncManager provides the vault adapter for writing
    // This is handled externally via the callback
    if (this.onImageDownloaded) {
      await this.onImageDownloaded(localPath, new Uint8Array(ab));
    }
  }

  // Callback set by SyncManager for writing downloaded images
  onImageDownloaded: ((localPath: string, data: Uint8Array) => Promise<void>) | null = null;

  async uploadImage(localPath: string): Promise<string | null> {
    // Upload image to Feishu
    const token = await this.getAccessToken();

    // Read image file
    if (!this.onImageRead) return null;
    const imgData = await this.onImageRead(localPath);
    if (!imgData) return null;

    const blob = new Blob([imgData]);
    const formData = new FormData();
    formData.append('file_name', localPath.split('/').pop() || 'image.png');
    formData.append('parent_type', 'docx_image');
    formData.append('parent_node', '');
    formData.append('size', String(blob.size));
    formData.append('file', blob);

    const resp = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    const data = await resp.json();
    if (data.code !== 0) {
      console.error('Feishu upload image failed:', data.msg);
      return null;
    }

    return data.data?.file_token || null;
  }

  onImageRead: ((localPath: string) => Promise<Uint8Array | null>) | null = null;
}
