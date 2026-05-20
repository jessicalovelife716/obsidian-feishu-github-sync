import { App, TFile, TFolder, Notice } from 'obsidian';
import { SyncSettings, DocumentMapping, SyncResult, SyncStatus } from '../types';
import { FeishuService } from './FeishuService';
import { GitHubService } from './GitHubService';
import { VaultAdapter } from './VaultAdapter';

type SyncStatusListener = (status: SyncStatus) => void;

export class SyncManager {
  private app: App;
  private feishu: FeishuService;
  private github: GitHubService;
  private settings: SyncSettings;
  private vaultAdapter: VaultAdapter;

  // Lock
  private _isSyncing = false;
  private _syncLock = false;
  private _statusListeners: SyncStatusListener[] = [];
  private _status: SyncStatus = 'idle';

  // Mappings
  private mappings: Map<string, DocumentMapping> = new Map();
  private feishuDocCache: Map<string, import('../types').FeishuDocInfo> = new Map();

  // File watcher debounce
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_MS = 3000;
  private watcherSuspended = false;

  // Callbacks for main.ts
  onStatusChange: ((status: SyncStatus, message?: string) => void) | null = null;
  onSyncComplete: ((result: SyncResult) => void) | null = null;

  constructor(
    app: App,
    settings: SyncSettings,
    mappings: DocumentMapping[],
    feishu: FeishuService,
    github: GitHubService,
    vaultAdapter: VaultAdapter,
  ) {
    this.app = app;
    this.settings = settings;
    this.vaultAdapter = vaultAdapter;
    this.feishu = feishu;
    this.github = github;

    for (const m of mappings) {
      this.mappings.set(m.localPath, m);
    }

    // Wire up image callbacks
    this.feishu.onImageDownloaded = async (localPath, data) => {
      await this.saveImageLocally(localPath, data);
    };
    this.feishu.onImageRead = async (localPath) => {
      return this.readImageLocally(localPath);
    };
  }

  // ==================== Status ====================

  get status(): SyncStatus {
    return this._status;
  }

  get isSyncing(): boolean {
    return this._isSyncing;
  }

  private setStatus(status: SyncStatus, message?: string) {
    this._status = status;
    this.onStatusChange?.(status, message);
  }

  // ==================== Sync Lock ====================

  private acquireLock(): boolean {
    if (this._syncLock) return false;
    this._syncLock = true;
    this._isSyncing = true;
    this.suspendWatcher();
    this.setStatus('syncing');
    return true;
  }

  private releaseLock(): void {
    this._syncLock = false;
    this._isSyncing = false;
    this.resumeWatcher();
    this.setStatus('idle');
  }

  // ==================== File Watcher Control ====================

  private suspendWatcher(): void {
    this.watcherSuspended = true;
  }

  private resumeWatcher(): void {
    this.watcherSuspended = false;
  }

  get isWatcherSuspended(): boolean {
    return this.watcherSuspended;
  }

  // ==================== Debounced File Change Handler ====================

  onFileModified(file: TFile): void {
    if (!this.settings.fileWatcherEnabled) return;
    if (this.watcherSuspended || this._syncLock) return;
    if (!this.shouldSyncFile(file.path)) return;

    // Clear existing timer for this file
    const existing = this.debounceTimers.get(file.path);
    if (existing) clearTimeout(existing);

    // Set new debounce timer (3s)
    const timer = setTimeout(() => {
      this.debounceTimers.delete(file.path);
      this.syncSingleFile(file).catch(console.error);
    }, this.DEBOUNCE_MS);

    this.debounceTimers.set(file.path, timer);
  }

  onFileRenamed(file: TFile, oldPath: string): void {
    // Update mapping with new path
    const mapping = this.mappings.get(oldPath);
    if (mapping) {
      this.mappings.delete(oldPath);
      mapping.localPath = file.path;
      this.mappings.set(file.path, mapping);
    }
  }

