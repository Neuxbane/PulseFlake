const net = require('net');
const path = require('path');
const fs = require('fs');

/**
 * @typedef {Object} UnixSocketRequest
 * @property {string} from - Source identifier
 * @property {string} programCode - Target programCode
 * @property {*} data - The payload data
 */

/**
 * @callback UnixSocketResponseSend
 * @param {*} responseData - Data to send back
 */

/**
 * @typedef {Object} UnixSocketResponse
 * @property {UnixSocketResponseSend} send - Send data back to the requester
 */

class UnixSocket {
  #connectedServers = new Map(); // Map of identifier -> { socketPath, client }
  #listeners = new Map(); // Key: "identifier:programCode"
  #pendingRequests = new Map(); // Key: requestId
  #requestId = 0;
  #connectedSockets = new Map(); // Key: clientIdentifier, Value: Set of socket connections
  #buffer = '';
  #retryTimer = null;

  constructor(identifier = 'default', socketPath) {
    this.identifier = identifier;
    this.socketPath = socketPath || path.join(process.cwd(), `${identifier}.sock`);
    this.server = null;
    this.client = null;
  }

  /**
   * Listen for messages on the socket
   * @param {string|null} identifier - Filter by identifier (null = all)
   * @param {string|null} programCode - Filter by programCode (null = all)
   * @param {function(UnixSocketRequest, UnixSocketResponse, import('net').Socket): void} callback - Callback function(req, res)
   */
  listen(identifier, programCode, callback) {
    const key = `request:${identifier || '*'}:${programCode || '*'}`;
    
    if (!this.#listeners.has(key)) {
      this.#listeners.set(key, []);
    }
    
    // Wrap the callback to store the socket for future use
    const wrappedCallback = (req, res, socket) => {
      // If we don't have a direct connection for this identifier yet,
      // or if it's not writable, store this socket as a "return path"
      if (!this.#connectedServers.has(req.from)) {
        this.#connectedServers.set(req.from, { client: socket, isReturnPath: true });
        console.log(`[UnixSocket ${this.identifier}] 📍 Established return path to: ${req.from}`);
      }
      return callback(req, res);
    };

    this.#listeners.get(key).push(wrappedCallback);
  }

  /**
   * Connect to a Unix socket, TCP port, or URL as a client with automatic retry
   * @param {string|number} socketPath - Path to the Unix socket, TCP port number, or URL (e.g., "tcp://127.0.0.1:8080")
   * @param {Function} [callback] - Async callback to invoke on successful connection (initial or reconnection)
   * @returns {Promise}
   */
  connect(socketPath, callback) {
    // 💡 NEW: Optimized to skip if we are already connected to this path
    for (const [id, connection] of this.#connectedServers.entries()) {
      if (connection.socketPath === socketPath && connection.client && connection.client.writable) {
        return Promise.resolve();
      }
    }

    return new Promise((resolve) => {
      let resolved = false;
      let serverIdentifier = null;
      let clientBuffer = '';

      const _connect = () => {
        let connectionOptions;

        if (typeof socketPath === 'number' || !isNaN(Number(socketPath))) {
          connectionOptions = { port: Number(socketPath), host: 'localhost' };
        } else if (typeof socketPath === 'string' && socketPath.includes('://')) {
          try {
            const url = new URL(socketPath);
            connectionOptions = {
              port: url.port ? Number(url.port) : 80,
              host: url.hostname
            };
          } catch (e) {
            // Fallback to path if URL parsing fails
            connectionOptions = { path: socketPath };
          }
        } else {
          connectionOptions = { path: socketPath };
        }

        const client = net.createConnection(connectionOptions);

        client.on('connect', () => {
          client.write(JSON.stringify({ type: 'identifier', identifier: this.identifier }) + '\n');
        });

        client.on('data', async (data) => {
          clientBuffer += data.toString();
          const lines = clientBuffer.split('\n');
          clientBuffer = lines.pop();

          for (const line of lines) {
            if (line.trim()) {
              try {
                const message = JSON.parse(line);
                
                // Capture server identifier from ack message
                if (message.type === 'ack' && message.serverIdentifier && !serverIdentifier) {
                  serverIdentifier = message.serverIdentifier;
                  // Store this client connection by server identifier
                  this.#connectedServers.set(serverIdentifier, { socketPath, client });
                  console.log(`[UnixSocket ${this.identifier}] ✅ Connected to server: ${serverIdentifier}`);
                  
                  if (callback) {
                    try {
                      await callback();
                    } catch (e) {
                      console.error(`[UnixSocket ${this.identifier}] Callback error:`, e);
                    }
                  }
                  if (!resolved) {
                    resolved = true;
                    resolve();
                  }
                }
                
                // Handle other response messages (from previous connections)
                if (message.type === 'response') {
                  this.#handleMessage(message);
                }
                
                if (message.type === 'event') {
                  this.#handleEvent(message);
                }
              } catch (e) {
                // Parse error ignored
              }
            }
          }
        });

        client.on('error', () => {
          this.#retryTimer = setTimeout(() => _connect(), 1000);
        });

        client.on('end', () => {
          // On disconnection, retry if we had a server identifier
          if (serverIdentifier) {
            console.log(`[UnixSocket ${this.identifier}] ❌ Disconnected from server: ${serverIdentifier}`);
            serverIdentifier = null;
            this.#retryTimer = setTimeout(() => _connect(), 1000);
          }
        });
      };

      _connect();
    });
  }

