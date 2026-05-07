import { FeishuConfig } from '../types';

export interface FeishuDocInfo {
  docId: string;
  title: string;
  updatedTime: number;
}

export class FeishuService {
  private appId: string;
  private appSecret: string;
  private accessToken: string = '';
  private tokenExpiry: number = 0;

  constructor(config: FeishuConfig) {
    this.appId = config.appId;
    this.appSecret = config.appSecret;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const url = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });

    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(`Feishu auth failed: ${data.msg}`);
    }

    this.accessToken = data.tenant_access_token;
    this.tokenExpiry = Date.now() + (data.expire - 60) * 1000;
    return this.accessToken;
  }

  async listDocuments(folderToken?: string): Promise<FeishuDocInfo[]> {
    const token = await this.getAccessToken();
    const docs: FeishuDocInfo[] = [];
    let pageToken = '';
    let hasMore = true;

    while (hasMore) {
      let url = `https://open.feishu.cn/open-apis/docx/v1/documents?page_size=50`;
      if (pageToken) url += `&page_token=${pageToken}`;

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      const data = await response.json();
      if (data.code !== 0) {
        throw new Error(`Failed to list docs: ${data.msg}`);
      }

      for (const doc of data.data.items || []) {
        docs.push({
          docId: doc.document_id,
          title: doc.title || 'Untitled',
          updatedTime: doc.updated_time || 0,
        });
      }

      hasMore = data.data.has_more;
      pageToken = data.data.page_token || '';
    }

    return docs;
  }

  async getDocument(docId: string): Promise<{ title: string; content: string; updatedTime: number }> {
    const token = await this.getAccessToken();

    const response = await fetch(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(`Failed to get doc ${docId}: ${data.msg}`);
    }

    return {
      title: data.data.title || 'Untitled',
      content: await this.getDocumentBlocks(docId, token),
      updatedTime: data.data.updated_time || 0,
    };
  }

  private async getDocumentBlocks(docId: string, token: string): Promise<string> {
    const blocks: string[] = [];
    let pageToken = '';
    let hasMore = true;

    while (hasMore) {
      let url = `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks?page_size=500`;
      if (pageToken) url += `&page_token=${pageToken}`;

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      const data = await response.json();
      if (data.code !== 0) break;

      for (const block of data.data.items || []) {
        blocks.push(this.blockToMarkdown(block));
      }

      hasMore = data.data.has_more;
      pageToken = data.data.page_token || '';
    }

    return blocks.join('\n\n');
  }

  private blockToMarkdown(block: any): string {
    const type = block.block_type;
    const content = block.text_elements
      ?.map((e: any) => e.text_run?.content || '')
      .join('') || '';

    // Handle code blocks specially
    if (type === 21) {
      const lang = block.properties?.language || '';
      return `\`\`\`${lang}\n${content}\n\`\`\``;
    }

    switch (type) {
      case 1: return content; // paragraph
      case 2: return `# ${content}`; // heading1
      case 3: return `## ${content}`; // heading2
      case 4: return `### ${content}`; // heading3
      case 13: return `- ${content}`; // bullet
      case 14: return `1. ${content}`; // ordered
      case 15: return `> ${content}`; // quote
      case 17: return `**${content}**`; // bold
      case 18: return `*${content}*`; // italic
      case 19: return `~~${content}~~`; // strikethrough
      case 20: return `\`${content}\``; // inline code
      case 22: return `| ${content } |`; // table (simplified)
      default: return content;
    }
  }

  async createDocument(title: string, content: string): Promise<string> {
    const token = await this.getAccessToken();

    // Create document
    const response = await fetch(
      'https://open.feishu.cn/open-apis/docx/v1/documents',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title }),
      }
    );

    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(`Failed to create doc: ${data.msg}`);
    }

    const docId = data.data.document.document_id;

    // Write content
    if (content.trim()) {
      await this.writeContent(docId, content);
    }

    return docId;
  }

  async updateDocument(docId: string, content: string, title?: string): Promise<void> {
    const token = await this.getAccessToken();

    // Get root block ID
    const docInfo = await this.getDocument(docId);
    const rootBlockId = await this.getRootBlockId(docId, token);

    if (!rootBlockId) {
      throw new Error('Could not find root block');
    }

    // Get all current blocks and delete them
    const blocksResp = await fetch(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks?page_size=500`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const blocksData = await blocksResp.json();

    if (blocksData.code === 0 && blocksData.data.items?.length > 0) {
      // Batch delete all content blocks (skip root block)
      const blockIds = blocksData.data.items
        .filter((b: any) => b.block_id !== rootBlockId)
        .map((b: any) => b.block_id);

      if (blockIds.length > 0) {
        await this.batchDeleteBlocks(docId, blockIds, token);
      }
    }

    // Write new content
    if (content.trim()) {
      await this.appendContent(docId, rootBlockId, content, token);
    }

    // Update title if provided
    if (title && title !== docInfo.title) {
      await this.updateDocumentTitle(docId, title, token);
    }
  }

  private async getRootBlockId(docId: string, token: string): Promise<string | null> {
    const response = await fetch(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks?page_size=50`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const data = await response.json();

    if (data.code === 0 && data.data.items?.length > 0) {
      // First block is usually the root
      return data.data.items[0].block_id;
    }
    return null;
  }

  private async batchDeleteBlocks(docId: string, blockIds: string[], token: string): Promise<void> {
    // Delete in batches of 50
    const batchSize = 50;
    for (let i = 0; i < blockIds.length; i += batchSize) {
      const batch = blockIds.slice(i, i + batchSize);
      await fetch(
        `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/batch_delete`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ block_ids: batch }),
        }
      );
    }
  }

  private async updateDocumentTitle(docId: string, title: string, token: string): Promise<void> {
    await fetch(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title }),
      }
    );
  }

  private async writeContent(docId: string, content: string): Promise<void> {
    const token = await this.getAccessToken();
    const rootBlockId = await this.getRootBlockId(docId, token);

    if (rootBlockId) {
      await this.appendContent(docId, rootBlockId, content, token);
    }
  }

  private async appendContent(docId: string, afterBlockId: string, content: string, token: string): Promise<void> {
    const blocks = this.markdownToBlocks(content);
    if (blocks.length === 0) return;

    // Insert blocks after the root
    const response = await fetch(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${afterBlockId}/children`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          children: blocks,
          index: 0,
        }),
      }
    );

    const data = await response.json();
    if (data.code !== 0) {
      console.error(`Failed to insert blocks: ${data.msg}`);
    }
  }

  markdownToBlocks(content: string): any[] {
    const lines = content.split('\n');
    const blocks: any[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

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
          block_type: 21,
          text_elements: [{ text_run: { content: codeLines.join('\n') } }],
          properties: { language: lang },
        });
        i++;
        continue;
      }

      // Heading 1
      if (line.startsWith('# ')) {
        blocks.push({
          block_type: 2,
          text_elements: [{ text_run: { content: line.slice(2) } }],
        });
        i++;
        continue;
      }

      // Heading 2
      if (line.startsWith('## ')) {
        blocks.push({
          block_type: 3,
          text_elements: [{ text_run: { content: line.slice(3) } }],
        });
        i++;
        continue;
      }

      // Heading 3
      if (line.startsWith('### ')) {
        blocks.push({
          block_type: 4,
          text_elements: [{ text_run: { content: line.slice(4) } }],
        });
        i++;
        continue;
      }

      // Bullet list
      if (line.startsWith('- ')) {
        blocks.push({
          block_type: 13,
          text_elements: [{ text_run: { content: line.slice(2) } }],
        });
        i++;
        continue;
      }

      // Ordered list
      if (/^\d+\.\s/.test(line)) {
        blocks.push({
          block_type: 14,
          text_elements: [{ text_run: { content: line.replace(/^\d+\.\s/, '') } }],
        });
        i++;
        continue;
      }

      // Quote
      if (line.startsWith('> ')) {
        blocks.push({
          block_type: 15,
          text_elements: [{ text_run: { content: line.slice(2) } }],
        });
        i++;
        continue;
      }

      // Table row (simplified)
      if (line.startsWith('|')) {
        blocks.push({
          block_type: 22,
          text_elements: [{ text_run: { content: line } }],
        });
        i++;
        continue;
      }

      // Empty line - add paragraph break
      if (line.trim() === '') {
        blocks.push({
          block_type: 1,
          text_elements: [{ text_run: { content: '' } }],
        });
        i++;
        continue;
      }

      // Paragraph - combine consecutive lines
      const paraLines: string[] = [];
      while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('-') && !lines[i].startsWith('>') && !lines[i].startsWith('```') && !lines[i].startsWith('|') && !/^\d+\.\s/.test(lines[i])) {
        paraLines.push(lines[i]);
        i++;
      }

      if (paraLines.length > 0) {
        // Parse inline formatting
        const textRuns = this.parseInlineFormatting(paraLines.join(' '));
        blocks.push({
          block_type: 1,
          text_elements: textRuns,
        });
      }
    }

    return blocks;
  }

  private parseInlineFormatting(text: string): any[] {
    const runs: any[] = [];
    let remaining = text;
    let i = 0;

    while (remaining.length > 0) {
      // Check for bold
      const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
      // Check for italic
      const italicMatch = remaining.match(/\*(.+?)\*/);
      // Check for inline code
      const codeMatch = remaining.match(/`(.+?)`/);
      // Check for strikethrough
      const strikeMatch = remaining.match(/~~(.+?)~~/);

      // Find the earliest match
      const matches = [
        { type: 'bold', match: boldMatch, index: boldMatch?.index ?? Infinity },
        { type: 'italic', match: italicMatch, index: italicMatch?.index ?? Infinity },
        { type: 'code', match: codeMatch, index: codeMatch?.index ?? Infinity },
        { type: 'strike', match: strikeMatch, index: strikeMatch?.index ?? Infinity },
      ].filter(m => m.index < Infinity).sort((a, b) => a.index - b.index);

      if (matches.length === 0) {
        // Plain text
        if (remaining.trim()) {
          runs.push({ text_run: { content: remaining } });
        }
        break;
      }

      const first = matches[0];

      // Add plain text before match
      if (first.index > 0) {
        runs.push({ text_run: { content: remaining.slice(0, first.index) } });
      }

      // Add formatted text
      const content = first.match[1];
      switch (first.type) {
        case 'bold':
          runs.push({ text_run: { content, bold: true } });
          break;
        case 'italic':
          runs.push({ text_run: { content, italic: true } });
          break;
        case 'code':
          runs.push({ text_run: { content, code: true } });
          break;
        case 'strike':
          runs.push({ text_run: { content, strikethrough: true } });
          break;
      }

      remaining = remaining.slice(first.index + first.match[0].length);
    }

    if (runs.length === 0) {
      runs.push({ text_run: { content: text } });
    }

    return runs;
  }

  async deleteDocument(docId: string): Promise<void> {
    const token = await this.getAccessToken();

    await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/files/${docId}/trash`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      }
    );
  }

  // Find document by title
  async findDocumentByTitle(title: string): Promise<FeishuDocInfo | null> {
    const docs = await this.listDocuments();
    return docs.find(d => d.title === title) || null;
  }
}