import { App, TFile, Notice } from 'obsidian';
import { SyncSettings, DocumentMapping, SyncResult } from '../types';
import { FeishuService } from './FeishuService';
import { GitHubService } from './GitHubService';

export class SyncManager {
  private app: App;
  private feishu: FeishuService;
  private github: GitHubService;
  private settings: SyncSettings;
  private mappings: Map<string, DocumentMapping> = new Map();
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
      // Pull from GitHub first
      const pullResult = await this.syncFromGitHub();
      result.files.push(...pullResult.files);
      result.errors.push(...pullResult.errors);

      // Then push changes to GitHub
      const pushResult = await this.syncToGitHub();
      result.files.push(...pushResult.files);
      result.errors.push(...pushResult.errors);

      // Sync with Feishu
      const feishuResult = await this.syncWithFeishu();
      result.files.push(...feishuResult.files);
      result.errors.push(...feishuResult.errors);

      new Notice(`Sync complete: ${result.files.length} files synced`);
    } catch (error) {
      result.success = false;
      result.errors.push(String(error));
      new Notice(`Sync failed: ${error}`);
    } finally {
      this.isSyncing = false;
    }

    return result;
  }

  async syncFromGitHub(): Promise<SyncResult> {
    const result: SyncResult = { success: true, direction: 'to-obsidian', files: [], errors: [] };

    try {
      await this.github.pull();

      // Check for new/changed files in vault
      const files = this.app.vault.getFiles();
      for (const file of files) {
        if (!this.shouldSyncFile(file.path)) continue;

        const githubContent = await this.github.getFileContent(file.path);
        if (githubContent === null) continue;

        const localContent = await this.app.vault.read(file);

        if (localContent !== githubContent) {
          // Check for conflict
          const localModified = file.stat.mtime;
          const remoteModified = await this.github.getLastModified(file.path);

          if (remoteModified && localModified > remoteModified.getTime()) {
            // Local is newer - keep local (or handle according to strategy)
            if (this.settings.conflictStrategy === 'keep_both') {
              const newPath = file.path.replace('.md', `-conflict-${Date.now()}.md`);
              await this.app.vault.create(newPath, githubContent);
              result.files.push(`Conflict resolved (kept both): ${file.path}`);
            }
          } else {
            // Remote is newer or no local modification
            await this.app.vault.modify(file, githubContent);
            result.files.push(`Updated from GitHub: ${file.path}`);
          }
        }
      }
    } catch (error) {
      result.errors.push(`GitHub pull failed: ${error}`);
    }

    return result;
  }

  async syncToGitHub(): Promise<SyncResult> {
    const result: SyncResult = { success: true, direction: 'to-github', files: [], errors: [] };

    try {
      const status = await this.app.vault.adapter.stat('.obsidian');
      if (!status) {
        // Vault path not accessible for git operations
        return result;
      }

      const files = this.app.vault.getFiles();
      for (const file of files) {
        if (!this.shouldSyncFile(file.path)) continue;

        const localContent = await this.app.vault.read(file);
        const githubContent = await this.github.getFileContent(file.path);

        if (githubContent === null || localContent !== githubContent) {
          // Write to GitHub via file system (git will pick it up)
          // For simplicity, just mark for commit
          result.files.push(`Marked for sync: ${file.path}`);
        }
      }

      const commitResult = await this.github.sync();
      if (commitResult.hasChanges) {
        result.files.push(`Committed and pushed: ${commitResult.message}`);
      }
    } catch (error) {
      result.errors.push(`GitHub push failed: ${error}`);
    }

    return result;
  }

  async syncWithFeishu(): Promise<SyncResult> {
    const result: SyncResult = { success: true, direction: 'to-feishu', files: [], errors: [] };

    try {
      const docs = await this.feishu.listDocuments();

      for (const docId of docs) {
        const doc = await this.feishu.getDocument(docId);
        const localPath = this.findMappingByFeishu(docId) || `Feishu/${doc.title}.md`;

        // Check if file exists locally
        const existingFile = this.app.vault.getAbstractFileByPath(localPath.replace('.md', ''));

        if (existingFile instanceof TFile) {
          // Update existing file
          const localContent = await this.app.vault.read(existingFile);
          if (localContent !== doc.content) {
            await this.app.vault.modify(existingFile, doc.content);
            result.files.push(`Updated from Feishu: ${localPath}`);
          }
        } else {
          // Create new file
          await this.app.vault.create(localPath, `# ${doc.title}\n\n${doc.content}`);
          result.files.push(`Created from Feishu: ${localPath}`);
        }
      }
    } catch (error) {
      result.errors.push(`Feishu sync failed: ${error}`);
    }

    return result;
  }

  async onFileChange(file: TFile): Promise<void> {
    if (!this.shouldSyncFile(file.path)) return;

    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }

    this.syncTimeout = setTimeout(async () => {
      await this.syncFile(file);
    }, this.debounceMs);
  }

  async syncFile(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);

    // Sync to GitHub
    try {
      const mapping = this.mappings.get(file.path);
      if (mapping?.githubPath) {
        // File has GitHub path mapping
      }
    } catch (error) {
      console.error(`Failed to sync ${file.path}:`, error);
    }
  }

  private shouldSyncFile(path: string): boolean {
    if (!this.settings.syncFolder) return true;

    // Check if file is in sync folder
    const normalizedPath = path.replace(/\\/g, '/');
    return normalizedPath.startsWith(this.settings.syncFolder);
  }

  private findMappingByFeishu(docId: string): string | null {
    for (const [path, mapping] of this.mappings) {
      if (mapping.feishuDocId === docId) {
        return path;
      }
    }
    return null;
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
}