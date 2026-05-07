import { App, TFile, Notice } from 'obsidian';
import { SyncSettings, DocumentMapping, SyncResult } from '../types';
import { FeishuService, FeishuDocInfo } from './FeishuService';
import { GitHubService } from './GitHubService';

export class SyncManager {
  private app: App;
  private feishu: FeishuService;
  private github: GitHubService;
  private settings: SyncSettings;
  private mappings: Map<string, DocumentMapping> = new Map();
  private feishuDocCache: Map<string, FeishuDocInfo> = new Map();
  private syncTimeout: NodeJS.Timeout | null = null;
  private isSyncing = false;
  private debounceMs = 2000;

  constructor(app: App, settings: SyncSettings, mappings: DocumentMapping[]) {
    this.app = app;
    this.settings = settings;
    this.feishu = new FeishuService(settings.feishu);
    this.github = new GitHubService(settings.github, app.vault.getRoot().path);

    // Load mappings
    for (const m of mappings) {
      this.mappings.set(m.localPath, m);
    }
  }

  updateSettings(settings: SyncSettings): void {
    this.settings = settings;
    this.feishu = new FeishuService(settings.feishu);
    this.github = new GitHubService(settings.github, this.app.vault.getRoot().path);
  }

  async syncAll(): Promise<SyncResult> {
    if (this.isSyncing) {
      return { success: false, direction: 'to-obsidian', files: [], errors: ['Sync already in progress'] };
    }

    this.isSyncing = true;
    const result: SyncResult = { success: true, direction: 'bidirectional', files: [], errors: [] };

    try {
      // Step 1: Sync Feishu → Obsidian (get remote changes first)
      const feishuToObsidianResult = await this.syncFeishuToObsidian();
      result.files.push(...feishuToObsidianResult.files);
      result.errors.push(...feishuToObsidianResult.errors);

      // Step 2: Sync Obsidian → Feishu (push local changes)
      const obsidianToFeishuResult = await this.syncObsidianToFeishu();
      result.files.push(...obsidianToFeishuResult.files);
      result.errors.push(...obsidianToFeishuResult.errors);

      // Step 3: Sync GitHub (bidirectional)
      const githubResult = await this.syncWithGitHub();
      result.files.push(...githubResult.files);
      result.errors.push(...githubResult.errors);

      new Notice(`Sync complete: ${result.files.length} files, ${result.errors.length} errors`);
    } catch (error) {
      result.success = false;
      result.errors.push(String(error));
      new Notice(`Sync failed: ${error}`);
    } finally {
      this.isSyncing = false;
    }

    return result;
  }

  // ==================== Feishu → Obsidian ====================
  async syncFeishuToObsidian(): Promise<SyncResult> {
    const result: SyncResult = { success: true, direction: 'to-obsidian', files: [], errors: [] };

    try {
      // Get all Feishu docs
      const feishuDocs = await this.feishu.listDocuments();
      this.feishuDocCache.clear();
      for (const doc of feishuDocs) {
        this.feishuDocCache.set(doc.docId, doc);
      }

      for (const docInfo of feishuDocs) {
        try {
          // Find corresponding local file via mapping
          const localPath = this.findLocalPathByFeishu(docInfo.docId);
          const expectedPath = localPath || `Feishu/${this.sanitizeFilename(docInfo.title)}.md`;

          const doc = await this.feishu.getDocument(docInfo.docId);

          // Check if file exists locally
          const existingFile = this.app.vault.getAbstractFileByPath(expectedPath);

          if (existingFile instanceof TFile) {
            // Check if content differs (compare by hash or content)
            const localContent = await this.app.vault.read(existingFile);
            const normalizedLocal = this.normalizeContent(localContent);
            const normalizedRemote = this.normalizeContent(doc.content);

            if (normalizedLocal !== normalizedRemote) {
              // Check for conflict
              const localModified = existingFile.stat.mtime;
              const remoteModified = docInfo.updatedTime;

              if (localModified > remoteModified && this.settings.conflictStrategy === 'keep_both') {
                // Local is newer, create conflict copy
                const conflictPath = expectedPath.replace('.md', `-feishu-conflict-${Date.now()}.md`);
                const frontmatter = this.generateFrontmatter(docInfo.title, docInfo.docId, 'feishu');
                await this.app.vault.create(conflictPath, `${frontmatter}\n# ${doc.title}\n\n${doc.content}`);
                result.files.push(`Feishu conflict (kept both): ${conflictPath}`);
              } else if (localModified > remoteModified) {
                // Local is newer, keep local
                result.files.push(`Skipped (local newer): ${expectedPath}`);
              } else {
                // Remote is newer or no local, update
                const frontmatter = this.generateFrontmatter(docInfo.title, docInfo.docId, 'feishu');
                const newContent = `${frontmatter}\n# ${doc.title}\n\n${doc.content}`;
                await this.app.vault.modify(existingFile, newContent);
                result.files.push(`Updated from Feishu: ${expectedPath}`);

                // Update mapping
                this.updateMapping(expectedPath, docInfo.docId);
              }
            }
          } else {
            // Create new file from Feishu doc
            const folder = 'Feishu';
            await this.ensureFolderExists(folder);

            const fullPath = `${folder}/${this.sanitizeFilename(docInfo.title)}.md`;
            const frontmatter = this.generateFrontmatter(docInfo.title, docInfo.docId, 'feishu');
            const fileContent = `${frontmatter}\n# ${doc.title}\n\n${doc.content}`;
            await this.app.vault.create(fullPath, fileContent);
            result.files.push(`Created from Feishu: ${fullPath}`);

            // Update mapping
            this.updateMapping(fullPath, docInfo.docId);
          }
        } catch (error) {
          result.errors.push(`Failed to sync Feishu doc ${docInfo.docId}: ${error}`);
        }
      }
    } catch (error) {
      result.errors.push(`Feishu → Obsidian sync failed: ${error}`);
    }

    return result;
  }

