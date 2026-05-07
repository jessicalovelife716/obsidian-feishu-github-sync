import simpleGit, { SimpleGit } from 'simple-git';
import { GitHubConfig } from '../types';

export class GitHubService {
  private git: SimpleGit;
  private config: GitHubConfig;
  private vaultPath: string;

  constructor(config: GitHubConfig, vaultPath: string) {
    this.config = config;
    this.vaultPath = vaultPath;
    this.git = simpleGit(vaultPath);

    this.git.addConfig('user.email', 'plugin@obsidian.feishu-sync');
    this.git.addConfig('user.name', 'Feishu GitHub Sync Plugin');
  }

  private async ensureAuth(): Promise<void> {
    // Configure remote with token
    const remoteUrl = `https://x-access-token:${this.config.token}@github.com/${this.config.owner}/${this.config.repo}.git`;
    try {
      await this.git.listRemote();
    } catch {
      // Remote not configured, add it
      await this.git.addRemote('origin', remoteUrl);
    }
  }

  async pull(): Promise<void> {
    await this.ensureAuth();
    await this.git.pull('origin', this.config.branch, { '--rebase': 'false' });
  }

  async push(): Promise<void> {
    await this.ensureAuth();
    const remoteUrl = `https://x-access-token:${this.config.token}@github.com/${this.config.owner}/${this.config.repo}.git`;
    await this.git.remote(['set-url', 'origin', remoteUrl]);
    await this.git.push('origin', this.config.branch, { '--set-upstream': null });
  }

  async commit(message: string): Promise<boolean> {
    const status = await this.git.status();
    if (status.files.length === 0) {
      return false; // Nothing to commit
    }

    await this.git.add('.');
    await this.git.commit(message);
    return true;
  }

  async sync(): Promise<{ hasChanges: boolean; message: string }> {
    await this.pull();

    const status = await this.git.status();
    const hasLocalChanges = status.files.length > 0;

    if (hasLocalChanges) {
      await this.commit(`Sync: ${new Date().toISOString()}`);
    }

    await this.push();

    return {
      hasChanges: hasLocalChanges,
      message: hasLocalChanges ? 'Synced with GitHub' : 'No changes to sync',
    };
  }

  async getFileContent(path: string): Promise<string | null> {
    try {
      return await this.git.raw(['show', `${this.config.branch}:${path}`]);
    } catch {
      return null;
    }
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await this.git.raw(['ls-files', '--error-unmatch', path]);
      return true;
    } catch {
      return false;
    }
  }

  async getLastModified(path: string): Promise<Date | null> {
    try {
      const log = await this.git.log({ file: path, maxCount: 1 });
      if (log.latest) {
        return new Date(log.latest.date);
      }
    } catch {
      // File not in git history
    }
    return null;
  }

  async deleteFile(path: string): Promise<void> {
    await this.git.rm(path);
  }
}