  /**
   * Send a request and await response
   * @param {string} identifier - Target identifier
   * @param {string} programCode - Target programCode
   * @param {*} data - Data to send
   * @returns {Promise} Response data
   */
  async request(identifier, programCode, data) {
    // Look for connected server by identifier
    const connection = this.#connectedServers.get(identifier);
    const client = connection ? connection.client : this.client;
    
    if (!client || !client.writable) {
      throw new Error(`Not connected to socket for identifier: ${identifier}`);
    }

    const requestId = ++this.#requestId;
    const message = {
      type: 'request',
      identifier,
      programCode,
      data,
      requestId,
      from: this.identifier
    };

    return new Promise((resolve, reject) => {
      this.#pendingRequests.set(requestId, { resolve, reject });
      client.write(JSON.stringify(message) + '\n');
    });
  }

  /**
   * Broadcast an event to all connected sockets
   * @param {string} eventName - Name of the event
   * @param {*} data - Payload
   */
  broadcast(eventName, data) {
    const message = {
      type: 'event',
      eventName,
      data,
      from: this.identifier
    };
    const jsonMessage = JSON.stringify(message) + '\n';

    // Broadcast to outgoing server connections
    for (const [id, conn] of this.#connectedServers.entries()) {
      if (conn.client && conn.client.writable) {
        conn.client.write(jsonMessage);
      }
    }

    // Broadcast to incoming client connections
    for (const [id, sockets] of this.#connectedSockets.entries()) {
      for (const socket of sockets) {
        if (socket.writable) {
          socket.write(jsonMessage);
        }
      }
    }

    // 💡 NEW: Self-emit for local "many-to-many" within the same process
    // This allows an app to hear its own broadcasts if it's subscribed
    this.#handleEvent(message);
  }

  /**
   * Subscribe to events from a specific identifier or all
   * @param {string|null} identifier - Source identifier (null = all)
   * @param {string} eventName - Name of the event
   * @param {Function} callback - Callback function(req)
   */
  subscribe(identifier, eventName, callback) {
    const key = `event:${identifier || '*'}:${eventName}`;
    if (!this.#listeners.has(key)) {
      this.#listeners.set(key, []);
    }
    this.#listeners.get(key).push(callback);
  }

