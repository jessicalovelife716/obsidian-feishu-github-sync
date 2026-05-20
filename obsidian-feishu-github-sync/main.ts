import { App, Plugin, PluginSettingTab, TFile, Notice } from 'obsidian';
import { SyncManager } from './src/services/SyncManager';
import { FeishuService } from './src/services/FeishuService';
import { GitHubService } from './src/services/GitHubService';
import { VaultAdapter } from './src/services/VaultAdapter';
import {
  SyncSettings,
  DocumentMapping,
  SyncStatus,
  SyncMode,
  ConflictStrategy,
} from './src/types';
import { i18n } from './src/i18n';

// ==================== Encryption (simple XOR + Base64 for local obfuscation) ====================

class CredentialStore {
  private static KEY = 'feishu-github-sync-cred';

  static encrypt(plaintext: string): string {
    if (!plaintext) return '';
    const key = this.KEY;
    let result = '';
    for (let i = 0; i < plaintext.length; i++) {
      result += String.fromCharCode(
        plaintext.charCodeAt(i) ^ key.charCodeAt(i % key.length),
      );
    }
    return btoa(encodeURIComponent(result));
  }

  static decrypt(ciphertext: string): string {
    if (!ciphertext) return '';
    try {
      const decoded = decodeURIComponent(atob(ciphertext));
      const key = this.KEY;
      let result = '';
      for (let i = 0; i < decoded.length; i++) {
        result += String.fromCharCode(
          decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length),
        );
      }
      return result;
    } catch {
      return '';
    }
  }

  static encryptSettings(settings: SyncSettings): SyncSettings {
    return {
      ...settings,
      feishu: {
        ...settings.feishu,
        appSecret: this.encrypt(settings.feishu.appSecret),
      },
      github: {
        ...settings.github,
        token: this.encrypt(settings.github.token),
      },
    };
  }

  static decryptSettings(settings: SyncSettings): SyncSettings {
    return {
      ...settings,
      feishu: {
        ...settings.feishu,
        appSecret: this.decrypt(settings.feishu.appSecret),
      },
      github: {
        ...settings.github,
        token: this.decrypt(settings.github.token),
      },
    };
  }
}

// ==================== SVG Status Icons ====================

const STATUS_ICONS = {
  idle: `<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="3" fill="#4caf50"/></svg>`,
  syncing: `<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="3" fill="#ff9800"/></svg>`,
  error: `<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="3" fill="#f44336"/></svg>`,
  paused: `<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="5.5" y="5" width="1.5" height="6" rx="1" fill="#ff9800"/><rect x="9" y="5" width="1.5" height="6" rx="1" fill="#ff9800"/></svg>`,
};

// ==================== Default Settings ====================

const DEFAULT_SETTINGS: SyncSettings = {
  feishu: { appId: '', appSecret: '' },
  github: { token: '', owner: '', repo: '', branch: 'main' },
  enabled: true,
  fileWatcherEnabled: true,
  syncMode: 'off',
  intervalMinutes: 30,
  cronExpression: '0 9 * * 1',
  syncOnStartup: false,
  syncFolder: '',
  attachmentFolder: 'attachments/feishu',
  conflictStrategy: 'keep_both',
  syncDirection: 'bidirectional',
  showStatusBar: true,
  weeklySyncDay: 1,
  weeklySyncHour: 9,
  weeklySyncMinute: 0,
};

interface PluginData {
  settings: SyncSettings;
  mappings: DocumentMapping[];
  lastSynced: number;
}

// ==================== Main Plugin Class ====================

export default class FeishuGitHubSyncPlugin extends Plugin {
  private settings: SyncSettings = { ...DEFAULT_SETTINGS };
  private mappings: DocumentMapping[] = [];
  private syncManager!: SyncManager;
  private githubService!: GitHubService;
  private feishuService!: FeishuService;
  private vaultAdapter!: VaultAdapter;

