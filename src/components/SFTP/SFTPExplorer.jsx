import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../../contexts/AppContext';
import './SFTPExplorer.css';

const hasApi = () => typeof window !== 'undefined' && !!window.electronAPI;

/* Mock file listing for browser dev */
const MOCK_FILES = [
  { name: '..', path: '/home/..', type: 'directory', size: 4096, modifyTime: Date.now() - 86400000, permissions: 'drwxr-xr-x' },
  { name: 'Documents', path: '/home/Documents', type: 'directory', size: 4096, modifyTime: Date.now() - 86400000, permissions: 'drwxr-xr-x' },
  { name: 'Downloads', path: '/home/Downloads', type: 'directory', size: 4096, modifyTime: Date.now() - 172800000, permissions: 'drwxr-xr-x' },
  { name: '.ssh', path: '/home/.ssh', type: 'directory', size: 4096, modifyTime: Date.now() - 259200000, permissions: 'drwx------' },
  { name: 'config.yml', path: '/home/config.yml', type: 'file', size: 2048, modifyTime: Date.now() - 3600000, permissions: '-rw-r--r--' },
  { name: 'deploy.sh', path: '/home/deploy.sh', type: 'file', size: 4521, modifyTime: Date.now() - 7200000, permissions: '-rwxr-xr-x' },
  { name: 'README.md', path: '/home/README.md', type: 'file', size: 15234, modifyTime: Date.now() - 432000000, permissions: '-rw-r--r--' },
  { name: 'docker-compose.yml', path: '/home/docker-compose.yml', type: 'file', size: 896, modifyTime: Date.now() - 600000, permissions: '-rw-r--r--' },
  { name: 'backup.tar.gz', path: '/home/backup.tar.gz', type: 'file', size: 52428800, modifyTime: Date.now() - 86400000, permissions: '-rw-r--r--' },
];