  /**
   * Start listening on a Unix socket, TCP port, or URL as a server
   * @param {string|number} [socketPath] - Optional path for the Unix socket, TCP port, or URL (overrides constructor value)
   * @returns {Promise}
   */
  start(socketPath) {
    return new Promise((resolve, reject) => {
      let socketPathToUse = socketPath || this.socketPath;
      
      if (!socketPathToUse) {
        reject(new Error('No socketPath, port or URL provided in constructor or start() call'));
        return;
      }

      let listenOptions;
      let isFile = true;

      if (typeof socketPathToUse === 'number' || !isNaN(Number(socketPathToUse))) {
        listenOptions = { port: Number(socketPathToUse), host: '0.0.0.0' };
        isFile = false;
      } else if (typeof socketPathToUse === 'string' && socketPathToUse.includes('://')) {
        try {
          const url = new URL(socketPathToUse);
          listenOptions = {
            port: url.port ? Number(url.port) : 80,
            host: url.hostname === 'localhost' ? '127.0.0.1' : (url.hostname || '0.0.0.0')
          };
          isFile = false;
        } catch (e) {
          // Fallback to file path
          listenOptions = socketPathToUse;
        }
      } else {
        listenOptions = socketPathToUse;
      }

      this.socketPath = socketPathToUse;

      // Remove socket file if it exists (only for file-based sockets)
      if (isFile && typeof listenOptions === 'string' && fs.existsSync(listenOptions)) {
        fs.unlinkSync(listenOptions);
      }

      this.server = net.createServer((socket) => {
        this.#handleNewConnection(socket);
      });

      // Set high backlog to allow many concurrent pending connections
      this.server.listen(listenOptions, 128, () => {
        const type = isFile ? 'Unix socket' : 'TCP network';
        console.log(`[UnixSocket ${this.identifier}] 🚀 Server listening on ${type}: ${socketPathToUse}`);
        resolve();
      });

      this.server.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Handle new client connection to server
   */
  #handleNewConnection(socket) {
    let clientIdentifier = null;
    let socketBuffer = '';
    let identifierProcessed = false;

    socket.on('data', (data) => {
      socketBuffer += data.toString();
      const lines = socketBuffer.split('\n');
      socketBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const message = JSON.parse(line);

          // Route based on message type
          if (message.type === 'event') {
            this.#handleEvent(message);
          } else if (message.type === 'response') {
            // ... (optional logic if needed separate from request resolver) ...
          }

          // First message must be identifier
          if (!identifierProcessed) {
            if (message.type !== 'identifier') {
              socket.write(JSON.stringify({ type: 'error', message: 'First message must be identifier' }) + '\n');
              socket.destroy();
              return;
            }

            clientIdentifier = message.identifier;

            // Track connection: allow multiple sockets per identifier
            if (!this.#connectedSockets.has(clientIdentifier)) {
              this.#connectedSockets.set(clientIdentifier, new Set());
            }
            this.#connectedSockets.get(clientIdentifier).add(socket);
            identifierProcessed = true;
            
            const socketCount = this.#connectedSockets.get(clientIdentifier).size;
            console.log(`[UnixSocket ${this.identifier}] ✅ Client connected: ${clientIdentifier} (connection ${socketCount})`);
            socket.write(JSON.stringify({ type: 'ack', message: 'Identifier accepted', serverIdentifier: this.identifier }) + '\n');
            return;
          }

          // Route message
          this.#routeMessage(message, socket, clientIdentifier);
        } catch (e) {
          // Parse error ignored
        }
      }
    });

    socket.on('end', () => {
      if (clientIdentifier) {
        const sockets = this.#connectedSockets.get(clientIdentifier);
        if (sockets) {
          sockets.delete(socket);
          if (sockets.size === 0) {
            this.#connectedSockets.delete(clientIdentifier);
            console.log(`[UnixSocket ${this.identifier}] ❌ Client disconnected: ${clientIdentifier} (all connections closed)`);
          } else {
            console.log(`[UnixSocket ${this.identifier}] ❌ Client connection closed: ${clientIdentifier} (${sockets.size} remaining)`);
          }
        }
      }
    });

    socket.on('error', () => {
      if (clientIdentifier) {
        const sockets = this.#connectedSockets.get(clientIdentifier);
        if (sockets) {
          sockets.delete(socket);
          if (sockets.size === 0) {
            this.#connectedSockets.delete(clientIdentifier);
          }
        }
      }
    });
  }

