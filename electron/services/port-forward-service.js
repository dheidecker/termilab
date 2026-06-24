const net = require('net');
const crypto = require('crypto');
const { Client } = require('ssh2');

class PortForwardService {
  constructor() {
    /**
     * Active forwards map.
     * @type {Map<string, { type: string, server?: net.Server, client?: Client, config: object, connections: Set<net.Socket> }>}
     */
    this.forwards = new Map();
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
      console.error(`[PortForwardService] Failed to send to renderer on ${channel}:`, err.message);
    }
  }

  /**
   * Start a port forward.
   * @param {object} config
   * @param {string} config.type - 'local' | 'remote' | 'dynamic'
   * @param {string} config.host - SSH host
   * @param {number} config.port - SSH port
   * @param {string} config.username - SSH username
   * @param {string} [config.password] - SSH password
   * @param {string} [config.privateKey] - SSH private key
   * @param {string} [config.passphrase] - Private key passphrase
   * @param {number} config.localPort - Local port to listen on (local/dynamic)
   * @param {string} [config.localHost='127.0.0.1'] - Local bind address
   * @param {string} [config.remoteHost='127.0.0.1'] - Remote host to forward to
   * @param {number} [config.remotePort] - Remote port to forward to
   * @returns {Promise<string>} - Forward ID
   */
  async start(config) {
    const forwardId = crypto.randomUUID();

    switch (config.type) {
      case 'local':
        await this._startLocalForward(forwardId, config);
        break;
      case 'remote':
        await this._startRemoteForward(forwardId, config);
        break;
      case 'dynamic':
        await this._startDynamicForward(forwardId, config);
        break;
      default:
        throw new Error(`Unknown forward type: ${config.type}. Supported: local, remote, dynamic`);
    }

    return forwardId;
  }

  async _createSSHClient(config) {
    const client = new Client();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.end();
        reject(new Error('SSH connection timed out'));
      }, config.timeout || 30000);

      client.on('ready', () => {
        clearTimeout(timeout);
        resolve(client);
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`SSH connection error: ${err.message}`));
      });

      const sshConfig = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
        readyTimeout: config.timeout || 30000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostVerifier: () => true,
      };

      if (config.privateKey) {
        sshConfig.privateKey = config.privateKey;
        if (config.passphrase) {
          sshConfig.passphrase = config.passphrase;
        }
      } else if (config.password) {
        sshConfig.password = config.password;
      }

      if (process.env.SSH_AUTH_SOCK) {
        sshConfig.agent = process.env.SSH_AUTH_SOCK;
      }

      client.connect(sshConfig);
    });
  }

  // ─── Local Port Forwarding ─────────────────────────────

  async _startLocalForward(forwardId, config) {
    const client = await this._createSSHClient(config);
    const connections = new Set();

    const server = net.createServer((socket) => {
      connections.add(socket);

      socket.on('close', () => {
        connections.delete(socket);
      });

      socket.on('error', (err) => {
        console.error(`[PortForward:local] Socket error: ${err.message}`);
        connections.delete(socket);
      });

      const remoteHost = config.remoteHost || '127.0.0.1';
      const remotePort = config.remotePort;

      client.forwardOut(
        socket.remoteAddress || '127.0.0.1',
        socket.remotePort || 0,
        remoteHost,
        remotePort,
        (err, stream) => {
          if (err) {
            console.error(`[PortForward:local] forwardOut error: ${err.message}`);
            socket.end();
            return;
          }

          socket.pipe(stream).pipe(socket);

          stream.on('close', () => {
            socket.end();
          });

          stream.on('error', () => {
            socket.end();
          });

          socket.on('close', () => {
            stream.end();
          });
        }
      );
    });

    server.on('error', (err) => {
      console.error(`[PortForward:local] Server error: ${err.message}`);
      this._send('port-forward:error', forwardId, err.message);
    });

    client.on('error', (err) => {
      console.error(`[PortForward:local] SSH client error: ${err.message}`);
      this._send('port-forward:error', forwardId, err.message);
      this.stop(forwardId);
    });

    client.on('close', () => {
      this._send('port-forward:closed', forwardId);
      this.stop(forwardId);
    });

    return new Promise((resolve, reject) => {
      const localHost = config.localHost || '127.0.0.1';
      server.listen(config.localPort, localHost, () => {
        this.forwards.set(forwardId, {
          type: 'local',
          server,
          client,
          config,
          connections,
        });
        console.log(`[PortForward:local] ${localHost}:${config.localPort} -> ${config.remoteHost}:${config.remotePort}`);
        resolve(forwardId);
      });

      server.on('error', (err) => {
        client.end();
        reject(new Error(`Failed to start local forward on port ${config.localPort}: ${err.message}`));
      });
    });
  }

  // ─── Remote Port Forwarding ────────────────────────────

  async _startRemoteForward(forwardId, config) {
    const client = await this._createSSHClient(config);
    const connections = new Set();

    const remoteHost = config.remoteHost || '0.0.0.0';
    const remotePort = config.remotePort;

    return new Promise((resolve, reject) => {
      client.forwardIn(remoteHost, remotePort, (err, actualPort) => {
        if (err) {
          client.end();
          return reject(new Error(`Failed to start remote forward: ${err.message}`));
        }

        const boundPort = actualPort || remotePort;

        client.on('tcp connection', (info, accept, reject_conn) => {
          const stream = accept();
          const localHost = config.localHost || '127.0.0.1';
          const localPort = config.localPort;

          const socket = net.createConnection(localPort, localHost, () => {
            connections.add(socket);
            stream.pipe(socket).pipe(stream);
          });

          socket.on('error', (err) => {
            console.error(`[PortForward:remote] Local connection error: ${err.message}`);
            stream.end();
            connections.delete(socket);
          });

          socket.on('close', () => {
            stream.end();
            connections.delete(socket);
          });

          stream.on('close', () => {
            socket.end();
          });

          stream.on('error', () => {
            socket.end();
          });
        });

        client.on('error', (err) => {
          console.error(`[PortForward:remote] SSH client error: ${err.message}`);
          this._send('port-forward:error', forwardId, err.message);
          this.stop(forwardId);
        });

        client.on('close', () => {
          this._send('port-forward:closed', forwardId);
          this.stop(forwardId);
        });

        this.forwards.set(forwardId, {
          type: 'remote',
          client,
          config: { ...config, boundPort },
          connections,
        });

        console.log(`[PortForward:remote] ${remoteHost}:${boundPort} -> ${config.localHost || '127.0.0.1'}:${config.localPort}`);
        resolve(forwardId);
      });
    });
  }

  // ─── Dynamic (SOCKS5) Port Forwarding ──────────────────

  async _startDynamicForward(forwardId, config) {
    const client = await this._createSSHClient(config);
    const connections = new Set();

    const server = net.createServer((socket) => {
      connections.add(socket);

      socket.on('error', (err) => {
        console.error(`[PortForward:dynamic] Socket error: ${err.message}`);
        connections.delete(socket);
      });

      socket.on('close', () => {
        connections.delete(socket);
      });

      this._handleSOCKS5(socket, client);
    });

    server.on('error', (err) => {
      console.error(`[PortForward:dynamic] Server error: ${err.message}`);
      this._send('port-forward:error', forwardId, err.message);
    });

    client.on('error', (err) => {
      console.error(`[PortForward:dynamic] SSH client error: ${err.message}`);
      this._send('port-forward:error', forwardId, err.message);
      this.stop(forwardId);
    });

    client.on('close', () => {
      this._send('port-forward:closed', forwardId);
      this.stop(forwardId);
    });

    return new Promise((resolve, reject) => {
      const localHost = config.localHost || '127.0.0.1';
      server.listen(config.localPort, localHost, () => {
        this.forwards.set(forwardId, {
          type: 'dynamic',
          server,
          client,
          config,
          connections,
        });
        console.log(`[PortForward:dynamic] SOCKS5 proxy on ${localHost}:${config.localPort}`);
        resolve(forwardId);
      });

      server.on('error', (err) => {
        client.end();
        reject(new Error(`Failed to start SOCKS5 proxy on port ${config.localPort}: ${err.message}`));
      });
    });
  }

  _handleSOCKS5(socket, sshClient) {
    let state = 'greeting';

    socket.once('data', (data) => {
      if (state !== 'greeting') return;

      // SOCKS5 greeting
      if (data[0] !== 0x05) {
        socket.end();
        return;
      }

      // Reply: SOCKS5, no auth required
      socket.write(Buffer.from([0x05, 0x00]));
      state = 'request';

      socket.once('data', (reqData) => {
        if (state !== 'request') return;

        // Parse SOCKS5 request
        if (reqData[0] !== 0x05 || reqData[1] !== 0x01) {
          // Only CONNECT command is supported
          socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }

        let destHost, destPort;
        let offset;

        const addrType = reqData[3];
        if (addrType === 0x01) {
          // IPv4
          destHost = `${reqData[4]}.${reqData[5]}.${reqData[6]}.${reqData[7]}`;
          offset = 8;
        } else if (addrType === 0x03) {
          // Domain name
          const domainLen = reqData[4];
          destHost = reqData.slice(5, 5 + domainLen).toString('ascii');
          offset = 5 + domainLen;
        } else if (addrType === 0x04) {
          // IPv6
          const ipv6Parts = [];
          for (let i = 0; i < 16; i += 2) {
            ipv6Parts.push(reqData.readUInt16BE(4 + i).toString(16));
          }
          destHost = ipv6Parts.join(':');
          offset = 20;
        } else {
          socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          socket.end();
          return;
        }

        destPort = reqData.readUInt16BE(offset);

        // Create SSH tunnel to destination
        sshClient.forwardOut(
          socket.remoteAddress || '127.0.0.1',
          socket.remotePort || 0,
          destHost,
          destPort,
          (err, stream) => {
            if (err) {
              // Connection refused or failed
              socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              socket.end();
              return;
            }

            // Success response
            const response = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            socket.write(response);

            // Bi-directional piping
            stream.pipe(socket);
            socket.pipe(stream);

            stream.on('close', () => socket.end());
            stream.on('error', () => socket.end());
            socket.on('close', () => stream.end());
          }
        );
      });
    });
  }

  /**
   * Stop a port forward.
   * @param {string} forwardId
   */
  async stop(forwardId) {
    const forward = this.forwards.get(forwardId);
    if (!forward) return;

    try {
      // Close all active connections
      if (forward.connections) {
        for (const socket of forward.connections) {
          try { socket.destroy(); } catch (_) { /* ignore */ }
        }
        forward.connections.clear();
      }

      // Close the server
      if (forward.server) {
        await new Promise((resolve) => {
          forward.server.close(() => resolve());
          // Force-close after 2 seconds
          setTimeout(resolve, 2000);
        });
      }

      // Unforward remote port if applicable
      if (forward.type === 'remote' && forward.client) {
        try {
          const remoteHost = forward.config.remoteHost || '0.0.0.0';
          const remotePort = forward.config.boundPort || forward.config.remotePort;
          forward.client.unforwardIn(remoteHost, remotePort, () => {});
        } catch (_) { /* ignore */ }
      }

      // Close SSH client
      if (forward.client) {
        try { forward.client.end(); } catch (_) { /* ignore */ }
      }
    } catch (err) {
      console.error(`[PortForwardService] Error stopping forward ${forwardId}:`, err.message);
    } finally {
      this.forwards.delete(forwardId);
    }
  }

  /**
   * Stop all active forwards.
   */
  async stopAll() {
    const forwardIds = Array.from(this.forwards.keys());
    for (const id of forwardIds) {
      await this.stop(id);
    }
  }

  /**
   * Get status of all active forwards.
   */
  getStatus() {
    const status = [];
    for (const [id, forward] of this.forwards) {
      status.push({
        id,
        type: forward.type,
        config: {
          localHost: forward.config.localHost,
          localPort: forward.config.localPort,
          remoteHost: forward.config.remoteHost,
          remotePort: forward.config.remotePort,
        },
        activeConnections: forward.connections ? forward.connections.size : 0,
      });
    }
    return status;
  }
}

module.exports = new PortForwardService();
