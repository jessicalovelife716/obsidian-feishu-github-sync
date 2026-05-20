import git from 'isomorphic-git';
import { GitHubConfig, VaultFS } from '../types';
import { VaultAdapter } from './VaultAdapter';

export class GitHubService {
  private config: GitHubConfig;
  private fs: VaultFS;
  private dir: string;
  private _initialized = false;

  constructor(config: GitHubConfig, vaultPath: string, vaultAdapter: VaultAdapter) {
    this.config = config;
    this.dir = vaultPath;
    this.fs = vaultAdapter.getFS();
  }

  // ---- Auth helper ----

  private getAuthUser(): { username: string; password: string } {
    return {
      username: this.config.owner,
      password: this.config.token,
    };
  }

  // ---- Init ----

  private async ensureInit(): Promise<void> {
    if (this._initialized) return;

    // Check if .git exists
    const hasGitDir = await git.findRoot({ fs: this.fs, filepath: this.dir }).catch(() => null);

    if (!hasGitDir) {
      // Init new repo
      await git.init({ fs: this.fs, dir: this.dir });
    }

    this._initialized = true;
  }

  // ---- Status ----

  async getStatus(): Promise<{ files: { path: string; status: string }[] }> {
    await this.ensureInit();
    // Check for the remote first
    const remotes = await git.listRemotes({ fs: this.fs, dir: this.dir });
    const hasRemote = remotes.some(r => r.remote === 'origin');

    if (!hasRemote && this.config.token && this.config.owner && this.config.repo) {
      await git.addRemote({
        fs: this.fs,
        dir: this.dir,
        remote: 'origin',
        url: `https://github.com/${this.config.owner}/${this.config.repo}.git`,
      });
    }

    const statusMatrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
    const files = statusMatrix.map(([path, headStatus, workDirStatus]) => ({
      path,
      status: this.formatStatus(headStatus, workDirStatus),
    }));

    return { files };
  }

  private formatStatus(headStatus: number, workDirStatus: number): string {
    if (headStatus === 0 && workDirStatus !== 0) return 'added';
    if (headStatus !== 0 && workDirStatus === 0) return 'deleted';
    if (headStatus !== workDirStatus) return 'modified';
    return 'unchanged';
  }

  // ---- Clone (lazy) ----

  async ensureCloneOrPull(): Promise<boolean> {
    await this.ensureInit();

    const hasCommits = await git.log({ fs: this.fs, dir: this.dir, depth: 1 }).then(l => l.length > 0).catch(() => false);

    if (!hasCommits && this.config.owner && this.config.repo) {
      // Try clone
      try {
        await git.clone({
          fs: this.fs,
          dir: this.dir,
          url: `https://github.com/${this.config.owner}/${this.config.repo}.git`,
          singleBranch: true,
          depth: 1,
          onAuth: () => this.getAuthUser(),
        });
        return true;
      } catch (e: any) {
        // Clone failed — might be empty repo, that's fine
        if (!e.message?.includes('Empty') && !e.message?.includes('404')) {
          throw e;
        }
      }
    }
    return false;
  }

  // ---- Pull ----

  async pull(): Promise<void> {
    await this.ensureInit();

    if (!this.config.owner || !this.config.repo) return;

    try {
      await git.pull({
        fs: this.fs,
        dir: this.dir,
        ref: this.config.branch,
        singleBranch: true,
        onAuth: () => this.getAuthUser(),
      });
    } catch (e: any) {
      // Silently ignore if no upstream yet
      if (e.message?.includes('Remote URL not found') ||
          e.message?.includes('No commits') ||
          e.message?.includes('remote')?.toLowerCase()) {
        return;
      }
      throw e;
    }
  }

  // ---- Commit ----

  async commit(message: string): Promise<boolean> {
    await this.ensureInit();

    // Stage all changes
    const statusMatrix = await git.statusMatrix({ fs: this.fs, dir: this.dir });
    let hasChanges = false;

    for (const [filepath, head, workdir] of statusMatrix) {
      if (head !== workdir) {
        hasChanges = true;
        // Stage the file
        if (workdir === 0) {
          // Deleted
          await git.remove({ fs: this.fs, dir: this.dir, filepath });
        } else {
          // Added/modified
          await git.add({ fs: this.fs, dir: this.dir, filepath });
        }
      }
    }

    if (!hasChanges) return false;

    await git.commit({
      fs: this.fs,
      dir: this.dir,
      message,
      author: { name: 'Feishu GitHub Sync Plugin', email: 'plugin@obsidian.feishu-sync' },
    });

    return true;
  }

  // ---- Push ----

  async push(): Promise<void> {
    await this.ensureInit();

    if (!this.config.owner || !this.config.repo || !this.config.token) {
      throw new Error('GitHub not configured: missing owner, repo, or token');
    }

    await git.push({
      fs: this.fs,
      dir: this.dir,
      remote: 'origin',
      ref: this.config.branch,
      onAuth: () => this.getAuthUser(),
    });
  }

  // ---- Sync (pull + commit + push) ----

  async sync(): Promise<{ hasChanges: boolean; message: string }> {
    if (!this.config.owner || !this.config.repo || !this.config.token) {
      return { hasChanges: false, message: 'GitHub not configured' };
    }

    await this.ensureCloneOrPull();
    await this.pull();

    const committed = await this.commit(`Sync: ${new Date().toISOString()}`);

    if (committed) {
      await this.push();
    }

    return {
      hasChanges: committed,
      message: committed ? 'Synced with GitHub' : 'No changes to sync',
    };
  }

  // ---- File helpers ----

  async getFileContent(path: string): Promise<string | null> {
    try {
      const blob = await git.readBlob({
        fs: this.fs,
        dir: this.dir,
        filepath: path,
        ref: this.config.branch,
      });
      return new TextDecoder().decode(blob.blob);
    } catch {
      return null;
    }
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      await git.readBlob({
        fs: this.fs,
        dir: this.dir,
        filepath: path,
        ref: this.config.branch,
      });
      return true;
    } catch {
      return false;
    }
  }

  async deleteFile(path: string): Promise<void> {
    await git.remove({ fs: this.fs, dir: this.dir, filepath: path });
  }

  async getLastModified(path: string): Promise<Date | null> {
    try {
      const log = await git.log({
        fs: this.fs,
        dir: this.dir,
        filepath: path,
        depth: 1,
      });
      if (log.length > 0) {
        return new Date(log[0].commit.author.timestamp * 1000);
      }
    } catch {
      // ignore
    }
    return null;
  }
}
