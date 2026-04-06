require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const server = new (require('#UnixSocket'))("console");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const PORT = process.env.CONSOLE_PORT || 6969;
const AGENT_SOCKET_PATH = path.resolve(__dirname, '../agent/agent.sock');
const TOOLS_SOCKET_PATH = path.resolve(__dirname, '../tools/tools.sock');
const CONSOLE_HISTORY_PATH = path.resolve(__dirname, 'console-history.json');

// --- 1. AUTHENTICATION ---
let consolePassword = process.env.CONSOLE_PASSWORD;
let consoleUsername = process.env.CONSOLE_USERNAME || 'admin';

if (!consolePassword) {
    consolePassword = crypto.randomBytes(8).toString('hex');
    console.log(`\n\x1b[33m[console] 🔑 NO PASSWORD CONFIGURED! USE: \x1b[1m${consoleUsername}:${consolePassword}@localhost:${PORT}\x1b[0m\n`);
} else {
    console.log(`\n\x1b[32m[console] 🛡️ AUTH ACTIVE: \x1b[1m${consoleUsername}:${consolePassword}@localhost:${PORT}\x1b[0m\n`);
}

// Browser Basic Auth Middleware
app.use((req, res, next) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (login === consoleUsername && password === consolePassword) {
        return next();
    }

    res.set('WWW-Authenticate', 'Basic realm="PulseFlake Console"');
    res.status(401).send('Authentication required.');
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 2. IPC HUB ---
const activeApps = new Set();
let registeredTools = [];
let groupedTools = {};

const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');

async function autoConnect() {
    const appsDir = path.join(__dirname, '..');
    const apps = fs.readdirSync(appsDir);
    for (const appName of apps) {
        if (appName === 'console') continue;
        const socketPath = path.join(appsDir, appName, `${appName}.sock`);
        if (fs.existsSync(socketPath)) {
            console.log(`[console] Auto-connecting to ${appName} at ${socketPath}...`);
            server.connect(socketPath);
            activeApps.add(appName);
        }
    }
}

// Register console's own tools to the "tools" server
async function registerConsoleTools() {
    try {
        console.log('[console] Registering console tools...');
        await server.request('tools', 'register', [
            {
                name: "message",
                description: "Sends a direct message or critical notification to the human operator's browser console. Use this to provide status updates, request attention, or display findings that don't belong in a standard conversation flow.",
                parameters: {
                    type: "object",
                    properties: {
                        content: { 
                            type: "string", 
                            description: "The primary message text. Supports plaintext and basic terminology. Be concise but descriptive." 
                        },
                        type: { 
                            type: "string", 
                            enum: ["info", "success", "warning", "error"], 
                            description: "The visual priority level. 'success' for completions, 'warning' for retryable issues, 'error' for blockers, 'info' for general state." 
                        }
                    },
                    required: ["content"]
                }
            }
        ]);
    } catch (e) {
        console.error('[console] Failed to register tools:', e.message);
    }
}

// Function to refresh all tools from registry (DUMP version)
async function refreshTools() {
    try {
        console.log('[console] Fetching full tool dump from registry...');
        const dump = await server.request('tools', 'dump', {});
        if (dump && Array.isArray(dump)) {
            // Group tools by identifier for the UI
            const currentGrouped = {};
            dump.forEach(tool => {
                const id = tool.identifier;
                if (!currentGrouped[id]) {
                    currentGrouped[id] = [];
                    activeApps.add(id);
                }
                currentGrouped[id].push({
                    ...tool.definition,
                    fullName: tool.fullName
                });
            });
            
            groupedTools = currentGrouped;
            io.emit('tools_dump', groupedTools);
            io.emit('services_update', Array.from(activeApps));
        }
    } catch (e) {
        console.error('[console] Tool refresh error:', e.message);
    }
}

// Connect to tools to fetch registry
server.connect(TOOLS_SOCKET_PATH, async () => {
    console.log('[console] Connected to Tools Registry.');
    await registerConsoleTools();
    await refreshTools();
});

// Auto-connect to all other apps
autoConnect();

// Periodic refresh
setInterval(refreshTools, 30000);

// --- 3. API ENDPOINTS ---
app.get('/api/services', (req, res) => {
    res.json(Array.from(activeApps));
});

app.get('/api/tools', async (req, res) => {
    await refreshTools();
    res.json(groupedTools);
});

app.get('/api/history', (req, res) => {
    res.json(consoleHistory);
});

app.get('/api/calendar/events', async (req, res) => {
    try {
        const calendarSocket = path.resolve(__dirname, '../calendar/calendar.sock');
        if (fs.existsSync(calendarSocket)) {
            await server.connect(calendarSocket);
            const items = await server.request('calendar', 'listEvents');
            res.json(items);
        } else {
            res.json([]);
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/execute', async (req, res) => {
    const { socketPath, toolName, arguments: args } = req.body;
    try {
        if (fs.existsSync(socketPath)) {
            await server.connect(socketPath);
        }
        const result = await server.request(socketPath, toolName, args);
        
        // Push update if calendar was changed
        if (socketPath.includes('calendar')) {
            const items = await server.request('calendar', 'listEvents');
            io.emit('calendar_events', items);
        }
        
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/chat', (req, res) => {
    const data = req.body;
    consoleHistory.push({ role: 'user', content: data.prompt, timestamp: new Date() });
    saveConsoleHistory();
    server.broadcast('event', data);
    res.json({ status: 'sent' });
});

// Metadata fetching
app.get('/api/metadata', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
            },
            timeout: 5000
        });

        const $ = cheerio.load(response.data);
        const metadata = {
            title: $('title').text() || $('meta[property="og:title"]').attr('content') || $('meta[name="twitter:title"]').attr('content') || url,
            description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || $('meta[name="twitter:description"]').attr('content') || '',
            image: $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || '',
            url: url
        };

        res.json(metadata);
    } catch (error) {
        console.error(`[console] Metadata fetch error for ${url}:`, error.message);
        res.json({ title: url, url: url });
    }
});