  // Status bar
  private statusBarItem: HTMLElement | null = null;
  private statusTooltip: HTMLElement | null = null;

  // Scheduler
  private schedulerTimer: number | null = null;
  private paused = false;

  // Startup sync guard
  private startupDone = false;

  // ==================== Plugin Lifecycle ====================

  async onload(): Promise<void> {
    await this.loadPluginData();

    // Init adapter & services
    this.vaultAdapter = new VaultAdapter(this.app.vault.adapter);
    this.feishuService = new FeishuService(this.settings.feishu);
    this.githubService = new GitHubService(
      this.settings.github,
      this.app.vault.getRoot().path,
      this.vaultAdapter,
    );
    this.syncManager = new SyncManager(
      this.app,
      this.settings,
      this.mappings,
      this.feishuService,
      this.githubService,
      this.vaultAdapter,
    );

    // Wire up status callback
    this.syncManager.onStatusChange = (status, message) => {
      this.updateStatusBar(status, message);
    };

    // Register commands
    this.registerCommands();

    // Register file watcher
    this.registerFileWatcher();

    // Register settings tab
    this.addSettingTab(new FeishuSyncSettingsTab(this.app, this));

    // Init status bar
    if (this.settings.showStatusBar) {
      this.initStatusBar();
    }

    // Start scheduler
    this.startScheduler();

    // Startup sync
    if (this.settings.syncOnStartup && this.settings.enabled) {
      this.delayedStartupSync();
    }
  }

  onunload(): void {
    this.stopScheduler();
    this.savePluginData();
    if (this.statusBarItem) {
      this.statusBarItem.remove();
    }
  }

  private delayedStartupSync(): void {
    setTimeout(() => {
      if (!this.startupDone) {
        this.startupDone = true;
        this.syncManager.syncAll().catch(() => {});
      }
    }, 5000); // 5s delay after startup
  }

  // ==================== Commands ====================

  private registerCommands(): void {
    this.addCommand({
      id: 'sync-all',
      name: i18n.t('cmd.syncAll'),
      callback: () => this.syncAll(),
    });

    this.addCommand({
      id: 'push-to-github',
      name: i18n.t('cmd.pushToGithub'),
      callback: () => this.pushToGitHub(),
    });

    this.addCommand({
      id: 'pull-from-github',
      name: i18n.t('cmd.pullFromGithub'),
      callback: () => this.pullFromGitHub(),
    });

    this.addCommand({
      id: 'sync-current-file',
      name: i18n.t('cmd.syncCurrentFile'),
      callback: () => this.syncCurrentFile(),
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return false;
        if (!checking) this.syncCurrentFile();
        return true;
      },
    });