  // ==================== Obsidian → Feishu ====================
  async syncObsidianToFeishu(): Promise<SyncResult> {
    const result: SyncResult = { success: true, direction: 'to-feishu', files: [], errors: [] };

    try {
      // Get all local files
      const files = this.app.vault.getFiles();

      for (const file of files) {
        if (!this.shouldSyncFile(file.path)) continue;

        try {
          // Skip Feishu folder files (already synced from Feishu)
          if (file.path.startsWith('Feishu/')) continue;

          const content = await this.app.vault.read(file);
          const title = this.extractTitle(content, file.basename);
          const plainContent = this.stripFrontmatter(content);

          // Find mapping for this file
          const mapping = this.mappings.get(file.path);
          const feishuDocId = mapping?.feishuDocId;

          if (feishuDocId) {
            // Update existing Feishu doc
            const feishuDoc = this.feishuDocCache.get(feishuDocId);
            if (feishuDoc) {
              // Check if content differs
              if (this.hasContentChanged(file, feishuDoc, plainContent)) {
                await this.feishu.updateDocument(feishuDocId, plainContent, title);
                result.files.push(`Updated to Feishu: ${file.path}`);
              }
            } else {
              // Doc not in cache, fetch and update
              await this.feishu.updateDocument(feishuDocId, plainContent, title);
              result.files.push(`Updated to Feishu: ${file.path}`);
            }
          } else {
            // Check if doc with same title exists in Feishu
            const existingDoc = await this.feishu.findDocumentByTitle(title);
            if (existingDoc) {
              // Update existing doc
              await this.feishu.updateDocument(existingDoc.docId, plainContent, title);
              this.updateMapping(file.path, existingDoc.docId);
              result.files.push(`Updated to Feishu: ${file.path}`);
            } else {
              // Create new doc in Feishu
              const newDocId = await this.feishu.createDocument(title, plainContent);
              this.updateMapping(file.path, newDocId);
              result.files.push(`Created in Feishu: ${file.path} → ${title}`);
            }
          }
        } catch (error) {
          result.errors.push(`Failed to sync ${file.path}: ${error}`);
        }
      }
    } catch (error) {
      result.errors.push(`Obsidian → Feishu sync failed: ${error}`);
    }

    return result;
  }

  private hasContentChanged(file: TFile, feishuDoc: FeishuDocInfo, plainContent: string): boolean {
    // Simple check - in production you'd want better comparison
    const localModified = file.stat.mtime;
    const remoteModified = feishuDoc.updatedTime;
    return Math.abs(localModified - remoteModified) > 60000; // 1 minute threshold
  }