  /**
   * Route incoming messages to appropriate listeners or handle requests
   */
  #routeMessage(message, socket, fromIdentifier) {
    if (message.type === 'request') {
      // Handle incoming request
      const { identifier, programCode, data, requestId, from } = message;

      // Find matching listeners
      const listeners = this.#findListeners(identifier, programCode);

      if (listeners.length === 0) {
        socket.write(JSON.stringify({
          type: 'response',
          requestId,
          error: `No listener found for ${identifier}:${programCode}`
        }) + '\n');
        return;
      }

      // Create request and response objects
      const req = { from, programCode, data };
      const res = {
        send: (responseData) => {
          socket.write(JSON.stringify({
            type: 'response',
            requestId,
            data: responseData
          }) + '\n');
        }
      };

      // Call all matching listeners
      listeners.forEach(callback => {
        try {
          callback(req, res, socket);
        } catch (e) {
          res.send({ error: e.message });
        }
      });
    } else if (message.type === 'response') {
      // Handle response to pending request
      const { requestId, data, error } = message;
      const pending = this.#pendingRequests.get(requestId);

      if (pending) {
        this.#pendingRequests.delete(requestId);

        if (error) {
          pending.reject(new Error(error));
        } else {
          pending.resolve(data);
        }
      }
    }
  }

  /**
   * Find listeners matching identifier and programCode
   */
  #findListeners(identifier, programCode) {
    const listeners = [];
    const prefix = 'request';
    const key1 = `${prefix}:${identifier}:${programCode}`;
    const key2 = `${prefix}:*:${programCode}`;
    const key3 = `${prefix}:${identifier}:*`;
    const key4 = `${prefix}:*:*`;

    [key1, key2, key3, key4].forEach(key => {
      if (this.#listeners.has(key)) {
        listeners.push(...this.#listeners.get(key));
      }
    });

    return listeners;
  }

  /**
   * Handle incoming events
   */
  #handleEvent(message) {
    const { from, eventName, data } = message;
    const req = { from, eventName, data };
    
    // We already support wildcard matching here!
    const key1 = `event:${from}:${eventName}`;
    const key2 = `event:*:${eventName}`;
    const key3 = `event:${from}:*`;
    const key4 = 'event:*:*';

    [key1, key2, key3, key4].forEach(key => {
      if (this.#listeners.has(key)) {
        this.#listeners.get(key).forEach(callback => {
          try {
            callback(req);
          } catch (err) {
            console.error(`[UnixSocket ${this.identifier}] Event listener error:`, err);
          }
        });
      }
    });
  }

  /**
   * Handle incoming messages on client side
   */
  #handleMessage(message) {
    if (message.type === 'response') {
      // Already handled by #routeMessage for client-side responses
      this.#routeMessage(message, this.client, null);
    }
  }

  /**
   * Close the socket (server or client)
   */
  close() {
    return new Promise((resolve) => {
      if (this.#retryTimer) {
        clearTimeout(this.#retryTimer);
      }

      if (this.server) {
        this.server.close(() => {
          let isFile = true;
          if (typeof this.socketPath === 'number' || !isNaN(Number(this.socketPath))) {
            isFile = false;
          } else if (typeof this.socketPath === 'string' && this.socketPath.includes('://')) {
            isFile = false;
          }

          if (isFile && typeof this.socketPath === 'string' && fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
          }
          console.log(`[UnixSocket ${this.identifier}] ❌ Server closed`);
          resolve();
        });
      } else if (this.client) {
        this.client.destroy();
        console.log(`[UnixSocket ${this.identifier}] ❌ Client closed`);
        resolve();
      } else {
        resolve();
      }
    });
  }
}

module.exports = UnixSocket;