  onFileDeleted(filePath: string): void {
    // Do NOT call Feishu delete API — just unbind mapping
    const mapping = this.mappings.get(filePath);
    if (mapping) {
      // Optionally move Feishu doc to trash instead
      // this.feishu.deleteDocument(mapping.feishuDocId).catch(console.error);
      this.mappings.delete(filePath);
    }
  }

  // ==================== Main Sync ====================

  async syncAll(): Promise<SyncResult> {
    if (!this.acquireLock()) {
      return { success: false, direction: 'bidirectional', files: [], errors: ['Sync already in progress'] };
    }

    const result: SyncResult = { success: true, direction: 'bidirectional', files: [], errors: [] };

    try {
      // Step 1: Feishu → Obsidian
      const feishuResult = await this.syncFeishuToObsidian();
      result.files.push(...feishuResult.files);
      result.errors.push(...feishuResult.errors);

      // Step 2: Obsidian → Feishu
      const obsidianResult = await this.syncObsidianToFeishu();
      result.files.push(...obsidianResult.files);
      result.errors.push(...obsidianResult.errors);

      // Step 3: GitHub sync
      const githubResult = await this.syncWithGitHub();
      result.files.push(...githubResult.files);
      result.errors.push(...githubResult.errors);

      if (result.errors.length === 0) {
        this.setStatus('idle');
      } else {
        this.setStatus('error', `${result.errors.length} errors during sync`);
      }

      this.onSyncComplete?.(result);
    } catch (error) {
      result.success = false;
      result.errors.push(String(error));
      this.setStatus('error', String(error));
    } finally {
      this.releaseLock();
    }

    return result;
  }

  async syncFeishuOnly(): Promise<SyncResult> {
    if (!this.acquireLock()) {
      return { success: false, direction: 'to-obsidian', files: [], errors: ['Sync already in progress'] };
    }

    const result: SyncResult = { success: true, direction: 'bidirectional', files: [], errors: [] };

    try {
      const feishuResult = await this.syncFeishuToObsidian();
      result.files.push(...feishuResult.files);
      result.errors.push(...feishuResult.errors);

      const obsidianResult = await this.syncObsidianToFeishu();
      result.files.push(...obsidianResult.files);
      result.errors.push(...obsidianResult.errors);
    } catch (error) {
      result.success = false;
      result.errors.push(String(error));
    } finally {
      this.releaseLock();
    }

    return result;
  }

  async pushToGitHub(): Promise<SyncResult> {
    if (!this.acquireLock()) {
      return { success: false, direction: 'to-github', files: [], errors: ['Sync already in progress'] };
    }

    const result: SyncResult = { success: true, direction: 'to-github', files: [], errors: [] };

    try {
      const r = await this.github.sync();
      result.files.push(r.message);
    } catch (error) {
      result.success = false;
      result.errors.push(String(error));
    } finally {
      this.releaseLock();
    }

    return result;
  }

  async pullFromGitHub(): Promise<SyncResult> {
    if (!this.acquireLock()) {
      return { success: false, direction: 'to-obsidian', files: [], errors: ['Sync already in progress'] };
    }

    const result: SyncResult = { success: true, direction: 'to-obsidian', files: [], errors: [] };

    try {
      await this.github.ensureCloneOrPull();
      await this.github.pull();
      result.files.push('Pulled from GitHub');
    } catch (error) {
      result.success = false;
      result.errors.push(String(error));
    } finally {
      this.releaseLock();
    }

    return result;
  }

  // ==================== Feishu → Obsidian ====================