  // ==================== GitHub Sync ====================
  private async syncWithGitHub(): Promise<SyncResult> {
    const result: SyncResult = { success: true, direction: 'to-github', files: [], errors: [] };

    try {
      // Pull from GitHub
      await this.github.pull();

      // Check for local changes and push
      const files = this.app.vault.getFiles();
      let hasChanges = false;

      for (const file of files) {
        if (!this.shouldSyncFile(file.path)) continue;
        if (file.path.startsWith('Feishu/')) continue; // Skip Feishu folder

        const localContent = await this.app.vault.read(file);
        const githubContent = await this.github.getFileContent(file.path);

        if (githubContent === null || localContent !== this.stripFrontmatter(githubContent)) {
          hasChanges = true;
        }
      }

      if (hasChanges) {
        const commitResult = await this.github.sync();
        result.files.push(`GitHub sync: ${commitResult.message}`);
      }
    } catch (error) {
      result.errors.push(`GitHub sync failed: ${error}`);
    }

    return result;
  }

  // ==================== File Change Handler ====================
  async onFileChange(file: TFile): Promise<void> {
    if (!this.shouldSyncFile(file.path)) return;
    if (file.path.startsWith('Feishu/')) return; // Don't auto-sync Feishu folder files

    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }

    this.syncTimeout = setTimeout(async () => {
      await this.syncSingleFile(file);
    }, this.debounceMs);
  }

  async syncSingleFile(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const title = this.extractTitle(content, file.basename);
      const plainContent = this.stripFrontmatter(content);

      const mapping = this.mappings.get(file.path);

      if (mapping?.feishuDocId) {
        // Update existing Feishu doc
        await this.feishu.updateDocument(mapping.feishuDocId, plainContent, title);
      } else {
        // Create new Feishu doc
        const newDocId = await this.feishu.createDocument(title, plainContent);
        this.updateMapping(file.path, newDocId);
      }
    } catch (error) {
      console.error(`Failed to sync ${file.path}:`, error);
    }
  }

  async onFileDelete(filePath: string): Promise<void> {
    const mapping = this.mappings.get(filePath);
    if (mapping?.feishuDocId) {
      try {
        await this.feishu.deleteDocument(mapping.feishuDocId);
        this.mappings.delete(filePath);
      } catch (error) {
        console.error(`Failed to delete Feishu doc ${mapping.feishuDocId}:`, error);
      }
    }
  }

  // ==================== Helpers ====================
  private shouldSyncFile(path: string): boolean {
    if (!this.settings.syncFolder) return true;
    const normalizedPath = path.replace(/\\/g, '/');
    return normalizedPath.startsWith(this.settings.syncFolder);
  }

  private findLocalPathByFeishu(docId: string): string | null {
    for (const [path, mapping] of this.mappings) {
      if (mapping.feishuDocId === docId) {
        return path;
      }
    }
    return null;
  }

  private updateMapping(localPath: string, feishuDocId: string): void {
    const existing = this.mappings.get(localPath);
    const mapping: DocumentMapping = {
      localPath,
      feishuDocId,
      githubPath: existing?.githubPath || localPath,
      lastSynced: Date.now(),
      hash: existing?.hash || '',
    };
    this.mappings.set(localPath, mapping);
  }

  private sanitizeFilename(name: string): string {
    return name.replace(/[\\/:*?"<>|]/g, '_').substring(0, 100);
  }

  private extractTitle(content: string, defaultTitle: string): string {
    // Try to extract title from first H1
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : defaultTitle;
  }

  private stripFrontmatter(content: string): string {
    const match = content.match(/^---\n[\s\S]*?\n---\n?/);
    return match ? content.slice(match[0].length) : content;
  }

  private normalizeContent(content: string): string {
    return this.stripFrontmatter(content).replace(/\s+/g, ' ').trim();
  }

  private generateFrontmatter(title: string, docId: string, source: string): string {
    return `---
title: ${title}
feishu_doc_id: ${docId}
source: ${source}
last_synced: ${new Date().toISOString()}
---`;
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (!existing) {
      await this.app.vault.createFolder(folderPath);
    }
  }

  getMappings(): DocumentMapping[] {
    return Array.from(this.mappings.values());
  }

  addMapping(mapping: DocumentMapping): void {
    this.mappings.set(mapping.localPath, mapping);
  }

  removeMapping(localPath: string): void {
    this.mappings.delete(localPath);
  }

  getMapping(filePath: string): DocumentMapping | undefined {
    return this.mappings.get(filePath);
  }
}