// Connect to Agent to forward chat
server.connect(AGENT_SOCKET_PATH);

// Listen for tool triggers targeted at the console itself
server.listen('*', 'message', (req, res) => {
    const { content, type = 'info' } = req.data;
    
    // Save to console history
    consoleHistory.push({ role: 'agent', content: content, timestamp: new Date() });
    saveConsoleHistory();

    io.emit('agent_push', { message: content, type, from: req.from });
    res.send({ status: 'delivered' });
});

// Handle incoming events from the ecosystem to show in "Logs"
server.listen('*', 'event', (req, res) => {
    activeApps.add(req.from);
    
    // If it's a response from the agent (optional/experimental - depends on agent's broadcast)
    if(req.data && req.data.role === 'assistant' && req.data.content) {
        consoleHistory.push({ role: 'agent', content: req.data.content, timestamp: new Date() });
        saveConsoleHistory();
    }

    io.emit('terminal_output', { service: req.from, output: JSON.stringify(req.data) });
    res.send({ ack: true });
});

// --- 3. WEB SOCKETS (GUI INTERACTION) ---
let consoleHistory = [];
if (fs.existsSync(CONSOLE_HISTORY_PATH)) {
    try {
        consoleHistory = JSON.parse(fs.readFileSync(CONSOLE_HISTORY_PATH, 'utf8'));
    } catch (e) {
        console.error('[console] Error loading console history:', e.message);
    }
}

function saveConsoleHistory() {
    try {
        fs.writeFileSync(CONSOLE_HISTORY_PATH, JSON.stringify(consoleHistory.slice(-100), null, 2));
    } catch (e) {
        console.error('[console] Error saving console history:', e.message);
    }
}

io.on('connection', (socket) => {
    // Bootstrap client with latest data
    socket.emit('services_update', Array.from(activeApps));
    refreshTools();

    // Send console-specific history
    socket.emit('chat_history', consoleHistory);

    socket.on('request_services_update', () => {
        socket.emit('services_update', Array.from(activeApps));
    });

    socket.on('get_tools', () => {
        refreshTools();
    });

    socket.on('get_calendar_events', async () => {
        try {
            const calendarSocket = path.resolve(__dirname, '../calendar/calendar.sock');
            if (fs.existsSync(calendarSocket)) {
                await server.connect(calendarSocket);
                const items = await server.request('calendar', 'listEvents');
                socket.emit('calendar_events', items);
            } else {
                socket.emit('calendar_events', []);
            }
        } catch (e) {
            console.error('[console] Error fetching events:', e.message);
            socket.emit('calendar_events', []);
        }
    });

    socket.on('get_timeline_events', async () => {
        try {
            const calendarSocket = path.resolve(__dirname, '../calendar/calendar.sock');
            if (fs.existsSync(calendarSocket)) {
                await server.connect(calendarSocket);
                const items = await server.request('calendar', 'timeline', { limit: 100 });
                socket.emit('timeline_events', items);
            } else {
                socket.emit('timeline_events', []);
            }
        } catch (e) {
            console.error('[console] Error fetching timeline:', e.message);
            socket.emit('timeline_events', []);
        }
    });

    socket.on('execute_tool', async ({ socketPath, toolName, arguments: args }, callback) => {
        try {
            console.log(`[console] GUI executing ${toolName} on ${socketPath}...`);
            
            // Ensure we are connected to the socket before requesting
            if (fs.existsSync(socketPath)) {
                await server.connect(socketPath);
            }
            
            const res = await server.request(socketPath, toolName, args);
            
            // If calendar was updated, re-fetch for everyone
            if (socketPath.includes('calendar')) {
                const items = await server.request('calendar', 'listEvents');
                io.emit('calendar_events', items);
            }
            
            if (callback) callback(res);
        } catch (err) {
            console.error(`[console] Execution error:`, err.message);
            if (callback) callback({ error: err.message });
        }
    });

    socket.on('agent_chat', (data) => {
        // Record user message
        consoleHistory.push({ role: 'user', content: data.prompt, timestamp: new Date() });
        saveConsoleHistory();
        
        // Forward web chat to Agent as a 'prompt' event
        server.broadcast('event', data);
    });
});

// --- 4. START ---
httpServer.listen(PORT, () => {
    console.log(`🚀 PulseFlake Console active at http://localhost:${PORT}`);
});

server.start();
