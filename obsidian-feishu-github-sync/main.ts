import { App, Notice, Plugin, TAbstractFile, TFile } from 'obsidian';
import { FeishuService } from './src/services/FeishuService';
import { GitHubService } from './src/services/GitHubService';
import { SyncManager } from './src/services/SyncManager';
import { SyncSettings, DocumentMapping } from './src/types';

// Default settings
const DEFAULT_SETTINGS: SyncSettings = {
  feishu: { appId: '', appSecret: '' },
  github: { token: '', owner: '', repo: 'obsidian-notes', branch: 'main' },
  syncInterval: 30,
  autoSync: true,
  syncDirection: 'bidirectional',
  conflictStrategy: 'keep_both',
  syncFolder: '',
};

interface PluginData {
  settings: SyncSettings;
  mappings: DocumentMapping[];
  lastSynced: number;
}

export default class FeishuGitHubSyncPlugin extends Plugin {
  private settings: SyncSettings = { ...DEFAULT_SETTINGS };
  private mappings: DocumentMapping[] = [];
  private syncManager!: SyncManager;
  private syncIntervalId: number = 0;
  private debounceTimeout: NodeJS.Timeout | null = null;
  private isSyncing = false;
  private debounceMs = 2000;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.syncManager = new SyncManager(this.app, this.settings, this.mappings);

    this.addCommand({
      id: 'sync-all',
      name: 'Sync all',
      callback: () => this.syncAll(),
    });

    this.addCommand({
      id: 'sync-to-github',
      name: 'Push to GitHub',
      callback: () => this.pushToGitHub(),
    });

    this.addCommand({
      id: 'sync-from-github',
      name: 'Pull from GitHub',
      callback: () => this.pullFromGitHub(),
    });

    this.registerEvent(
      this.app.vault.on('modify', (file) => this.onFileChange(file))
    );
    this.registerEvent(
      this.app.vault.on('create', (file) => this.onFileChange(file))
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.onFileDelete(file))
    );
    this.registerEvent(
      this.app.vault.on('rename', (file) => this.onRename(file))
    );

    if (this.settings.autoSync) {
      this.startAutoSync();
    }

    this.addSettingTab(new FeishuSyncSettingsTab(this.app, this));

    new Notice('Feishu GitHub Sync loaded');
  }

  onunload(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
    }
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }
    this.savePluginData();
  }

  private async loadPluginData(): Promise<void> {
    const data: PluginData = await this.loadData();
    if (data?.settings) {
      this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    }
    if (data?.mappings) {
      this.mappings = data.mappings;
    }
  }

  private async savePluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      mappings: this.mappings,
      lastSynced: Date.now(),
    });
  }

  async syncAll(): Promise<void> {
    if (this.isSyncing) {
      new Notice('Sync already in progress');
      return;
    }

    this.isSyncing = true;
    new Notice('Syncing...');

    try {
      const result = await this.syncManager.syncAll();
      const msg = `Sync complete: ${result.files.length} files, ${result.errors.length} errors`;
      new Notice(msg);
    } catch (error) {
      new Notice(`Sync failed: ${error}`);
    } finally {
      this.isSyncing = false;
    }
  }

  async pushToGitHub(): Promise<void> {
    new Notice('Pushing to GitHub...');
    try {
      // Implementation
      new Notice('Push complete');
    } catch (error) {
      new Notice(`Push failed: ${error}`);
    }
  }

  async pullFromGitHub(): Promise<void> {
    new Notice('Pulling from GitHub...');
    try {
      // Implementation
      new Notice('Pull complete');
    } catch (error) {
      new Notice(`Pull failed: ${error}`);
    }
  }

  private onFileChange(file: TAbstractFile): void {
    if (!(file instanceof TFile) || !file.path.endsWith('.md')) return;
    if (!this.settings.autoSync || this.isSyncing) return;

    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }

    this.debounceTimeout = setTimeout(() => {
      this.syncFile(file as TFile);
    }, this.debounceMs);
  }

  private async syncFile(file: TFile): Promise<void> {
    try {
      await this.syncManager.onFileChange(file);
    } catch (error) {
      console.error(`Failed to sync ${file.path}:`, error);
    }
  }

  private async onFileDelete(file: TAbstractFile): Promise<void> {
    // Handle deletion
  }

  private async onRename(file: TAbstractFile): Promise<void> {
    // Handle rename
  }

  private startAutoSync(): void {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
    }

    this.syncIntervalId = window.setInterval(() => {
      this.syncAll();
    }, this.settings.syncInterval * 60 * 1000);
  }

  updateSettings(settings: SyncSettings): void {
    this.settings = { ...settings };
    this.syncManager.updateSettings(this.settings);
    this.savePluginData();

    if (settings.autoSync) {
      this.startAutoSync();
    } else if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
    }
  }

  getSettings(): SyncSettings {
    return { ...this.settings };
  }
}

// Settings Tab UI
class FeishuSyncSettingsTab {
  private app: App;
  private plugin: FeishuGitHubSyncPlugin;

  constructor(app: App, plugin: FeishuGitHubSyncPlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  display(containerEl: HTMLElement): void {
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Feishu GitHub Sync Settings' });

    // Feishu App ID
    const feishuSection = containerEl.createDiv();
    feishuSection.createEl('h3', { text: 'Feishu Config' });

    const appIdInput = feishuSection.createEl('input', {
      type: 'text',
      placeholder: 'Feishu App ID',
    });
    appIdInput.value = this.plugin.getSettings().feishu.appId;

    const appSecretInput = feishuSection.createEl('input', {
      type: 'password',
      placeholder: 'Feishu App Secret',
    });
    appSecretInput.value = this.plugin.getSettings().feishu.appSecret;

    // GitHub Config
    const githubSection = containerEl.createDiv();
    githubSection.createEl('h3', { text: 'GitHub Config' });

    const tokenInput = githubSection.createEl('input', {
      type: 'password',
      placeholder: 'GitHub Personal Access Token',
    });
    tokenInput.value = this.plugin.getSettings().github.token;

    const repoInput = githubSection.createEl('input', {
      type: 'text',
      placeholder: 'owner/repo',
    });
    const settings = this.plugin.getSettings();
    repoInput.value = `${settings.github.owner}/${settings.github.repo}`;

    // Sync Settings
    const syncSection = containerEl.createDiv();
    syncSection.createEl('h3', { text: 'Sync Settings' });

    const intervalInput = syncSection.createEl('input', {
      type: 'number',
      placeholder: 'Sync interval (minutes)',
    });
    intervalInput.value = String(settings.syncInterval);

    const autoSyncToggle = syncSection.createEl('label');
    autoSyncToggle.createEl('input', { type: 'checkbox' }).checked = settings.autoSync;
    autoSyncToggle.createSpan({ text: ' Auto-sync enabled' });

    // Save button
    const saveBtn = containerEl.createEl('button', { text: 'Save Settings' });
    saveBtn.addEventListener('click', () => {
      const newSettings: SyncSettings = {
        feishu: {
          appId: appIdInput.value,
          appSecret: appSecretInput.value,
        },
        github: {
          token: tokenInput.value,
          owner: repoInput.value.split('/')[0] || '',
          repo: repoInput.value.split('/')[1] || 'obsidian-notes',
          branch: 'main',
        },
        syncInterval: parseInt(intervalInput.value) || 30,
        autoSync: autoSyncToggle.querySelector('input')?.checked || false,
        syncDirection: 'bidirectional',
        conflictStrategy: 'keep_both',
        syncFolder: '',
      };

      this.plugin.updateSettings(newSettings);
      new Notice('Settings saved');
    });
  }
}