  async syncFeishuToObsidian(): Promise<SyncResult> {
    const result: SyncResult = { success: true, direction: 'to-obsidian', files: [], errors: [] };

    try {
      const feishuDocs = await this.feishu.listDocuments();
      this.feishuDocCache.clear();
      for (const doc of feishuDocs) {
        this.feishuDocCache.set(doc.docId, doc);
      }

      for (const docInfo of feishuDocs) {
        try {
          const localPath = this.findLocalPathByFeishu(docInfo.docId);
          const expectedPath = localPath || `Feishu/${this.sanitizeFilename(docInfo.title)}.md`;

          const doc = await this.feishu.getDocument(docInfo.docId);

          // Process images in content
          const { content, imageMap } = await this.processFeishuImages(doc.content);

          const existingFile = this.app.vault.getAbstractFileByPath(expectedPath);

          if (existingFile instanceof TFile) {
            const localContent = await this.app.vault.read(existingFile);
            const normalizedLocal = this.normalizeContent(localContent);
            const normalizedRemote = this.normalizeContent(doc.content);

            if (normalizedLocal !== normalizedRemote) {
              const localModified = existingFile.stat.mtime;
              const remoteModified = docInfo.updatedTime;

              if (localModified > remoteModified && this.settings.conflictStrategy === 'keep_both') {
                // Local is newer — keep both
                const conflictPath = expectedPath.replace('.md', `-feishu-conflict-${Date.now()}.md`);
                const frontmatter = this.generateFrontmatter(docInfo.title, docInfo.docId, 'feishu');
                await this.app.vault.create(conflictPath, `${frontmatter}\n# ${doc.title}\n\n${content}`);
                result.files.push(`Conflict (kept both): ${conflictPath}`);
              } else if (localModified > remoteModified && this.settings.conflictStrategy === 'local_wins') {
                result.files.push(`Skipped (local newer, strategy=local_wins): ${expectedPath}`);
              } else {
                // Remote wins
                const frontmatter = this.generateFrontmatter(docInfo.title, docInfo.docId, 'feishu');
                const newContent = `${frontmatter}\n# ${doc.title}\n\n${content}`;
                await this.app.vault.modify(existingFile, newContent);
                result.files.push(`Updated from Feishu: ${expectedPath}`);
                this.updateMapping(expectedPath, docInfo.docId);
              }
            }
          } else {
            // Create new file
            const folder = 'Feishu';
            await this.ensureFolderExists(folder);
            const fullPath = `${folder}/${this.sanitizeFilename(docInfo.title)}.md`;
            const frontmatter = this.generateFrontmatter(docInfo.title, docInfo.docId, 'feishu');
            const fileContent = `${frontmatter}\n# ${doc.title}\n\n${content}`;
            await this.app.vault.create(fullPath, fileContent);
            result.files.push(`Created from Feishu: ${fullPath}`);
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
      const files = this.app.vault.getFiles();

      for (const file of files) {
        if (!this.shouldSyncFile(file.path)) continue;
        if (file.path.startsWith('Feishu/')) continue;

        try {
          const content = await this.app.vault.read(file);
          const title = this.extractTitle(content, file.basename);
          const plainContent = this.stripFrontmatter(content);

          const mapping = this.mappings.get(file.path);

          if (mapping?.feishuDocId) {
            const feishuDoc = this.feishuDocCache.get(mapping.feishuDocId);
            if (feishuDoc) {
              const localModified = file.stat.mtime;
              const remoteModified = feishuDoc.updatedTime;

              // Check for conflicts
              if (localModified > remoteModified && remoteModified > mapping.lastSynced) {
                // Both modified — use configured strategy
                if (this.settings.conflictStrategy === 'remote_wins') {
                  result.files.push(`Skipped (remote wins): ${file.path}`);
                  continue;
                }
                // keep_both and local_wins both proceed with local push
              }

              // Push local changes
              await this.feishu.updateDocument(mapping.feishuDocId, plainContent, title);
              result.files.push(`Updated to Feishu: ${file.path}`);
              mapping.lastSynced = Date.now();
            } else {
              await this.feishu.updateDocument(mapping.feishuDocId, plainContent, title);
              result.files.push(`Updated to Feishu: ${file.path}`);
            }
          } else {
            const existingDoc = await this.feishu.findDocumentByTitle(title);
            if (existingDoc) {
              await this.feishu.updateDocument(existingDoc.docId, plainContent, title);
              this.updateMapping(file.path, existingDoc.docId);
              result.files.push(`Updated to Feishu: ${file.path}`);
            } else {
              const newDocId = await this.feishu.createDocument(title, plainContent);
              this.updateMapping(file.path, newDocId);
              result.files.push(`Created in Feishu: ${file.path}`);
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

  // ==================== GitHub Sync ====================

  private async syncWithGitHub(): Promise<SyncResult> {
    const result: SyncResult = { success: true, direction: 'to-github', files: [], errors: [] };

    try {
      const syncResult = await this.github.sync();
      result.files.push(syncResult.message);
    } catch (error) {
      result.errors.push(`GitHub sync failed: ${error}`);
    }

    return result;
  }

  // ==================== Single File Sync ====================

  async syncSingleFile(file: TFile): Promise<void> {
    if (this._syncLock) return;

    try {
      const content = await this.app.vault.read(file);
      const title = this.extractTitle(content, file.basename);
      const plainContent = this.stripFrontmatter(content);

      const mapping = this.mappings.get(file.path);

      if (mapping?.feishuDocId) {
        await this.feishu.updateDocument(mapping.feishuDocId, plainContent, title);
      } else {
        const existingDoc = await this.feishu.findDocumentByTitle(title);
        if (existingDoc) {
          await this.feishu.updateDocument(existingDoc.docId, plainContent, title);
          this.updateMapping(file.path, existingDoc.docId);
        } else {
          const newDocId = await this.feishu.createDocument(title, plainContent);
          this.updateMapping(file.path, newDocId);
        }
      }
    } catch (error) {
      console.error(`Failed to sync ${file.path}:`, error);
    }
  }

  // ==================== Image Handling ====================

  private async processFeishuImages(content: string): Promise<{ content: string; imageMap: Map<string, string> }> {
    const imageMap = new Map<string, string>();
    const attachmentFolder = this.settings.attachmentFolder || 'attachments/feishu';

    // Find all Feishu image tokens: ![](<file_token>)
    const imageRegex = /!\[\]\(([a-zA-Z0-9_\-]+)\)/g;
    let match;
    let processedContent = content;

    while ((match = imageRegex.exec(content)) !== null) {
      const fileToken = match[1];
      const localFileName = `feishu_${fileToken}.png`;
      const localPath = `${attachmentFolder}/${localFileName}`;

      try {
        // Download image
        await this.feishu.downloadImage(fileToken, localPath);
        imageMap.set(fileToken, localPath);

        // Replace Feishu URL with Obsidian wikilink
        processedContent = processedContent.replace(
          match[0],
          `![[${localPath}]]`,
        );
      } catch (e) {
        console.error(`Failed to download image ${fileToken}:`, e);
      }
    }

    return { content: processedContent, imageMap };
  }

  private async saveImageLocally(localPath: string, data: Uint8Array): Promise<void> {
    const folder = localPath.substring(0, localPath.lastIndexOf('/'));
    await this.ensureFolderExists(folder);
    await this.app.vault.adapter.writeBinary(localPath, data.buffer as ArrayBuffer);
  }

  private async readImageLocally(localPath: string): Promise<Uint8Array | null> {
    try {
      const ab = await this.app.vault.adapter.readBinary(localPath);
      return new Uint8Array(ab);
    } catch {
      return null;
    }
  }

  // ==================== Helpers ====================

  private shouldSyncFile(path: string): boolean {
    if (!this.settings.syncFolder) return true;
    return path.startsWith(this.settings.syncFolder);
  }

  private findLocalPathByFeishu(docId: string): string | null {
    for (const [path, mapping] of this.mappings) {
      if (mapping.feishuDocId === docId) return path;
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

  // ==================== Mapping Access ====================

  getMappings(): DocumentMapping[] {
    return Array.from(this.mappings.values());
  }

  updateSettings(settings: SyncSettings): void {
    this.settings = settings;
    this.feishu = new FeishuService(settings.feishu);

    // Re-wire image callbacks
    this.feishu.onImageDownloaded = async (localPath, data) => {
      await this.saveImageLocally(localPath, data);
    };
    this.feishu.onImageRead = async (localPath) => {
      return this.readImageLocally(localPath);
    };

    // GitHub service uses vaultAdapter which doesn't change
  }
}