/* Helpers */
function formatSize(bytes) {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(timestamp) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const DirIcon = () => (
  <svg className="dir-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" />
  </svg>
);

const FileIcon = () => (
  <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
    <polyline points="13 2 13 9 20 9" />
  </svg>
);

export default function SFTPExplorer({ tab }) {
  const { state } = useApp();
  const [currentPath, setCurrentPath] = useState('/home');
  const [history, setHistory] = useState(['/home']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [contextMenu, setContextMenu] = useState(null);
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  const sessionId = tab.sessionId;

  /* Load file listing */
  const loadFiles = useCallback(async (path) => {
    setLoading(true);
    setSelected(new Set());
    try {
      if (hasApi()) {
        const result = await window.electronAPI.sftp.list(sessionId, path);
        setFiles(result || []);
      } else {
        await new Promise(r => setTimeout(r, 300));
        setFiles(MOCK_FILES);
      }
    } catch (err) {
      console.error('SFTP list error:', err);
      setFiles([]);
    }
    setLoading(false);
  }, [sessionId]);

  useEffect(() => {
    loadFiles(currentPath);
  }, [currentPath, loadFiles]);

  /* Navigation */
  const navigateTo = useCallback((path) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(path);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    setCurrentPath(path);
  }, [history, historyIndex]);

  const goBack = () => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      setCurrentPath(history[historyIndex - 1]);
    }
  };

  const goForward = () => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1);
      setCurrentPath(history[historyIndex + 1]);
    }
  };

  const goUp = () => {
    const parent = currentPath.replace(/\/[^/]+\/?$/, '') || '/';
    navigateTo(parent);
  };

  /* File actions */
  const handleDoubleClick = (file) => {
    if (file.type === 'directory') {
      if (file.name === '..') {
        goUp();
      } else {
        const newPath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
        navigateTo(newPath);
      }
    }
  };

  const handleSelect = (file, e) => {
    setSelected(prev => {
      const next = new Set(e.ctrlKey || e.metaKey ? prev : []);
      if (next.has(file.name)) next.delete(file.name);
      else next.add(file.name);
      return next;
    });
  };

  /* Context menu */
  const handleContextMenu = (e, file) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  };

  useEffect(() => {
    const handler = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handler);
      return () => document.removeEventListener('click', handler);
    }
  }, [contextMenu]);

  const handleDownload = async (file) => {
    if (hasApi()) {
      const remotePath = `${currentPath}/${file.name}`;
      await window.electronAPI.sftp.download(sessionId, remotePath);
    }
  };

  const handleDelete = async (file) => {
    if (!confirm(`Delete "${file.name}"?`)) return;
    if (hasApi()) {
      const remotePath = `${currentPath}/${file.name}`;
      const isDir = file.type === 'directory';
      await window.electronAPI.sftp.delete(sessionId, remotePath, isDir);
      loadFiles(currentPath);
    }
  };

  const handleRename = async (file) => {
    const newName = prompt('New name:', file.name);
    if (newName && newName !== file.name) {
      if (hasApi()) {
        await window.electronAPI.sftp.rename(
          sessionId,
          `${currentPath}/${file.name}`,
          `${currentPath}/${newName}`
        );
        loadFiles(currentPath);
      }
    }
  };

  const handleNewFolder = async () => {
    const name = prompt('Folder name:');
    if (name?.trim()) {
      if (hasApi()) {
        await window.electronAPI.sftp.mkdir(sessionId, `${currentPath}/${name.trim()}`);
        loadFiles(currentPath);
      }
    }
  };

  const handleUpload = async () => {
    if (hasApi()) {
      await window.electronAPI.sftp.upload(sessionId, currentPath);
      loadFiles(currentPath);
    }
  };

  /* Drag & drop */
  const handleDragEnter = (e) => {
    e.preventDefault();
    dragCounter.current++;
    setDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  };

  const handleDragOver = (e) => e.preventDefault();

  const handleDrop = (e) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    /* File upload would be handled here */
  };

  /* Breadcrumb */
  const pathParts = currentPath.split('/').filter(Boolean);

  /* Sort: dirs first, then alphabetical */
  const sortedFiles = [...files].sort((a, b) => {
    const aDir = a.type === 'directory';
    const bDir = b.type === 'directory';
    if (aDir && !bDir) return -1;
    if (!aDir && bDir) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  return (
    <div
      className="sftp-explorer"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Breadcrumb */}
      <div className="sftp-breadcrumb">
        <button className="sftp-breadcrumb-item" onClick={() => navigateTo('/')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
        </button>
        {pathParts.map((part, i) => (
          <React.Fragment key={i}>
            <span className="sftp-breadcrumb-sep">/</span>
            <button
              className={`sftp-breadcrumb-item ${i === pathParts.length - 1 ? 'active' : ''}`}
              onClick={() => navigateTo('/' + pathParts.slice(0, i + 1).join('/'))}
            >
              {part}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* Toolbar */}
      <div className="sftp-toolbar">
        <button className="sftp-toolbar-btn" onClick={goBack} disabled={historyIndex <= 0} title="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button className="sftp-toolbar-btn" onClick={goForward} disabled={historyIndex >= history.length - 1} title="Forward">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button className="sftp-toolbar-btn" onClick={goUp} title="Up">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
        <button className="sftp-toolbar-btn" onClick={() => loadFiles(currentPath)} title="Refresh">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
          </svg>
        </button>
        <div className="sftp-toolbar-divider" />
        <button className="sftp-toolbar-btn" onClick={handleNewFolder} title="New Folder">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" />
            <line x1="12" y1="11" x2="12" y2="17" />
            <line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        </button>
        <button className="sftp-toolbar-btn" onClick={handleUpload} title="Upload">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 16 12 12 8 16" />
            <line x1="12" y1="12" x2="12" y2="21" />
            <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3" />
          </svg>
        </button>
      </div>

      {/* File list */}
      {loading ? (
        <div className="sftp-loading">
          <div className="sftp-loading-spinner" />
          Loading...
        </div>
      ) : (
        <div className="sftp-file-list">
          <div className="sftp-table-header">
            <span>Name</span>
            <span>Size</span>
            <span>Modified</span>
            <span>Permissions</span>
          </div>
          {sortedFiles.length === 0 ? (
            <div className="sftp-empty">Empty directory</div>
          ) : (
            sortedFiles.map((file) => {
              const isDir = file.type === 'directory';
              return (
                <div
                  key={file.name}
                  className={`sftp-file-row ${selected.has(file.name) ? 'selected' : ''}`}
                  onClick={(e) => handleSelect(file, e)}
                  onDoubleClick={() => handleDoubleClick(file)}
                  onContextMenu={(e) => handleContextMenu(e, file)}
                >
                  <div className="sftp-file-name">
                    {isDir ? <DirIcon /> : <FileIcon />}
                    <span>{file.name}</span>
                  </div>
                  <span className="sftp-file-size">
                    {isDir ? '-' : formatSize(file.size)}
                  </span>
                  <span className="sftp-file-modified">
                    {formatDate(file.modifyTime)}
                  </span>
                  <span className="sftp-file-perms">
                    {file.permissions || '-'}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Drop zone overlay */}
      {dragging && (
        <div className="sftp-dropzone">
          <p>Drop files to upload</p>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div className="sftp-context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
          {contextMenu.file.type !== 'directory' && (
            <button className="sftp-context-menu-item" onClick={() => handleDownload(contextMenu.file)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="8 17 12 21 16 17" />
                <line x1="12" y1="12" x2="12" y2="21" />
                <path d="M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29" />
              </svg>
              Download
            </button>
          )}
          <button className="sftp-context-menu-item" onClick={() => handleRename(contextMenu.file)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Rename
          </button>
          <div className="sftp-context-separator" />
          <button className="sftp-context-menu-item danger" onClick={() => handleDelete(contextMenu.file)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
