import { FeishuConfig } from '../types';

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

  async listDocuments(folderToken?: string): Promise<string[]> {
    const token = await this.getAccessToken();
    const docs: string[] = [];
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
        docs.push(doc.document_id);
      }

      hasMore = data.data.has_more;
      pageToken = data.data.page_token || '';
    }

    return docs;
  }

  async getDocument(docId: string): Promise<{ title: string; content: string }> {
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

    switch (type) {
      case 1: return content; // paragraph
      case 2: return `## ${content}`; // heading1
      case 3: return `### ${content}`; // heading2
      case 4: return `#### ${content}`; // heading3
      case 13: return `- ${content}`; // bullet
      case 14: return `1. ${content}`; // ordered
      case 15: return `> ${content}`; // quote
      case 21: return `\`\`\`\n${content}\n\`\`\``; // code
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
    await this.writeContent(docId, content);

    return docId;
  }

  async updateDocument(docId: string, content: string): Promise<void> {
    const token = await this.getAccessToken();

    // Get existing blocks to clear
    const blocks = await this.getDocumentBlocks(docId, token);

    // Use overwrite command to replace content
    const response = await fetch(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks`,
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      }
    );

    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(`Failed to get blocks: ${data.msg}`);
    }

    // Delete all existing blocks and rewrite
    for (const block of data.data.items || []) {
      await this.deleteBlock(docId, block.block_id, token);
    }

    await this.writeContent(docId, content);
  }

  private async writeContent(docId: string, content: string): Promise<void> {
    const token = await this.getAccessToken();

    // Parse markdown to blocks and insert
    const blocks = this.markdownToBlocks(content);

    for (const block of blocks) {
      await this.insertBlockAfter(docId, '', block, token);
    }
  }

  private markdownToBlocks(content: string): any[] {
    const lines = content.split('\n');
    const blocks: any[] = [];

    for (const line of lines) {
      if (line.startsWith('### ')) {
        blocks.push({ block_type: 4, text_elements: [{ text_run: { content: line.slice(4) } }] });
      } else if (line.startsWith('## ')) {
        blocks.push({ block_type: 3, text_elements: [{ text_run: { content: line.slice(3) } }] });
      } else if (line.startsWith('# ')) {
        blocks.push({ block_type: 2, text_elements: [{ text_run: { content: line.slice(2) } }] });
      } else if (line.startsWith('- ')) {
        blocks.push({ block_type: 13, text_elements: [{ text_run: { content: line.slice(2) } }] });
      } else if (line.startsWith('> ')) {
        blocks.push({ block_type: 15, text_elements: [{ text_run: { content: line.slice(2) } }] });
      } else if (line.startsWith('```')) {
        blocks.push({ block_type: 21, text_elements: [{ text_run: { content: line.slice(3) } }] });
      } else if (line.trim()) {
        blocks.push({ block_type: 1, text_elements: [{ text_run: { content: line } }] });
      }
    }

    return blocks;
  }

  private async insertBlockAfter(docId: string, afterBlockId: string, block: any, token: string): Promise<void> {
    const response = await fetch(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${afterBlockId || 'insert'}/children`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          children: [block],
          index: afterBlockId ? undefined : 0,
        }),
      }
    );

    const data = await response.json();
    if (data.code !== 0) {
      console.error(`Failed to insert block: ${data.msg}`);
    }
  }

  private async deleteBlock(docId: string, blockId: string, token: string): Promise<void> {
    await fetch(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/batch_delete`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ start_index: 0, end_index: 1, block_ids: [blockId] }),
      }
    );
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
}