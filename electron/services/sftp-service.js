const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sshService = require('./ssh-service');

class SFTPService {
  constructor() {
    /** @type {Map<string, any>} */
    this.sftpSessions = new Map();
    /** @type {import('electron').BrowserWindow | null} */
    this.mainWindow = null;
  }

  setMainWindow(win) {
    this.mainWindow = win;
  }

  _send(channel, ...args) {
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(channel, ...args);
      }
    } catch (err) {
      console.error(`[SFTPService] Failed to send to renderer on ${channel}:`, err.message);
    }
  }

  async _getSFTP(sessionId) {
    // Return cached SFTP session if available
    if (this.sftpSessions.has(sessionId)) {
      return this.sftpSessions.get(sessionId);
    }

    const client = sshService.getClient(sessionId);
    if (!client) {
      throw new Error(`No active SSH session found for ID: ${sessionId}`);
    }

    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          return reject(new Error(`Failed to open SFTP session: ${err.message}`));
        }

        sftp.on('end', () => {
          this.sftpSessions.delete(sessionId);
        });

        sftp.on('close', () => {
          this.sftpSessions.delete(sessionId);
        });

        sftp.on('error', (err) => {
          console.error(`[SFTPService] SFTP session error for ${sessionId}:`, err.message);
          this.sftpSessions.delete(sessionId);
        });

        this.sftpSessions.set(sessionId, sftp);
        resolve(sftp);
      });
    });
  }

  async list(sessionId, remotePath) {
    const sftp = await this._getSFTP(sessionId);

    return new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) {
          return reject(new Error(`Failed to list directory "${remotePath}": ${err.message}`));
        }

        const entries = list.map(item => {
          const attrs = item.attrs;
          // Determine file type
          let type = 'file';
          if (attrs.isDirectory()) type = 'directory';
          else if (attrs.isSymbolicLink()) type = 'symlink';
          else if (attrs.isBlockDevice()) type = 'block-device';
          else if (attrs.isCharacterDevice()) type = 'char-device';
          else if (attrs.isFIFO()) type = 'fifo';
          else if (attrs.isSocket()) type = 'socket';

          return {
            name: item.filename,
            path: remotePath === '/' ? `/${item.filename}` : `${remotePath}/${item.filename}`,
            type,
            size: attrs.size,
            modifyTime: attrs.mtime * 1000,
            accessTime: attrs.atime * 1000,
            mode: attrs.mode,
            uid: attrs.uid,
            gid: attrs.gid,
            permissions: this._formatPermissions(attrs.mode),
            isHidden: item.filename.startsWith('.'),
          };
        });

        // Sort: directories first, then alphabetically
        entries.sort((a, b) => {
          if (a.type === 'directory' && b.type !== 'directory') return -1;
          if (a.type !== 'directory' && b.type === 'directory') return 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });

        resolve(entries);
      });
    });
  }

  async download(sessionId, remotePath, localPath) {
    const sftp = await this._getSFTP(sessionId);

    // Get file size for progress tracking
    const stats = await this._stat(sftp, remotePath);
    const totalSize = stats.size;

    return new Promise((resolve, reject) => {
      const readStream = sftp.createReadStream(remotePath);
      const writeStream = fs.createWriteStream(localPath);
      let transferred = 0;

      readStream.on('data', (chunk) => {
        transferred += chunk.length;
        const progress = totalSize > 0 ? Math.round((transferred / totalSize) * 100) : 0;
        this._send('sftp:transfer-progress', {
          sessionId,
          remotePath,
          localPath,
          direction: 'download',
          transferred,
          total: totalSize,
          progress,
        });
      });

      readStream.on('error', (err) => {
        writeStream.destroy();
        // Clean up partial file
        try { fs.unlinkSync(localPath); } catch (_) { /* ignore */ }
        reject(new Error(`Download failed for "${remotePath}": ${err.message}`));
      });

      writeStream.on('error', (err) => {
        readStream.destroy();
        try { fs.unlinkSync(localPath); } catch (_) { /* ignore */ }
        reject(new Error(`Failed to write local file "${localPath}": ${err.message}`));
      });

      writeStream.on('finish', () => {
        resolve({
          remotePath,
          localPath,
          size: transferred,
        });
      });

      readStream.pipe(writeStream);
    });
  }

  async upload(sessionId, localPath, remotePath) {
    const sftp = await this._getSFTP(sessionId);

    // Get local file size for progress
    const localStats = await fsp.stat(localPath);
    const totalSize = localStats.size;

    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(localPath);
      const writeStream = sftp.createWriteStream(remotePath);
      let transferred = 0;

      readStream.on('data', (chunk) => {
        transferred += chunk.length;
        const progress = totalSize > 0 ? Math.round((transferred / totalSize) * 100) : 0;
        this._send('sftp:transfer-progress', {
          sessionId,
          remotePath,
          localPath,
          direction: 'upload',
          transferred,
          total: totalSize,
          progress,
        });
      });

      readStream.on('error', (err) => {
        writeStream.destroy();
        reject(new Error(`Failed to read local file "${localPath}": ${err.message}`));
      });

      writeStream.on('error', (err) => {
        readStream.destroy();
        reject(new Error(`Upload failed for "${remotePath}": ${err.message}`));
      });

      writeStream.on('close', () => {
        resolve({
          remotePath,
          localPath,
          size: transferred,
        });
      });

      readStream.pipe(writeStream);
    });
  }

  async mkdir(sessionId, remotePath) {
    const sftp = await this._getSFTP(sessionId);

    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (err) {
          return reject(new Error(`Failed to create directory "${remotePath}": ${err.message}`));
        }
        resolve({ path: remotePath });
      });
    });
  }

  async delete(sessionId, remotePath, isDirectory) {
    const sftp = await this._getSFTP(sessionId);

    if (isDirectory) {
      await this._deleteDirectory(sftp, remotePath);
    } else {
      await this._deleteFile(sftp, remotePath);
    }
    return { path: remotePath };
  }

  async _deleteFile(sftp, remotePath) {
    return new Promise((resolve, reject) => {
      sftp.unlink(remotePath, (err) => {
        if (err) {
          return reject(new Error(`Failed to delete file "${remotePath}": ${err.message}`));
        }
        resolve();
      });
    });
  }

  async _deleteDirectory(sftp, remotePath) {
    // Recursively delete directory contents first
    const entries = await new Promise((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(new Error(`Failed to read directory "${remotePath}": ${err.message}`));
        resolve(list);
      });
    });

    for (const entry of entries) {
      const entryPath = `${remotePath}/${entry.filename}`;
      if (entry.attrs.isDirectory()) {
        await this._deleteDirectory(sftp, entryPath);
      } else {
        await this._deleteFile(sftp, entryPath);
      }
    }

    return new Promise((resolve, reject) => {
      sftp.rmdir(remotePath, (err) => {
        if (err) {
          return reject(new Error(`Failed to remove directory "${remotePath}": ${err.message}`));
        }
        resolve();
      });
    });
  }

  async rename(sessionId, oldPath, newPath) {
    const sftp = await this._getSFTP(sessionId);

    return new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => {
        if (err) {
          return reject(new Error(`Failed to rename "${oldPath}" to "${newPath}": ${err.message}`));
        }
        resolve({ oldPath, newPath });
      });
    });
  }

  async stat(sessionId, remotePath) {
    const sftp = await this._getSFTP(sessionId);
    const stats = await this._stat(sftp, remotePath);

    let type = 'file';
    if (stats.isDirectory()) type = 'directory';
    else if (stats.isSymbolicLink()) type = 'symlink';

    return {
      path: remotePath,
      type,
      size: stats.size,
      modifyTime: stats.mtime * 1000,
      accessTime: stats.atime * 1000,
      mode: stats.mode,
      uid: stats.uid,
      gid: stats.gid,
      permissions: this._formatPermissions(stats.mode),
    };
  }

  _stat(sftp, remotePath) {
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (err, stats) => {
        if (err) {
          return reject(new Error(`Failed to stat "${remotePath}": ${err.message}`));
        }
        resolve(stats);
      });
    });
  }

  _formatPermissions(mode) {
    if (mode === undefined || mode === null) return '----------';
    const perms = [
      (mode & 0o400) ? 'r' : '-',
      (mode & 0o200) ? 'w' : '-',
      (mode & 0o100) ? 'x' : '-',
      (mode & 0o040) ? 'r' : '-',
      (mode & 0o020) ? 'w' : '-',
      (mode & 0o010) ? 'x' : '-',
      (mode & 0o004) ? 'r' : '-',
      (mode & 0o002) ? 'w' : '-',
      (mode & 0o001) ? 'x' : '-',
    ];
    return perms.join('');
  }

  closeSFTP(sessionId) {
    const sftp = this.sftpSessions.get(sessionId);
    if (sftp) {
      try {
        sftp.end();
      } catch (_) { /* ignore */ }
      this.sftpSessions.delete(sessionId);
    }
  }

  closeAll() {
    for (const [sessionId] of this.sftpSessions) {
      this.closeSFTP(sessionId);
    }
  }
}

module.exports = new SFTPService();
