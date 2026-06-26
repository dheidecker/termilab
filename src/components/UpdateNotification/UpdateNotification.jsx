import { useState, useEffect, useCallback } from 'react';
import './UpdateNotification.css';

export default function UpdateNotification() {
  const [status, setStatus] = useState(null); // null | 'available' | 'downloading' | 'ready'
  const [info, setInfo] = useState({});
  const [dismissed, setDismissed] = useState(false);
  const [closing, setClosing] = useState(false);
  const [currentVersion, setCurrentVersion] = useState('');

  useEffect(() => {
    const api = window.electronAPI?.updater;
    if (!api) return;

    api.getVersion?.().then(v => setCurrentVersion(v)).catch(() => {});

    api.onStatus((data) => {
      if (data.status === 'available') {
        setStatus('available');
        setInfo(data);
        setDismissed(false);
        setClosing(false);
      } else if (data.status === 'downloading') {
        setStatus('downloading');
        setInfo(prev => ({ ...prev, ...data }));
      } else if (data.status === 'ready') {
        setStatus('ready');
        setInfo(prev => ({ ...prev, ...data }));
        setDismissed(false);
        setClosing(false);
      }
    });

    return () => {
      api.removeStatusListener?.();
    };
  }, []);

  const dismiss = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      setDismissed(true);
      setClosing(false);
    }, 250);
  }, []);

  const handleDownload = useCallback(async () => {
    try {
      setStatus('downloading');
      setInfo(prev => ({ ...prev, percent: 0 }));
      await window.electronAPI.updater.download();
    } catch (err) {
      console.error('Download failed:', err);
    }
  }, []);

  const handleInstall = useCallback(() => {
    window.electronAPI?.updater?.install();
  }, []);

  if (dismissed || !status) return null;

  return (
    <div className={`update-notification ${closing ? 'closing' : ''} ${status === 'ready' ? 'ready' : ''}`}>
      <div className="update-header">
        <div className="update-header-left">
          <svg className="update-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {status === 'ready' ? (
              <><path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>
            ) : (
              <><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></>
            )}
          </svg>
          <span className="update-title">
            {status === 'available' && 'Update Available'}
            {status === 'downloading' && 'Downloading...'}
            {status === 'ready' && 'Ready to Install'}
          </span>
        </div>
        <button className="update-close" onClick={dismiss} title="Dismiss">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="update-body">
        {status === 'available' && (
          <>Termilab <span className="update-version">v{info.version}</span> is available. You are on v{currentVersion || '?'}.</>
        )}
        {status === 'downloading' && (
          <>Downloading Termilab <span className="update-version">v{info.version}</span>...</>
        )}
        {status === 'ready' && (
          <>Termilab <span className="update-version">v{info.version}</span> downloaded. Restart to apply.</>
        )}
      </div>

      {status === 'downloading' && (
        <div className="update-progress">
          <div className="update-progress-bar">
            <div className="update-progress-fill" style={{ width: `${info.percent || 0}%` }} />
          </div>
          <div className="update-progress-text">{info.percent || 0}%</div>
        </div>
      )}

      <div className="update-actions">
        {status === 'available' && (
          <>
            <button className="update-btn update-btn-secondary" onClick={dismiss}>Later</button>
            <button className="update-btn update-btn-primary" onClick={handleDownload}>Download</button>
          </>
        )}
        {status === 'ready' && (
          <>
            <button className="update-btn update-btn-secondary" onClick={dismiss}>Later</button>
            <button className="update-btn update-btn-primary" onClick={handleInstall}>Restart & Update</button>
          </>
        )}
      </div>
    </div>
  );
}
