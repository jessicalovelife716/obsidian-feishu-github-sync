// ==================== Configs ====================

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

// ==================== Sync Settings ====================

export type SyncMode = 'off' | 'interval' | 'scheduled';
export type ConflictStrategy = 'keep_both' | 'local_wins' | 'remote_wins';
export type SyncDirection = 'bidirectional' | 'obsidian-to-remote' | 'remote-to-obsidian';

export interface SyncSettings {
  // Auth
  feishu: FeishuConfig;
  github: GitHubConfig;

  // Automation & Schedule
  enabled: boolean;               // global sync toggle — master switch
  fileWatcherEnabled: boolean;    // file change listener toggle
  syncMode: SyncMode;             // off / interval / scheduled
  intervalMinutes: number;        // used when syncMode === 'interval', min 15
  scheduledDays: number[];        // used when syncMode === 'scheduled', 0=Sun…6=Sat
  scheduledTimes: string[];       // used when syncMode === 'scheduled', HH:mm[], max 3
  syncOnStartup: boolean;         // silent sync on Obsidian open

  // Scope & Strategy
  syncFolder: string;             // empty = whole vault
  attachmentFolder: string;       // local path for Feishu images
  conflictStrategy: ConflictStrategy;
  syncDirection: SyncDirection;
  showStatusBar: boolean;

  // Legacy weekly fields
  weeklySyncDay: number;
  weeklySyncHour: number;
  weeklySyncMinute: number;
}

// ==================== Document Mapping ====================

export interface DocumentMapping {
  localPath: string;
  feishuDocId: string;
  githubPath: string;
  lastSynced: number;
  hash: string;
}

// ==================== Sync Results ====================

export interface SyncResult {
  success: boolean;
  direction: 'to-obsidian' | 'to-feishu' | 'to-github' | 'bidirectional';
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

// ==================== Sync Status ====================

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'paused';

// ==================== Feishu Doc Info ====================

export interface FeishuDocInfo {
  docId: string;
  title: string;
  updatedTime: number;
}

// ==================== Feishu Block Types ====================

export enum FeishuBlockType {
  Paragraph = 1,
  Heading1 = 2,
  Heading2 = 3,
  Heading3 = 4,
  Bullet = 13,
  Ordered = 14,
  Quote = 15,
  Bold = 17,
  Italic = 18,
  Strikethrough = 19,
  InlineCode = 20,
  CodeBlock = 21,
  Table = 22,
  Image = 27,
  Divider = 29,
  Callout = 33,
}

// ==================== Vault FS Adapter Interface ====================
// Minimal interface isomorphic-git needs from a filesystem.

export interface VaultFS {
  promises: {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<{ type: 'file' | 'dir'; ctimeMillis: number; mtimeMillis: number; size: number; mode: number }>;
    lstat(path: string): Promise<{ type: 'file' | 'dir'; ctimeMillis: number; mtimeMillis: number; size: number; mode: number }>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
  };
}
