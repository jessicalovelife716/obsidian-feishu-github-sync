export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface SyncSettings {
  feishu: FeishuConfig;
  github: GitHubConfig;
  // Weekly sync: day of week (0=Sunday, 1=Monday, ...), hour (0-23), minute (0-59)
  weeklySyncDay: number;    // 0-6, default 1 (Monday)
  weeklySyncHour: number;   // 0-23, default 9
  weeklySyncMinute: number; // 0-59, default 0
  enabled: boolean;         // whether weekly sync is enabled
  syncDirection: 'bidirectional' | 'obsidian-to-remote' | 'remote-to-obsidian';
  conflictStrategy: 'keep_both' | 'local_wins' | 'remote_wins';
  syncFolder: string; // folder path in vault to sync
}

export interface DocumentMapping {
  localPath: string;
  feishuDocId: string;
  githubPath: string;
  lastSynced: number;
  hash: string;
}

export interface SyncResult {
  success: boolean;
  direction: 'to-obsidian' | 'to-feishu' | 'to-github';
  files: string[];
  errors: string[];
}

export interface SyncLog {
  timestamp: number;
  action: 'create' | 'update' | 'delete';
  source: 'feishu' | 'github' | 'obsidian';
  filePath: string;
  success: boolean;
  error?: string;
}