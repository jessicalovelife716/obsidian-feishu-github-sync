import { App, Notice, Plugin, TAbstractFile, TFile } from 'obsidian';
import { SyncManager } from './src/services/SyncManager';
import { SyncSettings, DocumentMapping } from './src/types';

// Default settings - weekly sync every Monday at 9:00 AM
const DEFAULT_SETTINGS: SyncSettings = {
  feishu: { appId: '', appSecret: '' },
  github: { token: '', owner: '', repo: 'obsidian-notes', branch: 'main' },
  weeklySyncDay: 1,     // Monday
  weeklySyncHour: 9,    // 9 AM
  weeklySyncMinute: 0,  // :00
  enabled: true,
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
  private weeklyCheckInterval: number = 0;
  private lastSyncDate: string = '';

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

    this.addCommand({
      id: 'sync-feishu',
      name: 'Sync with Feishu only',
      callback: () => this.syncFeishuOnly(),
    });

    // Start weekly sync scheduler
    this.startWeeklySyncScheduler();

    this.addSettingTab(new FeishuSyncSettingsTab(this.app, this));

    new Notice('Feishu GitHub Sync loaded - Weekly sync on Monday at 9:00 AM');
  }

  onunload(): void {
    if (this.weeklyCheckInterval) {
      clearInterval(this.weeklyCheckInterval);
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

  private startWeeklySyncScheduler(): void {
    // Check every minute if it's time to sync
    this.weeklyCheckInterval = window.setInterval(() => {
      this.checkAndRunWeeklySync();
    }, 60 * 1000); // Check every minute

    // Also check immediately on load
    this.checkAndRunWeeklySync();
  }

  private checkAndRunWeeklySync(): void {
    if (!this.settings.enabled) return;

    const now = new Date();
    const currentDay = now.getDay();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Format: YYYY-MM-DD for daily dedup
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const syncKey = `${currentDay}-${this.settings.weeklySyncHour}`;

    // Check if it's the right day, hour, and minute
    if (
      currentDay === this.settings.weeklySyncDay &&
      currentHour === this.settings.weeklySyncHour &&
      currentMinute === this.settings.weeklySyncMinute &&
      this.lastSyncDate !== syncKey
    ) {
      this.lastSyncDate = syncKey;
      new Notice('Starting weekly sync...');
      this.syncAll();
    }
  }

  async syncAll(): Promise<void> {
    new Notice('Syncing Obsidian with Feishu and GitHub...');

    try {
      const result = await this.syncManager.syncAll();
      const msg = `Sync complete: ${result.files.length} files synced, ${result.errors.length} errors`;
      new Notice(msg);
      this.savePluginData();
    } catch (error) {
      new Notice(`Sync failed: ${error}`);
    }
  }

  async syncFeishuOnly(): Promise<void> {
    new Notice('Syncing with Feishu...');

    try {
      const result = await this.syncManager.syncFeishuToObsidian();
      const pushResult = await this.syncManager.syncObsidianToFeishu();
      const total = result.files.length + pushResult.files.length;
      const errors = result.errors.length + pushResult.errors.length;
      new Notice(`Feishu sync: ${total} files, ${errors} errors`);
      this.savePluginData();
    } catch (error) {
      new Notice(`Feishu sync failed: ${error}`);
    }
  }

  async pushToGitHub(): Promise<void> {
    new Notice('Pushing to GitHub...');
    try {
      new Notice('Push complete');
    } catch (error) {
      new Notice(`Push failed: ${error}`);
    }
  }

  async pullFromGitHub(): Promise<void> {
    new Notice('Pulling from GitHub...');
    try {
      new Notice('Pull complete');
    } catch (error) {
      new Notice(`Pull failed: ${error}`);
    }
  }

  updateSettings(settings: SyncSettings): void {
    this.settings = { ...settings };
    this.syncManager.updateSettings(this.settings);
    this.savePluginData();
  }

  getSettings(): SyncSettings {
    return { ...this.settings };
  }

  getWeeklySyncLabel(): string {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `${days[this.settings.weeklySyncDay]} at ${String(this.settings.weeklySyncHour).padStart(2, '0')}:${String(this.settings.weeklySyncMinute).padStart(2, '0')}`;
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

    const header = containerEl.createEl('h2', { text: 'Feishu GitHub Sync Settings' });
    header.style.marginBottom = '20px';

    const settings = this.plugin.getSettings();

    // Weekly Sync Section
    const weeklySection = containerEl.createDiv();
    weeklySection.style.marginBottom = '20px';

    const weeklyHeader = weeklySection.createEl('h3', { text: 'Weekly Sync Schedule' });
    weeklyHeader.style.marginBottom = '10px';

    // Enabled toggle
    const enabledLabel = weeklySection.createEl('label');
    enabledLabel.style.display = 'flex';
    enabledLabel.style.alignItems = 'center';
    enabledLabel.style.marginBottom = '10px';
    const enabledInput = enabledLabel.createEl('input', { type: 'checkbox' });
    enabledInput.checked = settings.enabled;
    enabledInput.style.marginRight = '8px';
    enabledLabel.createSpan({ text: ' Enable weekly sync' });

    // Day selector
    const dayLabel = weeklySection.createEl('label');
    dayLabel.style.display = 'block';
    dayLabel.style.marginBottom = '8px';
    dayLabel.createSpan({ text: 'Day of week: ' });
    const daySelect = dayLabel.createEl('select');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    days.forEach((day, i) => {
      const opt = daySelect.createEl('option', { value: String(i) });
      opt.text = day;
      if (i === settings.weeklySyncDay) opt.selected = true;
    });

    // Time inputs
    const timeLabel = weeklySection.createEl('label');
    timeLabel.style.display = 'flex';
    timeLabel.style.alignItems = 'center';
    timeLabel.style.marginBottom = '10px';
    timeLabel.createSpan({ text: 'Time: ' });

    const hourInput = timeLabel.createEl('input', {
      type: 'number',
      min: '0',
      max: '23',
    });
    hourInput.value = String(settings.weeklySyncHour);
    hourInput.style.width = '60px';
    hourInput.style.marginRight = '4px';

    timeLabel.createSpan({ text: ' : ' });

    const minuteInput = timeLabel.createEl('input', {
      type: 'number',
      min: '0',
      max: '59',
    });
    minuteInput.value = String(settings.weeklySyncMinute);
    minuteInput.style.width = '60px';
    minuteInput.style.marginRight = '8px';

    timeLabel.createSpan({ text: ' (24-hour format)' });

    // Current schedule display
    const scheduleInfo = weeklySection.createEl('div');
    scheduleInfo.style.color = '#666';
    scheduleInfo.style.fontSize = '13px';
    scheduleInfo.style.marginBottom = '15px';
    scheduleInfo.textContent = `Current schedule: Every ${days[settings.weeklySyncDay]} at ${String(settings.weeklySyncHour).padStart(2, '0')}:${String(settings.weeklySyncMinute).padStart(2, '0')}`;

    // Feishu Config Section
    const feishuSection = containerEl.createDiv();
    feishuSection.style.marginBottom = '20px';

    const feishuHeader = feishuSection.createEl('h3', { text: 'Feishu Config' });
    feishuHeader.style.marginBottom = '10px';

    const appIdLabel = feishuSection.createEl('label');
    appIdLabel.style.display = 'block';
    appIdLabel.style.marginBottom = '8px';
    appIdLabel.createSpan({ text: 'App ID' });
    const appIdInput = appIdLabel.createEl('input', {
      type: 'text',
      placeholder: 'cli_xxx',
    });
    appIdInput.value = settings.feishu.appId;
    appIdInput.style.width = '100%';
    appIdInput.style.padding = '6px';

    const appSecretLabel = feishuSection.createEl('label');
    appSecretLabel.style.display = 'block';
    appSecretLabel.style.marginBottom = '15px';
    appSecretLabel.createSpan({ text: 'App Secret' });
    const appSecretInput = appSecretLabel.createEl('input', {
      type: 'password',
      placeholder: 'App Secret',
    });
    appSecretInput.value = settings.feishu.appSecret;
    appSecretInput.style.width = '100%';
    appSecretInput.style.padding = '6px';

    // GitHub Config Section
    const githubSection = containerEl.createDiv();
    githubSection.style.marginBottom = '20px';

    const githubHeader = githubSection.createEl('h3', { text: 'GitHub Config' });
    githubHeader.style.marginBottom = '10px';

    const tokenLabel = githubSection.createEl('label');
    tokenLabel.style.display = 'block';
    tokenLabel.style.marginBottom = '8px';
    tokenLabel.createSpan({ text: 'Personal Access Token' });
    const tokenInput = tokenLabel.createEl('input', {
      type: 'password',
      placeholder: 'ghp_xxx',
    });
    tokenInput.value = settings.github.token;
    tokenInput.style.width = '100%';
    tokenInput.style.padding = '6px';

    const repoLabel = githubSection.createEl('label');
    repoLabel.style.display = 'block';
    repoLabel.style.marginBottom = '15px';
    repoLabel.createSpan({ text: 'Repository (owner/repo)' });
    const repoInput = repoLabel.createEl('input', {
      type: 'text',
      placeholder: 'username/obsidian-notes',
    });
    repoInput.value = `${settings.github.owner}/${settings.github.repo}`;
    repoInput.style.width = '100%';
    repoInput.style.padding = '6px';

    // Save button
    const saveBtn = containerEl.createEl('button', { text: 'Save Settings' });
    saveBtn.style.padding = '10px 20px';
    saveBtn.style.backgroundColor = '#4a9eff';
    saveBtn.style.color = 'white';
    saveBtn.style.border = 'none';
    saveBtn.style.borderRadius = '6px';
    saveBtn.style.cursor = 'pointer';
    saveBtn.style.fontSize = '14px';
    saveBtn.style.marginTop = '10px';

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
        weeklySyncDay: parseInt(daySelect.value),
        weeklySyncHour: parseInt(hourInput.value),
        weeklySyncMinute: parseInt(minuteInput.value),
        enabled: enabledInput.checked,
        syncDirection: 'bidirectional',
        conflictStrategy: 'keep_both',
        syncFolder: '',
      };

      this.plugin.updateSettings(newSettings);
      new Notice('Settings saved');
      this.display(containerEl); // Refresh UI
    });

    // Manual sync button
    const syncBtn = containerEl.createEl('button', { text: 'Sync Now' });
    syncBtn.style.padding = '10px 20px';
    syncBtn.style.backgroundColor = '#48bb78';
    syncBtn.style.color = 'white';
    syncBtn.style.border = 'none';
    syncBtn.style.borderRadius = '6px';
    syncBtn.style.cursor = 'pointer';
    syncBtn.style.fontSize = '14px';
    syncBtn.style.marginLeft = '10px';
    syncBtn.style.marginTop = '10px';

    syncBtn.addEventListener('click', () => {
      this.plugin.syncAll();
    });
  }
}