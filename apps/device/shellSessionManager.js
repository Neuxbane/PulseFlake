const { spawn } = require('child_process');
const EventEmitter = require('events');
const WebSocket = require('ws');
const url = require('url');
const net = require('net');

class ShellSessionManager extends EventEmitter {
    constructor() {
        super();
        this.sessions = new Map(); // workspaceName -> { ws/socket, type, outputBuffer, fileopQueue }
        this.server = null;
        this.event = new EventEmitter();
    }

    async sendFileOp(workspaceName, op, params = {}) {
        const session = this.sessions.get(workspaceName);
        if (!session) return { error: 'No session' };
        if (session.type === 'tcp') return { error: 'File operations (readFile/updateFile/etc) are not supported on native bash shells. Use sendCommand with bash tools (cat/echo/etc) instead.' };
        if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return { error: 'No active session' };
        
        const id = Date.now().toString();
        const payload = Object.assign({}, params, { op, id });
        const msg = '__FILEOP__' + JSON.stringify(payload);
        
        if (!session.fileopQueue) session.fileopQueue = new Map();
        
        return await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                session.fileopQueue.delete(id);
                resolve({ error: 'Timeout waiting for fileop response' });
            }, 10000);
            session.fileopQueue.set(id, (res) => {
                clearTimeout(timeout);
                resolve(res.error ? { error: res.error } : { result: res.result });
            });
            session.ws.send(msg);
        });
    }

    async sendCommand(workspaceName, command) {
        const session = this.sessions.get(workspaceName);
        if (!session) {
            const available = this.listSessions();
            return `Error: No active session for workspace: "${workspaceName}".\nAvailable workspaces: ${available.length > 0 ? available.join(', ') : 'None (none connected)'}`;
        }
        
        const initialBufferLength = session.outputBuffer.length;
        let textToSend = command;

        const translateShortcuts = (text) => {
            const ctrlMatch = text.match(/Ctrl\+([A-Za-z])/gi);
            if (ctrlMatch) {
                ctrlMatch.forEach(match => {
                    const key = match.split('+')[1].toUpperCase();
                    const code = key.charCodeAt(0) - 64;
                    text = text.replace(match, String.fromCharCode(code));
                });
            }
            text = text.replace(/Alt\+([A-Za-z])/gi, (m, g) => "\x1b" + g.toLowerCase());
            text = text.replace(/Enter/gi, "\n");
            text = text.replace(/Space/gi, " ");
            text = text.replace(/Tab/gi, "\t");
            text = text.replace(/Escape|Esc/gi, "\x1b");
            text = text.replace(/Up/g, "\x1b[A");
            text = text.replace(/Down/g, "\x1b[B");
            text = text.replace(/Right/g, "\x1b[C");
            text = text.replace(/Left/g, "\x1b[D");
            return text;
        };

        textToSend = translateShortcuts(textToSend);

        if (session.type === 'tcp') {
            if (!textToSend.endsWith('\n')) textToSend += '\n';
            session.socket.write(textToSend);
        } else {
            let wsText = textToSend;
            if (!wsText.includes('\x1b') && !wsText.includes('\x03')) {
                if (!wsText.endsWith('\n') && !wsText.endsWith('\r')) wsText += '\r';
                else wsText = wsText.replace(/\n$/, '\r');
            }
            session.ws.send(wsText);
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
        
        if (session.type === 'tcp') {
            return session.outputBuffer.substring(initialBufferLength).trim() || "Command sent (check next output)";
        }

        const response = await this.sendFileOp(workspaceName, 'captureTerminal');
        return response.result || response.error || session.outputBuffer.substring(initialBufferLength) || session.outputBuffer.slice(-2048);
    }

    async readTerminalOutput(workspaceName) {
        const session = this.sessions.get(workspaceName);
        if (!session) {
            const available = this.listSessions();
            return `Error: No session for workspace: "${workspaceName}".\nAvailable workspaces: ${available.length > 0 ? available.join(', ') : 'None (none connected)'}`;
        }
        if (session.type === 'tcp') return session.outputBuffer.slice(-2048);
        
        const response = await this.sendFileOp(workspaceName, 'captureTerminal');
        return response.result || response.error || session.outputBuffer.slice(-2048);
    }

    async listDir(workspaceName, path = "./") {
        return await this.sendFileOp(workspaceName, 'listDir', { path });
    }

    async createFile(workspaceName, path, content) {
        return await this.sendFileOp(workspaceName, 'createFile', { path, content });
    }

    async deleteFile(workspaceName, path) {
        return await this.sendFileOp(workspaceName, 'deleteFile', { path });
    }

    async updateFile(workspaceName, path, content) {
        return await this.sendFileOp(workspaceName, 'updateFile', { path, content });
    }

    async readFile(workspaceName, path, lineFrom, lineTo) {
        return await this.sendFileOp(workspaceName, 'readFile', { path, lineFrom, lineTo });
    }

    async applyPatch(workspaceName, path, patch) {
        return await this.sendFileOp(workspaceName, 'applyPatch', { path, patch });
    }

    startServer(port = 7778, event) {
        this.event = event;
        // WebSocket server
        this.server = new WebSocket.Server({ port });
        this.server.on('connection', (ws, req) => this.handleWSConnection(ws, req));

        // Native TCP server (Port 7779)
        const tcpServer = net.createServer((socket) => {
            console.log("[Device] Raw TCP connection...");
            socket.setKeepAlive(true, 5000);
            
            socket.once('data', (data) => {
                const name = data.toString().trim().split('\n')[0].replace(/[^a-zA-Z0-9_-]/g, '');
                if (!name) { socket.end("Identifier required\n"); return; }
                console.log("[Device] Native Bash connected as: " + name);
                const session = { socket, type: 'tcp', outputBuffer: "" };
                this.sessions.set(name, session);
                
                // Signal to the client that we are ready
                socket.write("\n");

                socket.on('data', d => {
                    session.outputBuffer += d.toString();
                    if (session.outputBuffer.length > 32768) session.outputBuffer = session.outputBuffer.slice(-32768);
                    process.stdout.write(d);
                });

                socket.on('error', (err) => {
                    console.error(`[Device] Socket error for ${name}: ${err.message}`);
                    if (this.sessions.get(name)?.socket === socket) this.sessions.delete(name);
                });

                socket.on('close', () => {
                    if (this.sessions.get(name)?.socket === socket) {
                        this.sessions.delete(name);
                        console.log("[Device] TCP Shell lost: " + name);
                    }
                });
            });
        });
        tcpServer.listen(7779, '0.0.0.0', () => console.log("[Device] Native Shell TCP Server on 7779"));
    }

    handleWSConnection(ws, req) {
        const parsed = url.parse(req.url, true);
        const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
        if (!name) { ws.close(); return; }
        const session = { ws, type: 'ws', outputBuffer: "", fileopQueue: new Map() };
        this.sessions.set(name, session);
        ws.on('message', m => {
            let s = Buffer.isBuffer(m) ? m.toString() : m;
            if (s.startsWith('__FILERES__')) {
                try {
                    const res = JSON.parse(s.slice(11));
                    if (session.fileopQueue.has(res.id)) {
                        session.fileopQueue.get(res.id)(res);
                        session.fileopQueue.delete(res.id);
                    }
                } catch(e) {}
            } else {
                session.outputBuffer += s;
                if (session.outputBuffer.length > 32768) session.outputBuffer = session.outputBuffer.slice(-32768);
                process.stdout.write(s);
            }
        });
        ws.on('close', () => this.sessions.delete(name));
    }

    listSessions() { return Array.from(this.sessions.keys()); }
}

module.exports = new ShellSessionManager();
