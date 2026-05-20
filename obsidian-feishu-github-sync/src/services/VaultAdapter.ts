import { VaultFS } from '../types';

/**
 * Wraps Obsidian's VaultAdapter into the filesystem interface
 * that isomorphic-git expects, enabling cross-platform git operations
 * on desktop (Windows/macOS/Linux) and mobile (iOS/Android).
 */
export class VaultAdapter {
  private vaultAdapter: any; // Obsidian's VaultAdapter (from app.vault.adapter)

  constructor(vaultAdapter: any) {
    this.vaultAdapter = vaultAdapter;
  }

  getFS(): VaultFS {
    const adapter = this.vaultAdapter;
    const self = this;

    return {
      promises: {
        async readFile(path: string): Promise<Uint8Array> {
          // Obsidian's readBinary returns ArrayBuffer
          const ab: ArrayBuffer = await adapter.readBinary(path);
          return new Uint8Array(ab);
        },

        async writeFile(path: string, data: Uint8Array): Promise<void> {
          // isomorphic-git passes Uint8Array — write as binary
          await adapter.writeBinary(path, data.buffer as ArrayBuffer);
        },

        async unlink(path: string): Promise<void> {
          await adapter.remove(path);
        },

        async readdir(path: string): Promise<string[]> {
          const listed = await adapter.list(path);
          // adapter.list returns { files: string[], folders: string[] }
          // Merge and return relative paths
          return [...listed.folders, ...listed.files];
        },

        async mkdir(path: string): Promise<void> {
          await adapter.mkdir(path);
        },

        async rmdir(path: string): Promise<void> {
          // Obsidian doesn't have rmdir — use remove (may fail if non-empty)
          try {
            await adapter.remove(path);
          } catch {
            // If remove isn't allowed on dirs, try recursive delete
            const listed = await adapter.list(path);
            for (const f of listed.files) {
              await adapter.remove(`${path}/${f}`);
            }
            for (const d of listed.folders) {
              await self.rmdirRecursive(`${path}/${d}`);
            }
            await adapter.remove(path);
          }
        },

        async stat(path: string): Promise<{
          type: 'file' | 'dir';
          ctimeMillis: number;
          mtimeMillis: number;
          size: number;
          mode: number;
        }> {
          const s = await adapter.stat(path);
          const isDir = s.type === 'folder';
          return {
            type: isDir ? 'dir' : 'file',
            ctimeMillis: s.ctime || 0,
            mtimeMillis: s.mtime || 0,
            size: s.size || 0,
            mode: isDir ? 0o40000 : 0o100644, // standard git perms
          };
        },

        async lstat(path: string): Promise<{
          type: 'file' | 'dir';
          ctimeMillis: number;
          mtimeMillis: number;
          size: number;
          mode: number;
        }> {
          return this.stat(path);
        },

        async readlink(): Promise<string> {
          // Symlinks not supported by Obsidian vault
          throw new Error('Symlinks not supported');
        },

        async symlink(): Promise<void> {
          // Symlinks not supported by Obsidian vault
          throw new Error('Symlinks not supported');
        },
      },
    };
  }

  private async rmdirRecursive(path: string): Promise<void> {
    const adapter = this.vaultAdapter;
    const listed = await adapter.list(path);
    for (const f of listed.files) {
      await adapter.remove(`${path}/${f}`);
    }
    for (const d of listed.folders) {
      await this.rmdirRecursive(`${path}/${d}`);
    }
    await adapter.remove(path);
  }
}