    this.addCommand({
      id: 'toggle-pause',
      name: i18n.t('cmd.togglePause'),
      callback: () => this.togglePause(),
    });
  }

  // ==================== File Watcher ====================

  private registerFileWatcher(): void {
    this.registerEvent(
      this.app.vault.on('modify', (file: TFile) => {
        if (file.extension === 'md') {
          this.syncManager.onFileModified(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on('delete', (file: TFile) => {
        this.syncManager.onFileDeleted(file.path);
      }),
    );

    // Handle rename properly (not as delete+create)
    this.registerEvent(
      this.app.vault.on('rename', (file: TFile, oldPath: string) => {
        this.syncManager.onFileRenamed(file, oldPath);
      }),
    );
  }

  // ==================== Status Bar ====================

  private initStatusBar(): void {
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.innerHTML = STATUS_ICONS.idle;
    this.statusBarItem.style.cursor = 'pointer';
    this.statusBarItem.style.display = 'flex';
    this.statusBarItem.style.alignItems = 'center';
    this.statusBarItem.style.gap = '4px';
    this.statusBarItem.title = `Feishu GitHub Sync — ${i18n.t('status.idle')}`;

    // Click to show next sync time
    this.statusBarItem.addEventListener('click', () => {
      const status = this.syncManager.status;
      if (status === 'error') {
        // Allow clicking to re-sync
        this.syncAll();
      }
    });

    // Hover tooltip
    this.statusBarItem.addEventListener('mouseenter', () => {
      this.showTooltip();
    });
    this.statusBarItem.addEventListener('mouseleave', () => {
      this.hideTooltip();
    });
  }

  private updateStatusBar(status: SyncStatus, message?: string): void {
    if (!this.statusBarItem) return;

    const iconMap: Record<SyncStatus, string> = {
      idle: STATUS_ICONS.idle,
      syncing: STATUS_ICONS.syncing,
      error: STATUS_ICONS.error,
      paused: STATUS_ICONS.paused,
    };

    this.statusBarItem.innerHTML = iconMap[status] || STATUS_ICONS.idle;

    const labelMap: Record<SyncStatus, string> = {
      idle: i18n.t('status.idle'),
      syncing: i18n.t('status.syncing'),
      error: message ? `${i18n.t('status.error')}: ${message}` : i18n.t('status.error'),
      paused: i18n.t('status.paused'),
    };

    this.statusBarItem.title = `Feishu GitHub Sync — ${labelMap[status]}`;
  }

  private showTooltip(): void {
    if (!this.statusBarItem) return;
    const nextSync = this.getNextSyncTime();
    // Obsidian doesn't support custom tooltips easily, use native title
    if (nextSync) {
      this.statusBarItem.title = `Feishu GitHub Sync\nNext sync: ${nextSync}`;
    }
  }

  private hideTooltip(): void {
    // title attribute hover is native browser behavior, nothing to do
  }

  private getNextSyncTime(): string | null {
    if (this.paused || !this.settings.enabled || this.settings.syncMode === 'off') {
      return null;
    }

    if (this.settings.syncMode === 'interval') {
      return `every ${this.settings.intervalMinutes} min`;
    }

    if (this.settings.syncMode === 'cron') {
      return this.settings.cronExpression || 'weekly schedule';
    }

    return null;
  }

  // ==================== Scheduler ====================

  private startScheduler(): void {
    this.stopScheduler();

    if (!this.settings.enabled || this.paused) return;

    if (this.settings.syncMode === 'interval') {
      const ms = this.settings.intervalMinutes * 60 * 1000;
      this.schedulerTimer = window.setInterval(() => {
        if (!this.paused && this.settings.enabled) {
          this.syncManager.syncAll().catch(() => {});
        }
      }, ms);
    } else if (this.settings.syncMode === 'cron') {
      // Check every minute for cron match
      this.schedulerTimer = window.setInterval(() => {
        if (!this.paused && this.settings.enabled) {
          this.checkCronMatch();
        }
      }, 60 * 1000);

      // Also check immediately
      this.checkCronMatch();
    }
  }

  private stopScheduler(): void {
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private checkCronMatch(): void {
    const cron = this.settings.cronExpression || `0 ${this.settings.weeklySyncHour} * * ${this.settings.weeklySyncDay}`;
    const parts = cron.trim().split(/\s+/);
    if (parts.length < 5) return;

    const now = new Date();
    const minute = now.getMinutes();
    const hour = now.getHours();
    const dayOfMonth = now.getDate();
    const month = now.getMonth() + 1;
    const dayOfWeek = now.getDay();

    if (
      this.cronMatch(parts[0], minute) &&
      this.cronMatch(parts[1], hour) &&
      this.cronMatch(parts[2], dayOfMonth) &&
      this.cronMatch(parts[3], month) &&
      this.cronMatch(parts[4], dayOfWeek)
    ) {
      this.syncManager.syncAll().catch(() => {});
    }
  }

  private cronMatch(pattern: string, value: number): boolean {
    if (pattern === '*') return true;
    if (pattern.startsWith('*/')) {
      const step = parseInt(pattern.slice(2));
      return step > 0 && value % step === 0;
    }
    // Handle comma-separated values
    return pattern.split(',').some((p) => parseInt(p) === value);
  }

  // ==================== Public Sync Methods ====================

  async syncAll(): Promise<void> {
    if (!this.settings.feishu.appId || !this.settings.feishu.appSecret) {
      new Notice(i18n.t('notify.notConfiguredFeishu'));
      return;
    }

    try {
      const result = await this.syncManager.syncAll();
      const summary = `${i18n.t('notify.syncComplete')}: ${result.files.length} files, ${result.errors.length} ${i18n.t('notify.syncErrors')}`;
      if (result.errors.length > 0) {
        new Notice(`⚠️ ${summary}`);
      } else {
        new Notice(`✅ ${summary}`);
      }
      this.savePluginData();
    } catch (error) {
      new Notice(`❌ ${i18n.t('notify.syncFailed')}: ${error}`);
    }
  }

  async pushToGitHub(): Promise<void> {
    if (!this.settings.github.token || !this.settings.github.owner) {
      new Notice(i18n.t('notify.notConfiguredGithub'));
      return;
    }

    try {
      const result = await this.syncManager.pushToGitHub();
      if (result.errors.length > 0) {
        new Notice(`⚠️ ${i18n.t('notify.pushFailed')}: ${result.errors.join(', ')}`);
      } else {
        new Notice(`✅ ${i18n.t('notify.pushComplete')}`);
      }
    } catch (error) {
      new Notice(`❌ ${i18n.t('notify.pushFailed')}: ${error}`);
    }
  }

  async pullFromGitHub(): Promise<void> {
    if (!this.settings.github.token || !this.settings.github.owner) {
      new Notice(i18n.t('notify.notConfiguredGithub'));
      return;
    }

    try {
      const result = await this.syncManager.pullFromGitHub();
      if (result.errors.length > 0) {
        new Notice(`⚠️ ${i18n.t('notify.pullFailed')}: ${result.errors.join(', ')}`);
      } else {
        new Notice(`✅ ${i18n.t('notify.pullComplete')}`);
      }
    } catch (error) {
      new Notice(`❌ ${i18n.t('notify.pullFailed')}: ${error}`);
    }
  }

  async syncCurrentFile(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice(i18n.t('notify.noActiveFile'));
      return;
    }

    try {
      await this.syncManager.syncSingleFile(activeFile);
      new Notice(`✅ ${i18n.t('notify.fileSynced')}: ${activeFile.basename}`);
    } catch (error) {
      new Notice(`❌ ${i18n.t('notify.syncFailed')}: ${error}`);
    }
  }

  togglePause(): void {
    this.paused = !this.paused;

    if (this.paused) {
      this.stopScheduler();
      this.syncManager['setStatus']('paused', i18n.t('status.paused'));
      new Notice(i18n.t('notify.syncPaused'));
    } else {
      this.startScheduler();
      new Notice(i18n.t('notify.syncResumed'));
    }
  }

  // ==================== Settings Access ====================

  updateSettings(settings: SyncSettings): void {
    this.settings = { ...settings };
    this.syncManager.updateSettings(this.settings);

    // Re-init services with potentially new credentials
    this.feishuService = new FeishuService(settings.feishu);
    this.githubService = new GitHubService(
      settings.github,
      this.app.vault.getRoot().path,
      this.vaultAdapter,
    );
    this.syncManager = new SyncManager(
      this.app,
      this.settings,
      this.mappings,
      this.feishuService,
      this.githubService,
      this.vaultAdapter,
    );

    // Re-wire callbacks
    this.syncManager.onStatusChange = (status, message) => {
      this.updateStatusBar(status, message);
    };

    // Restart scheduler
    this.startScheduler();

    // Toggle status bar visibility
    if (settings.showStatusBar && !this.statusBarItem) {
      this.initStatusBar();
    } else if (!settings.showStatusBar && this.statusBarItem) {
      this.statusBarItem.remove();
      this.statusBarItem = null;
    }

    this.savePluginData();
  }

  getSettings(): SyncSettings {
    return { ...this.settings };
  }

  getMappings(): DocumentMapping[] {
    return this.syncManager.getMappings();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  // ==================== Persistence ====================

  private async loadPluginData(): Promise<void> {
    const data: PluginData = await this.loadData();
    if (data?.settings) {
      // Decrypt credentials
      const merged = { ...DEFAULT_SETTINGS, ...data.settings };
      this.settings = CredentialStore.decryptSettings(merged);
    }
    if (data?.mappings) {
      this.mappings = data.mappings;
    }
  }

  private async savePluginData(): Promise<void> {
    // Encrypt before saving
    const encrypted = CredentialStore.encryptSettings(this.settings);
    await this.saveData({
      settings: encrypted,
      mappings: this.mappings,
      lastSynced: Date.now(),
    });
  }
}

// ==================== Settings Tab ====================

class FeishuSyncSettingsTab extends PluginSettingTab {
  private plugin: FeishuGitHubSyncPlugin;

  constructor(app: App, plugin: FeishuGitHubSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const containerEl = this.containerEl;
    containerEl.empty();

    const settings = this.plugin.getSettings();

    // ---- Header ----
    containerEl.createEl('h2', { text: 'Feishu GitHub Sync' });
    containerEl.createEl('h2', { text: 'Feishu GitHub Sync' });
    containerEl.createEl('p', {
      text: i18n.t('plugin.description'),
      attr: { style: 'color: var(--text-muted); margin-bottom: 24px;' },
    });

    // ========================
    // 1. Authentication
    // ========================
    this.renderSection(containerEl, i18n.t('settings.auth.title'), (section) => {
      this.renderTextInput(section, i18n.t('settings.auth.feishuAppId'), settings.feishu.appId, 'cli_xxx', (v) => {
        settings.feishu.appId = v;
      });
      this.renderPasswordInput(section, i18n.t('settings.auth.feishuAppSecret'), settings.feishu.appSecret, 'App Secret', (v) => {
        settings.feishu.appSecret = v;
      });

      section.createEl('hr', { attr: { style: 'margin: 12px 0;' } });

      this.renderPasswordInput(section, i18n.t('settings.auth.githubToken'), settings.github.token, 'ghp_xxx', (v) => {
        settings.github.token = v;
      });
      this.renderTextInput(section, i18n.t('settings.auth.githubRepo'), `${settings.github.owner}/${settings.github.repo}`, 'owner/repo', (v) => {
        const parts = v.split('/');
        settings.github.owner = parts[0] || '';
        settings.github.repo = parts[1] || '';
      });

      // GitHub warning
      const warnDiv = section.createEl('div', {
        attr: {
          style:
            'background: var(--background-modifier-warning); color: var(--text-warning); padding: 10px; border-radius: 6px; font-size: 12px; margin-top: 8px;',
        },
      });
      warnDiv.innerHTML = i18n.t('settings.auth.securityWarning');
    });

    // ========================
    // 2. Automation & Schedule
    // ========================
    this.renderSection(containerEl, i18n.t('settings.automation.title'), (section) => {
      this.renderToggle(section, i18n.t('settings.automation.enableSync'), settings.enabled, (v) => {
        settings.enabled = v;
      });
      this.renderToggle(section, i18n.t('settings.automation.fileWatcher'), settings.fileWatcherEnabled, (v) => {
        settings.fileWatcherEnabled = v;
      });
      this.renderToggle(section, i18n.t('settings.automation.syncOnStartup'), settings.syncOnStartup, (v) => {
        settings.syncOnStartup = v;
      });

      // Sync mode dropdown
      const modeLabel = section.createEl('label');
      modeLabel.createSpan({ text: i18n.t('settings.automation.syncMode') });
      const modeSelect = modeLabel.createEl('select');
      modeSelect.style.display = 'block';
      modeSelect.style.marginTop = '4px';
      modeSelect.style.marginBottom = '8px';

      const modes: { value: SyncMode; label: string }[] = [
        { value: 'off', label: i18n.t('settings.automation.off') },
        { value: 'interval', label: i18n.t('settings.automation.interval') },
        { value: 'cron', label: i18n.t('settings.automation.cron') },
      ];

      for (const m of modes) {
        const opt = modeSelect.createEl('option', { value: m.value });
        opt.text = m.label;
        if (settings.syncMode === m.value) opt.selected = true;
      }

      // Interval input (shown only when interval mode)
      const intervalContainer = section.createEl('div');
      intervalContainer.style.display = settings.syncMode === 'interval' ? 'block' : 'none';
      this.renderNumberInput(intervalContainer, i18n.t('settings.automation.intervalMinutes'), settings.intervalMinutes, 1, 1440, (v) => {
        settings.intervalMinutes = v;
      });

      // Cron input (shown only when cron mode)
      const cronContainer = section.createEl('div');
      cronContainer.style.display = settings.syncMode === 'cron' ? 'block' : 'none';

      this.renderTextInput(cronContainer, i18n.t('settings.automation.cronExpression'), settings.cronExpression, '0 9 * * 1', (v) => {
        settings.cronExpression = v;
      });
      cronContainer.createEl('p', {
        text: i18n.t('settings.automation.cronHelp'),
        attr: { style: 'font-size: 11px; color: var(--text-faint); margin-top: 2px;' },
      });

      modeSelect.addEventListener('change', () => {
        settings.syncMode = modeSelect.value as SyncMode;
        intervalContainer.style.display = settings.syncMode === 'interval' ? 'block' : 'none';
        cronContainer.style.display = settings.syncMode === 'cron' ? 'block' : 'none';
      });
    });

    // ========================
    // 3. Scope & Strategy
    // ========================
    this.renderSection(containerEl, i18n.t('settings.scope.title'), (section) => {
      this.renderTextInput(section, i18n.t('settings.scope.syncFolder'), settings.syncFolder, 'FeishuSync/', (v) => {
        settings.syncFolder = v;
      });
      section.createEl('p', {
        text: i18n.t('settings.scope.syncFolderHelp'),
        attr: { style: 'font-size: 11px; color: var(--text-faint); margin-top: -6px; margin-bottom: 10px;' },
      });

      this.renderTextInput(section, i18n.t('settings.scope.attachmentFolder'), settings.attachmentFolder, 'attachments/feishu', (v) => {
        settings.attachmentFolder = v;
      });
      section.createEl('p', {
        text: i18n.t('settings.scope.attachmentFolderHelp'),
        attr: { style: 'font-size: 11px; color: var(--text-faint); margin-top: -6px; margin-bottom: 10px;' },
      });

      // Conflict strategy dropdown
      const conflictLabel = section.createEl('label');
      conflictLabel.createSpan({ text: i18n.t('settings.scope.conflictStrategy') });
      const conflictSelect = conflictLabel.createEl('select');
      conflictSelect.style.display = 'block';
      conflictSelect.style.marginTop = '4px';
      conflictSelect.style.marginBottom = '8px';

      const strategies: { value: ConflictStrategy; label: string }[] = [
        { value: 'keep_both', label: i18n.t('settings.scope.keepBoth') },
        { value: 'local_wins', label: i18n.t('settings.scope.localWins') },
        { value: 'remote_wins', label: i18n.t('settings.scope.remoteWins') },
      ];

      for (const s of strategies) {
        const opt = conflictSelect.createEl('option', { value: s.value });
        opt.text = s.label;
        if (settings.conflictStrategy === s.value) opt.selected = true;
      }

      conflictSelect.addEventListener('change', () => {
        settings.conflictStrategy = conflictSelect.value as ConflictStrategy;
      });

      // Status bar toggle
      this.renderToggle(section, i18n.t('settings.scope.statusBar'), settings.showStatusBar, (v) => {
        settings.showStatusBar = v;
      });
    });

    // ========================
    // Save & Action Buttons
    // ========================
    const btnContainer = containerEl.createDiv();
    btnContainer.style.display = 'flex';
    btnContainer.style.gap = '8px';
    btnContainer.style.marginTop = '20px';

    const saveBtn = btnContainer.createEl('button', { text: i18n.t('settings.buttons.save') });
    saveBtn.style.cssText = 'padding: 8px 20px; background: var(--interactive-accent); color: var(--text-on-accent); border: none; border-radius: 6px; cursor: pointer; font-size: 14px;';

    const syncBtn = btnContainer.createEl('button', { text: i18n.t('settings.buttons.syncNow') });
    syncBtn.style.cssText = 'padding: 8px 20px; background: var(--interactive-success); color: var(--text-on-accent); border: none; border-radius: 6px; cursor: pointer; font-size: 14px;';

    saveBtn.addEventListener('click', () => {
      this.plugin.updateSettings(settings);
      new Notice(i18n.t('notify.settingsSaved'));
    });

    syncBtn.addEventListener('click', () => {
      this.plugin.syncAll();
    });
  }

  // ==================== Render Helpers ====================

  private renderSection(
    container: HTMLElement,
    title: string,
    fn: (section: HTMLElement) => void,
  ): void {
    const section = container.createDiv();
    section.style.marginBottom = '24px';
    section.style.padding = '16px';
    section.style.border = '1px solid var(--background-modifier-border)';
    section.style.borderRadius = '8px';

    section.createEl('h3', {
      text: title,
      attr: { style: 'margin-top: 0; margin-bottom: 12px; font-size: 16px;' },
    });

    fn(section);
  }

  private renderToggle(
    container: HTMLElement,
    label: string,
    value: boolean,
    onChange: (v: boolean) => void,
  ): void {
    const wrapper = container.createEl('label');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.marginBottom = '8px';

    const input = wrapper.createEl('input', { type: 'checkbox' });
    input.checked = value;
    input.style.marginRight = '8px';

    wrapper.createSpan({ text: label });

    input.addEventListener('change', () => onChange(input.checked));
  }

  private renderTextInput(
    container: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    onChange: (v: string) => void,
  ): void {
    const wrapper = container.createEl('label');
    wrapper.style.display = 'block';
    wrapper.style.marginBottom = '8px';

    wrapper.createSpan({ text: label });
    const input = wrapper.createEl('input', { type: 'text', placeholder });
    input.value = value;
    input.style.display = 'block';
    input.style.width = '100%';
    input.style.padding = '6px';
    input.style.marginTop = '4px';
    input.style.boxSizing = 'border-box';

    input.addEventListener('change', () => onChange(input.value));
  }

  private renderPasswordInput(
    container: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    onChange: (v: string) => void,
  ): void {
    const wrapper = container.createEl('label');
    wrapper.style.display = 'block';
    wrapper.style.marginBottom = '8px';

    wrapper.createSpan({ text: label });
    const input = wrapper.createEl('input', { type: 'password', placeholder });
    input.value = value;
    input.style.display = 'block';
    input.style.width = '100%';
    input.style.padding = '6px';
    input.style.marginTop = '4px';
    input.style.boxSizing = 'border-box';

    input.addEventListener('change', () => onChange(input.value));
  }

  private renderNumberInput(
    container: HTMLElement,
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
  ): void {
    const wrapper = container.createEl('label');
    wrapper.style.display = 'block';
    wrapper.style.marginBottom = '8px';

    wrapper.createSpan({ text: label });
    const input = wrapper.createEl('input', { type: 'number' });
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    input.style.display = 'block';
    input.style.width = '100%';
    input.style.padding = '6px';
    input.style.marginTop = '4px';
    input.style.boxSizing = 'border-box';

    input.addEventListener('change', () => onChange(parseInt(input.value) || min));
  }
}
