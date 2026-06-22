// Bugfix Verification: Path shadowing resolved
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dotenv = require('dotenv');
const GeminiProvider = require('./providers/gemini');
const { toolDefinitions, executeTool } = require('./utils/tools');
const { getUserSessionManager } = require('./utils/SessionManager');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const cookie = require('cookie');


const deviceManager = require('./utils/DeviceManager');

dotenv.config();

const DOMAIN_HOST = process.env.DOMAIN_HOST || 'https://ai.exxo.top';
const MAX_DIR_CONTEXT_LENGTH = 100000;
const MAX_ARTIFACTS_LENGTH = 50000;
const INTERRUPTED_SIGNAL = Symbol('INTERRUPTED_SIGNAL');


const app = express();

// Serve remote agent script statically
app.use(cookieParser());


app.get('/api/auth/login', (req, res) => {
    const clientId = process.env.EXXO_AUTH_CLIENT_ID;
    const redirectUri = process.env.EXXO_AUTH_REDIRECT_URI;
    const url = `https://auth.exxo.top/api/auth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
    res.redirect(url);
});

app.get('/api/auth/callback', async (req, res) => {
    const code = req.query.code;
    const clientId = process.env.EXXO_AUTH_CLIENT_ID;
    const redirectUri = process.env.EXXO_AUTH_REDIRECT_URI;
    const secret = process.env.EXXO_AUTH_CLIENT_SECRET;
    try {
        const response = await axios.post('https://auth.exxo.top/api/auth/token', new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            secret: secret,
            redirect_uri: redirectUri
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        const accessToken = response.data.access_token;
        res.cookie('access_token', accessToken, { httpOnly: true });
        res.redirect('/');
    } catch (err) {
        console.error("Auth token error:", err.response ? err.response.data : err.message);
        res.status(500).send('Authentication failed');
    }
});

app.get('/api/auth/logout', (req, res) => {
    res.clearCookie('access_token');
    res.redirect('/api/auth/login');
});

// Middleware for token validation
app.use(async (req, res, next) => {
    if (req.path.startsWith('/api/auth/') || req.path.startsWith('/v2/js/') || req.path.startsWith('/v2/css/') || req.path.endsWith('remote_agent.js') || req.path.endsWith('v2.js') || req.path.endsWith('v2.css') || req.path.match(/^\/[^\/]+\/[a-f0-9]{8}$/) || req.path === '/manifest.json' || req.path === '/sw.js') {
        return next();
    }
    const token = req.cookies.access_token;
    if (!token) {
        if (req.path === '/' || req.path === '/index.html' || req.path === '/v2' || req.path === '/v2/') {
            return res.redirect('/api/auth/login');
        }
        return res.status(401).send('Unauthorized');
    }
    try {
        const response = await axios.post('https://auth.exxo.top/api/auth/validate', {
            user_token: token
        }, {
            headers: {
                'x-app-id': process.env.EXXO_AUTH_CLIENT_ID,
                'x-app-secret': process.env.EXXO_AUTH_CLIENT_SECRET
            }
        });
        console.log('[auth] Validation response:', response.data);
        req.userId = response.data.userId;
        req.username = response.data.username;
        req.displayName = response.data.display_name;
        next();
    } catch (err) {
        if (req.path === '/' || req.path === '/index.html' || req.path === '/v2' || req.path === '/v2/') {
            return res.redirect('/api/auth/login');
        }
        return res.status(401).send('Unauthorized');
    }
});

const pendingUuids = new Map(); // uuid -> userId

// Endpoint to generate a secure registration UUID
app.get('/api/request-device', (req, res) => {
    const uuid = require('crypto').randomBytes(4).toString('hex'); // Short unique ID
    const username = req.username || req.userId;
    pendingUuids.set(uuid, req.userId);
    
    // Expire UUID after 60 seconds
    setTimeout(() => {
        pendingUuids.delete(uuid);
        console.log(`[auth] Registration UUID ${uuid} has expired.`);
    }, 60000);
    
    const commandLinux = `curl -L ${DOMAIN_HOST}/${username}/${uuid} | bash`;
    const commandWindows = `iwr -useb ${DOMAIN_HOST}/${username}/${uuid} | iex`;
    res.json({ uuid, commandLinux, commandWindows });
});

// Installation endpoint: handles both bash and powershell
app.get('/:username/:uuid', (req, res) => {
    const { username, uuid } = req.params;
    
    // Skip if this is a file extension (like device.html) or v2 path
    if (uuid.includes('.') || username === 'v2') {
        return res.status(404).send('Not found');
    }
    
    const userId = pendingUuids.get(uuid);

    if (!userId) {
        return res.status(403).send('Invalid or expired registration UUID. Please request a new one from the server.');
    }
    
    // Remove UUID after use to prevent replay
    pendingUuids.delete(uuid);

    const serverUrl = DOMAIN_HOST;
    const userAgent = req.headers['user-agent'] || '';
    const isWindows = userAgent.includes('Windows') || userAgent.includes('PowerShell');

    if (isWindows) {
        const psScript = `$USERNAME = "${username}"
$UUID = "${uuid}"
$SERVER_URL = "${serverUrl}"

# Prepare directory
$agentDir = Join-Path $HOME ".vibe_agent"
if (!(Test-Path $agentDir)) {
    Write-Host "[*] Creating agent directory..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $agentDir | Out-Null
}
Set-Location $agentDir
$CONFIG_FILE = Join-Path $agentDir ".config"

if (Test-Path $CONFIG_FILE) {
    Write-Host "[*] Loading existing configuration..." -ForegroundColor Cyan
    $config = Get-Content $CONFIG_FILE
    foreach ($line in $config) {
        if ($line -match "REMOTE_USERNAME=(.+)") { $USERNAME = $Matches[1] }
        if ($line -match "REMOTE_UUID=(.+)") { $UUID = $Matches[1] }
    }
} else {
    Write-Host "[*] Creating new configuration..." -ForegroundColor Cyan
    "REMOTE_USERNAME=$USERNAME" | Out-File -FilePath $CONFIG_FILE -Encoding utf8
    "REMOTE_UUID=$UUID" | Out-File -FilePath $CONFIG_FILE -Append -Encoding utf8
}

Write-Host "[*] Installing Remote Agent for $USERNAME ($UUID)..." -ForegroundColor Cyan

# Robust Dependency Check
$nodeExists = Get-Command node -ErrorAction SilentlyContinue
$npmExists = Get-Command npm -ErrorAction SilentlyContinue

if (!$nodeExists -or !$npmExists) {
    Write-Host "[!] Node.js or NPM not found." -ForegroundColor Yellow
    $wingetExists = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetExists) {
        $confirm = Read-Host "Would you like to install Node.js via winget? (y/n)"
        if ($confirm -eq 'y') {
            Write-Host "[*] Installing Node.js..." -ForegroundColor Cyan
            winget install OpenJS.NodeJS
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        } else {
            Write-Host "[!] Installation cancelled. Please install Node.js manually from https://nodejs.org/en/download/" -ForegroundColor Red
            exit
        }
    } else {
        Write-Host "[!] winget not found. Please install Node.js manually from https://nodejs.org/en/download/" -ForegroundColor Red
        exit
    }
}

# Stop existing agent
Write-Host "[*] Stopping existing agent if running..." -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "CommandLine like '%remote_agent.js%'" | Stop-Process -Force -ErrorAction SilentlyContinue

# Download agent script
try {
    Write-Host "[*] Downloading agent script..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri "$SERVER_URL/remote_agent.js" -OutFile "remote_agent.js"
} catch {
    Write-Host "[!] Failed to download agent script: $($_.Exception.Message)" -ForegroundColor Red
    exit
}

# Install dependencies
Write-Host "[*] Installing dependencies..." -ForegroundColor Cyan
npm install socket.io-client puppeteer turndown

# Start agent in background
Write-Host "[*] Starting agent in background..." -ForegroundColor Cyan
$process = Start-Process node -ArgumentList "-e \`"process.env.REMOTE_SERVER_URL='$SERVER_URL'; process.env.REMOTE_USERNAME='$USERNAME'; process.env.REMOTE_UUID='$UUID'; require('./remote_agent.js')\`"" -WindowStyle Hidden -PassThru

if ($process) {
    Write-Host "[+] Agent started successfully! PID: $($process.Id)" -ForegroundColor Green
} else {
    Write-Host "[!] Failed to start agent." -ForegroundColor Red
}`;
        res.setHeader('Content-Type', 'text/plain');
        return res.send(psScript);
    }

    const script = `#!/bin/bash
USERNAME="${username}"
UUID="${uuid}"
SERVER_URL="${serverUrl}"

echo "[*] Preparing Remote Agent installation..."

# Prepare directory
mkdir -p ~/.vibe_agent
CONFIG_FILE="$HOME/.vibe_agent/.config"

if [ -f "$CONFIG_FILE" ]; then
    echo "[*] Loading existing configuration..."
    USERNAME=$(grep "REMOTE_USERNAME=" "$CONFIG_FILE" | cut -d'=' -f2)
    UUID=$(grep "REMOTE_UUID=" "$CONFIG_FILE" | cut -d'=' -f2)
else
    echo "[*] Creating new configuration..."
    echo "REMOTE_USERNAME=$USERNAME" > "$CONFIG_FILE"
    echo "REMOTE_UUID=$UUID" >> "$CONFIG_FILE"
fi

echo "[*] Installing Remote Agent for $USERNAME ($UUID)..."

# Install Node.js if not found
if ! command -v node &> /dev/null; then
    echo "[*] Node.js not found. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Kill existing agent
echo "[*] Stopping existing agent if running..."
pkill -f "remote_agent.js" || true

# Prepare directory and download agent script
cd ~/.vibe_agent
curl -s $SERVER_URL/remote_agent.js -o remote_agent.js
npm install socket.io-client puppeteer turndown

# Start agent in background
nohup node -e "process.env.REMOTE_SERVER_URL='$SERVER_URL'; process.env.REMOTE_USERNAME='$USERNAME'; process.env.REMOTE_UUID='$UUID'; require('./remote_agent.js')" > agent.log 2>&1 &

echo "[+] Agent started in background. Check ~/.vibe_agent/agent.log for details."
`;
    res.setHeader('Content-Type', 'text/x-shellscript');
    res.send(script);
});

const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // 100MB to handle large history with screenshots
});

io.use(async (socket, next) => {
    try {
        if (socket.handshake.auth && socket.handshake.auth.agent === true) {
            socket.isAgent = true;
            socket.userId = socket.handshake.auth.username;
            return next();
        }
        if (!socket.request.headers.cookie) {
            return next(new Error('Authentication error'));
        }
        const cookies = cookie.parse(socket.request.headers.cookie);
        const token = cookies.access_token;
        if (!token) return next(new Error('Authentication error'));
        
        const response = await axios.post('https://auth.exxo.top/api/auth/validate', {
            user_token: token
        }, {
            headers: {
                'x-app-id': process.env.EXXO_AUTH_CLIENT_ID,
                'x-app-secret': process.env.EXXO_AUTH_CLIENT_SECRET
            }
        });
        socket.userId = response.data.userId;
        socket.username = response.data.username;
        socket.displayName = response.data.display_name;
        next();
    } catch (err) {
        next(new Error('Authentication error'));
    }
});

const PORT = 7474;

// Session Event Bus: Maps sessionId to a set of active sockets
const sessionSockets = new Map();
// Track the current status of sessions: sessionId -> 'Thinking' | 'Executing' | 'Idle'
const sessionStatus = new Map();
// Track pending changes (proposed file updates) per session: sessionId -> Map(path -> content)
const sessionPendingChanges = new Map();
// Track interruption requests per session
const sessionInterrupted = new Set();
// Track in-progress assistant messages per session
const sessionInProgressMessages = new Map();
// Track pending tool requests for remote agents: requestId -> { resolve, reject }
const pendingRemoteRequests = new Map();

function requestFromAgent(deviceId, toolName, args) {
    return new Promise((resolve, reject) => {
        if (!deviceId) return reject(new Error('No deviceId provided'));
        const requestId = Date.now().toString() + Math.random().toString().slice(2, 6);
        pendingRemoteRequests.set(requestId, { resolve, reject });
        
        const success = deviceManager.sendToDevice(deviceId, 'tool_request', { requestId, toolName, args });
        if (!success) {
            pendingRemoteRequests.delete(requestId);
            reject(new Error(`Device ${deviceId} is not connected`));
        }
        
        setTimeout(() => {
            if (pendingRemoteRequests.has(requestId)) {
                pendingRemoteRequests.delete(requestId);
                reject(new Error(`Request to device ${deviceId} timed out`));
            }
        }, 30000);
    });
}

function getDeviceIdForSession(userId, sessionId) {
    if (!sessionId) return 'remote';
    const sessionManager = getUserSessionManager(userId);
    const session = sessionManager.getSession(sessionId);
    if (!session) return 'remote';
    const workspace = sessionManager.getWorkspace(session.workspaceId);
    return workspace ? (workspace.deviceId || 'remote') : 'remote';
}

function getWorkspacePathForSession(userId, sessionId) {
    if (!sessionId) return '/tmp';
    const sessionManager = getUserSessionManager(userId);
    const session = sessionManager.getSession(sessionId);
    if (!session) return '/tmp';
    const workspace = sessionManager.getWorkspace(session.workspaceId);
    return workspace ? workspace.path : '/tmp';
}

function applyPendingChangesToTree(tree, pendingChanges) {
    for (const node of tree) {
        if (node.isDirectory) {
            applyPendingChangesToTree(node.children, pendingChanges);
            node.modified = node.children.some(c => c.modified);
        } else {
            node.modified = pendingChanges.has(node.path);
        }
    }
}

function updateSessionStatus(sessionId, status) {
    if (status === 'Idle') {
        sessionStatus.delete(sessionId);
    } else {
        sessionStatus.set(sessionId, status);
    }
    emitToSession(sessionId, 'status_update', { status });
}

function emitToSession(sessionId, event, data, excludeSocket = null) {
    const sockets = sessionSockets.get(sessionId);
    if (sockets) {
        if (sockets.size === 0) {
            console.log(`[main] No active sockets for session ${sessionId}`);
        }
        sockets.forEach(socket => {
            if (socket === excludeSocket) return;
            socket.emit(event, data);
        });
    } else {
        console.log(`[main] Session ${sessionId} not found in sessionSockets`);
    }
}

function getFormattedWorkspaces(workspaces) {
    return workspaces;
}

// Serve v2 index page
app.get(['/v2', '/v2/'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'v2', 'index.html'));
});

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

async function buildWorkspaceTree(dir, pendingChanges, indent = 0) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const tree = [];

    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const children = await buildWorkspaceTree(fullPath, pendingChanges, indent + 1);
            const isModified = children.some(child => child.modified);
            tree.push({
                name: entry.name,
                path: fullPath,
                isDirectory: true,
                children: children,
                modified: isModified
            });
        } else {
            tree.push({
                name: entry.name,
                path: fullPath,
                isDirectory: false,
                modified: pendingChanges.has(fullPath)
            });
        }
    }
    return tree;
}

// Load config
let config = [];
try {
    config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (err) {
    if (err.code !== 'ENOENT') {
        console.error('Error loading config.json:', err.message);
    }
}

const geminiKeys = config.filter(c => c.provider === 'gemini').map(c => c.key);
const provider = new GeminiProvider({ apiKeys: geminiKeys });

const systemInstruction = fs.readFileSync(path.join(__dirname, 'orchestrator.instruction.md'), 'utf8');

io.on('connection', (socket) => {
    console.log('Client connected');
    const sessionManager = getUserSessionManager(socket.userId);

    let workspacePath = null;
    let history = [];
    let watcher = null;

    socket.isInterrupted = false;

    socket.on('interrupt_agent', () => {
        if (socket.sessionId) {
            console.log(`[main] Agent interruption requested for session ${socket.sessionId}`);
            sessionInterrupted.add(socket.sessionId);
        }
    });

    socket.on('file_changed', ({ path: filePath }) => {
        if (socket.sessionId) {
            const sessionId = socket.sessionId;
            const pendingChanges = sessionPendingChanges.get(sessionId) || new Map();
            
            // Add the changed file to pending changes if not already present
            if (!pendingChanges.has(filePath)) {
                pendingChanges.set(filePath, {});
            }
            
            // Ensure the map is stored back in sessionPendingChanges
            if (!sessionPendingChanges.has(sessionId)) {
                sessionPendingChanges.set(sessionId, pendingChanges);
            }
            
            // Emit the updated pending changes list to the frontend
            const pendingFiles = Array.from(pendingChanges.keys());
            emitToSession(sessionId, 'pending_changes', pendingFiles);
        }
    });

    socket.on('git_scan', async ({ sessionId }) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, sessionId);
            const workspaceRoot = getWorkspacePathForSession(socket.userId, sessionId);
            const output = await requestFromAgent(deviceId, 'run_command', { 
                command: 'find . -name .git -type d', 
                cwd: workspaceRoot 
            });
            
            if (!output) {
                socket.emit('git_scan_response', []);
                return;
            }

            const repos = output.split('\n')
                .filter(line => line.trim() && line.endsWith('.git'))
                .map(line => {
                    const path = line.replace(/\/.git$/, '');
                    const name = path === '.' ? 'Root Repository' : path.split('/').pop();
                    return { path, name };
                });
                
            socket.emit('git_scan_response', repos);
    // Note: In a real scenario, we might want to get default branches here, 
    // but we'll do it on repo selection as per spec.
        } catch (err) {
            socket.emit('error', `Git scan failed: ${err.message}`);
        }
    });

    socket.on('git_status', async ({ sessionId, repoPath }) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, sessionId);
            const output = await requestFromAgent(deviceId, 'run_command', { 
                command: 'git status --porcelain', 
                cwd: repoPath 
            });
            socket.emit('git_status_response', output);
        } catch (err) {
            socket.emit('error', `Git status failed: ${err.message}`);
        }
    });

    socket.on('git_diff', async ({ sessionId, repoPath, file }) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, sessionId);
            const command = file ? `git diff ${file}` : 'git diff';
            const output = await requestFromAgent(deviceId, 'run_command', { 
                command, 
                cwd: repoPath 
            });
            socket.emit('git_diff_response', output);
        } catch (err) {
            socket.emit('error', `Git diff failed: ${err.message}`);
        }
    });

    socket.on('git_pull', async ({ sessionId, repoPath }) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, sessionId);
            const output = await requestFromAgent(deviceId, 'run_command', { 
                command: 'git pull', 
                cwd: repoPath 
            });
            socket.emit('git_pull_response', output);
        } catch (err) {
            socket.emit('error', `Git pull failed: ${err.message}`);
        }
    });

    socket.on('git_commit', async ({ sessionId, repoPath, message }) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, sessionId);
            const output = await requestFromAgent(deviceId, 'run_command', { 
                command: `git commit -am "${message.replace(/"/g, '\\"')}"`, 
                cwd: repoPath 
            });
            socket.emit('git_commit_response', output);
        } catch (err) {
            socket.emit('error', `Git commit failed: ${err.message}`);
        }
    });

    socket.on('git_push', async ({ sessionId, repoPath }) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, sessionId);
            const output = await requestFromAgent(deviceId, 'run_command', { 
                command: 'git push', 
                cwd: repoPath 
            });
            socket.emit('git_push_response', output);
        } catch (err) {
            socket.emit('error', `Git push failed: ${err.message}`);
        }
    });

    socket.on('git_get_branches', async ({ sessionId, repoPath }) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, sessionId);
            
            const currentBranchOutput = await requestFromAgent(deviceId, 'run_command', {
                command: 'git branch --show-current',
                cwd: repoPath
            });
            
            const allBranchesOutput = await requestFromAgent(deviceId, 'run_command', {
                command: 'git branch -a',
                cwd: repoPath
            });
            
            const currentBranch = currentBranchOutput?.trim() || 'unknown';
            const branches = allBranchesOutput
                ?.split('\n')
                .map(line => line.replace(/^\*?\s+/, '').trim())
                .filter(line => line && !line.startsWith('remotes/')) || [];
            
            socket.emit('git_get_branches_response', { 
                repoPath, 
                currentBranch, 
                branches 
            });
        } catch (err) {
            socket.emit('error', `Failed to get branches: ${err.message}`);
        }
    });

    socket.on('git_checkout', async ({ sessionId, repoPath, branch }) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, sessionId);
            const output = await requestFromAgent(deviceId, 'run_command', {
                command: `git checkout ${branch}`,
                cwd: repoPath
            });
            socket.emit('git_checkout_response', { repoPath, output });
        } catch (err) {
            socket.emit('error', `Git checkout failed: ${err.message}`);
        }
    });

    socket.on('git_generate_message', async ({ sessionId, repoPath }) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, sessionId);
            const diff = await requestFromAgent(deviceId, 'run_command', { 
                command: 'git diff', 
                cwd: repoPath 
            });
            
            if (!diff || diff.trim() === '') {
                socket.emit('git_generate_message_response', 'No changes to commit.');
                return;
            }

            const prompt = `Based on the following git diff, generate a concise and professional git commit message. Return only the message text:\n\n${diff}`;
            const result = await provider.generateText(prompt);
            socket.emit('git_generate_message_response', result);
        } catch (err) {
            socket.emit('error', `AI commit message generation failed: ${err.message}`);
        }
    });

    socket.on('list_directory', async (payload) => {
        let pathStr = payload;
        let deviceId = 'local';
        if (typeof payload === 'object') {
            pathStr = payload.path;
            deviceId = payload.deviceId || 'local';
        }
        try {
            let files;
            const workspacePath = getWorkspacePathForSession(socket.userId, socket.sessionId);
            
            files = await requestFromAgent(deviceId, 'ui_list_directory', { path: pathStr, workspaceRoot: workspacePath });
            
            socket.emit('directory_list', { files, currentPath: pathStr });
        } catch (err) {
            socket.emit('error', `Could not list directory: ${err.message}`);
        }
    });

    socket.on('get_workspace_tree', async (workspacePath) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, socket.sessionId);
            const pendingChanges = sessionPendingChanges.get(socket.sessionId) || new Map();
            let tree;
            const rootPath = getWorkspacePathForSession(socket.userId, socket.sessionId);
            
            tree = await requestFromAgent(deviceId, 'ui_get_workspace_tree', { dir: workspacePath, workspaceRoot: rootPath });
            applyPendingChangesToTree(tree, pendingChanges);
            
            socket.emit('workspace_tree', tree);
        } catch (err) {
            socket.emit('error', `Could not build workspace tree: ${err.message}`);
        }
    });

    socket.on('get_pending_changes', () => {
        const pendingChanges = sessionPendingChanges.get(socket.sessionId) || new Map();
        const pendingFiles = Array.from(pendingChanges.keys());
        socket.emit('pending_changes', pendingFiles);
    });

    socket.on('get_file_diff', async ({ path: filePath }) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, socket.sessionId);
            const pendingChanges = sessionPendingChanges.get(socket.sessionId) || new Map();
            let baseContent;
            const workspacePath = getWorkspacePathForSession(socket.userId, socket.sessionId);
            
            const res = await requestFromAgent(deviceId, 'ui_get_file_content', { path: filePath, workspaceRoot: workspacePath });
            baseContent = typeof res === 'object' && res !== null ? (res.content || JSON.stringify(res, null, 2)) : String(res);
            
            const proposedContent = pendingChanges.get(filePath) || baseContent;
            socket.emit('file_diff', { path: filePath, baseContent, proposedContent });
        } catch (err) {
            socket.emit('error', `Could not read file diff: ${err.message}`);
        }
    });

    socket.on('get_file_content', async ({ path: filePath }) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, socket.sessionId);
            let content;
            const workspacePath = getWorkspacePathForSession(socket.userId, socket.sessionId);
            
            const res = await requestFromAgent(deviceId, 'ui_get_file_content', { path: filePath, workspaceRoot: workspacePath });
            content = typeof res === 'object' && res !== null ? (res.content || JSON.stringify(res, null, 2)) : String(res);
            socket.emit('file_content', { path: filePath, content });
        } catch (err) {
            socket.emit('error', `Could not read file: ${err.message}`);
        }
    });

    socket.on('save_file_content', async ({ path: filePath, content }) => {
        try {
            const deviceId = getDeviceIdForSession(socket.userId, socket.sessionId);
            const workspacePath = getWorkspacePathForSession(socket.userId, socket.sessionId);
            
            await requestFromAgent(deviceId, 'ui_save_file_content', { path: filePath, content, workspaceRoot: workspacePath });
            
            const pendingChanges = sessionPendingChanges.get(socket.sessionId);
            if (pendingChanges) {
                pendingChanges.delete(filePath); // Clear from pending on successful save
            }
            socket.emit('save_success', { path: filePath });
        } catch (err) {
            socket.emit('error', `Could not save file: ${err.message}`);
        }
    });

    socket.on('revert_file_content', async ({ path: filePath }) => {
        try {
            const pendingChanges = sessionPendingChanges.get(socket.sessionId);
            if (pendingChanges && pendingChanges.has(filePath)) {
                const backup = pendingChanges.get(filePath);
                if (backup && backup.originalContent !== undefined) {
                    const deviceId = getDeviceIdForSession(socket.userId, socket.sessionId);
                    const workspacePath = getWorkspacePathForSession(socket.userId, socket.sessionId);
                    
                    await requestFromAgent(deviceId, 'update_file', { 
                        path: filePath, 
                        content: backup.originalContent, 
                        workspaceRoot: workspacePath 
                    });
                }
                pendingChanges.delete(filePath);
            }
            socket.emit('revert_success', { path: filePath });
        } catch (err) {
            socket.emit('error', `Could not revert file: ${err.message}`);
        }
    });


    const setupSocketForSession = (sessionId, wsPath, sessHistory) => {
        // Cleanup previous session membership for this socket
        if (socket.sessionId && socket.sessionId !== sessionId) {
            const oldSockets = sessionSockets.get(socket.sessionId);
            if (oldSockets) {
                oldSockets.delete(socket);
                if (oldSockets.size === 0) {
                    sessionManager.setSessionActivity(socket.sessionId, false);
                }
            }
        }

        workspacePath = wsPath;
        socket.sessionId = sessionId;
        history = [...sessHistory];
        
        console.log(`[main] Setting up socket for session ${sessionId}. History turns: ${history.length}, Estimated size: ${(JSON.stringify(history).length / 1024).toFixed(2)} KB`);
        
        if (!sessionSockets.has(sessionId)) {
            sessionSockets.set(sessionId, new Set());
        }
        sessionSockets.get(sessionId).add(socket);

        // Ensure sessionPendingChanges exists for this session
        if (!sessionPendingChanges.has(sessionId)) {
            sessionPendingChanges.set(sessionId, new Map());
        }

        sessionManager.setSessionActivity(sessionId, true);
        const session = sessionManager.getSession(sessionId);
        socket.emit('workspace_ready', { 
            path: workspacePath, 
            sessionId: socket.sessionId,
            sessionName: session ? session.name : 'Unknown Session',
            history: history,
            isRunning: sessionStatus.has(sessionId),
            inProgressMessage: sessionInProgressMessages.get(sessionId)
        });

        if (watcher) watcher.close();
        try {
            // Local watcher removed to make system fully remote-dependent
        } catch (err) {
            console.error('Error setting up workspace watcher:', err);
        }
    };

    socket.on('set_workspace', async (pathStr) => {
        try {
            const workspaces = sessionManager.getWorkspacesWithSessions();
            let workspace = workspaces.find(ws => ws.path === pathStr);
            let workspaceId;

            if (workspace) {
                workspaceId = workspace.id;
            } else {
                workspaceId = sessionManager.createWorkspace(path.basename(pathStr), pathStr, 'remote');
            }

            let sessionId;
            if (workspace && workspace.sessions && workspace.sessions.length > 0) {
                const activeSession = workspace.sessions.find(s => s.isActive);
                sessionId = activeSession ? activeSession.id : sessionManager.createSession(workspaceId);
            } else {
                sessionId = sessionManager.createSession(workspaceId);
            }
            setupSocketForSession(sessionId, pathStr, []);
        } catch (err) {
            socket.emit('error', `Could not set workspace: ${err.message}`);
        }
    });

    socket.on('join_session', ({ sessionId }) => {
        const session = sessionManager.getSession(sessionId);
        if (!session) {
            socket.emit('error', 'Session not found');
            return;
        }

        const workspace = sessionManager.getWorkspace(session.workspaceId);
        if (!workspace) {
            socket.emit('error', 'Workspace for this session not found');
            return;
        }

        setupSocketForSession(sessionId, workspace.path, sessionManager.getHistory(sessionId));
    });

    socket.on('create_session', ({ workspaceId }) => {
        try {
            const workspace = sessionManager.getWorkspace(workspaceId);
            if (!workspace) {
                socket.emit('error', 'Workspace not found');
                return;
            }

            const sessionId = sessionManager.createSession(workspaceId);
            setupSocketForSession(sessionId, workspace.path, []);
        } catch (err) {
            socket.emit('error', err.message);
        }
    });

    socket.on('delete_session', ({ sessionId }) => {
        try {
            if (sessionManager.deleteSession(sessionId)) {
                socket.emit('sessions_list', getFormattedWorkspaces(sessionManager.getWorkspacesWithSessions()));
            } else {
                socket.emit('error', 'Session not found');
            }
        } catch (err) {
            socket.emit('error', `Error deleting session: ${err.message}`);
        }
    });

    socket.on('get_artifact', async (identifier) => {
        try {
            const artifacts = sessionManager.getArtifacts(socket.sessionId);
            
            // If identifier is 'all' or not provided, send all known artifacts from artifacts
            if (!identifier || identifier === 'all') {
                Object.keys(artifacts).forEach(id => {
                    const content = artifacts[id];
                    if (content !== undefined) {
                        socket.emit('artifact_content', { filename: id, content });
                    }
                });
                return;
            }

            // Handle specific artifact request
            const content = artifacts[identifier];
            if (content !== undefined) {
                socket.emit('artifact_content', { filename: identifier, content });
                return;
            }

            // Fallback to remote agent if it's a known artifact file
            const artifactMap = {
                'documentation': 'documentation.md',
                'task': 'task.md',
                'implementation_plan': 'implementation_plan.md'
            };
            
            const filename = artifactMap[identifier] || identifier;
            const filePath = filename;
            
            try {
                const content = await requestFromAgent(deviceId, 'ui_get_file_content', { path: filePath, workspaceRoot: workspacePath });
                socket.emit('artifact_content', { filename: identifier, content });
            } catch (err) {
                socket.emit('error', `Artifact ${identifier} not found: ${err.message}`);
            }
        } catch (err) {
            socket.emit('error', `Error reading artifact: ${err.message}`);
        }
    });

    socket.on('get_sessions', () => {
        const workspaces = sessionManager.getWorkspacesWithSessions();
        workspaces.forEach(ws => {
            ws.sessions.forEach(s => {
                s.status = sessionStatus.get(s.id) || 'Idle';
            });
        });
        socket.emit('sessions_list', getFormattedWorkspaces(workspaces));
    });

    socket.on('get_home_dir', async ({ deviceId }) => {
        try {
            const path = await requestFromAgent(deviceId, 'ui_get_home_dir', {});
            socket.emit('home_dir_response', { path });
        } catch (err) {
            socket.emit('error', `Could not get home directory: ${err.message}`);
        }
    });

    socket.on('create_workspace', ({ name, path, deviceId }) => {
        try {
            const wsId = sessionManager.createWorkspace(name, path, deviceId);
            socket.emit('workspace_created', { id: wsId, name, path });
        } catch (err) {
            socket.emit('error', `Could not create workspace: ${err.message}`);
        }
    });

    socket.on('toggle_pin', (sessionId) => {
        try {
            const isPinned = sessionManager.togglePin(sessionId);
            socket.emit('session_pinned', { sessionId, isPinned });
            // Update the session list for all sockets in this session
            const workspaces = sessionManager.getWorkspacesWithSessions();
            workspaces.forEach(ws => {
                ws.sessions.forEach(s => {
                    s.status = sessionStatus.get(s.id) || 'Idle';
                });
            });
            socket.emit('sessions_list', getFormattedWorkspaces(workspaces));
        } catch (err) {
            socket.emit('error', `Could not toggle pin: ${err.message}`);
        }
    });

    socket.on('delete_workspace', (workspaceId) => {
        try {
            if (sessionManager.deleteWorkspace(workspaceId)) {
                const workspaces = sessionManager.getWorkspacesWithSessions();
                workspaces.forEach(ws => {
                    ws.sessions.forEach(s => {
                        s.status = sessionStatus.get(s.id) || 'Idle';
                    });
                });
                socket.emit('sessions_list', workspaces);
                socket.emit('workspace_deleted', workspaceId);
            } else {
                socket.emit('error', 'Workspace not found');
            }
        } catch (err) {
            socket.emit('error', `Could not delete workspace: ${err.message}`);
        }
    });

    socket.on('agent_handshake', (info) => {
        const deviceId = `${info.username}_${info.machineId}`;
        socket.deviceId = deviceId;
        const { device, isNew, oldDeviceId } = deviceManager.registerDevice(deviceId, socket, info);
        
        if (oldDeviceId) {
            const sessionManager = getUserSessionManager(socket.userId || info.username);
            sessionManager.migrateWorkspaces(oldDeviceId, deviceId);
        }

        if (!isNew) {
            socket.emit('device_status', `Device already known as ${device.name}`);
        }

        // Notify only the owner's sockets about new connection
        const safeDevice = { ...device, socket: undefined };
        io.sockets.sockets.forEach(s => {
            if (s.username === info.username || s.userId === info.username) {
                s.emit('new_device_connected', safeDevice);
            }
        });
        console.log(`[main] Agent connected: ${deviceId} (${info.hostname})`);
    });

    socket.on('rename_device', ({ deviceId, newName }) => {
        const success = deviceManager.renameDevice(deviceId, newName);
        if (success) {
            io.emit('device_renamed', { deviceId, newName });
        } else {
            socket.emit('error', 'Device not found');
        }
    });

    socket.on('get_devices', () => {
        socket.emit('devices_list', deviceManager.getDevicesForUser(socket.username || socket.userId));
    });

    socket.on('delete_device', ({ deviceId }) => {
        deviceManager.unregisterDevice(deviceId);
        io.emit('device_deleted', deviceId);
    });

    socket.on('tool_response', ({ requestId, result, error, success }) => {
        const pending = pendingRemoteRequests.get(requestId);
        if (pending) {
            if (success) {
                pending.resolve(result);
            } else {
                pending.reject(new Error(error));
            }
            pendingRemoteRequests.delete(requestId);
        }
    });

    socket.on('message', async (payload) => {
        socket.isInterrupted = false; // Reset interruption flag on new message
        if (!workspacePath) {
            socket.emit('error', 'Please set a workspace first');
            return;
        }

        let parts = [];
        if (typeof payload === 'string') {
            parts.push({ text: payload });
        } else if (payload && typeof payload === 'object') {
            // If it's an object, extract text and images correctly
            if (typeof payload.text === 'string') {
                parts.push({ text: payload.text });
            } else if (payload.text) {
                // Fallback for non-string text (though it shouldn't happen)
                parts.push({ text: String(payload.text) });
            }

            if (Array.isArray(payload.images)) {
                payload.images.forEach(img => {
                    parts.push({
                        inlineData: {
                            mimeType: img.mimeType,
                            data: img.data
                        }
                    });
                });
            }
        }

        if (parts.length === 0) return;

        history.push({ role: 'user', parts });
        sessionManager.addHistoryEntry(socket.sessionId, 'user', parts);

        // Broadcast user message to all sockets in this session (excluding sender)
        emitToSession(socket.sessionId, 'user_message', { 
            text: payload.text || (typeof payload === 'string' ? payload : ''), 
            images: payload.images || [] 
        }, socket);

        try {
            // If an agent loop is already running for this session, interrupt it
            if (sessionStatus.has(socket.sessionId)) {
                console.log(`[main] Interrupting existing loop for session ${socket.sessionId} to start new request`);
                sessionInterrupted.add(socket.sessionId);
            }

            updateSessionStatus(socket.sessionId, 'Thinking');
            await runAgentLoop(socket.userId, socket.sessionId, history, workspacePath);
        } catch (err) {
            console.error('Agent loop error:', err);
            emitToSession(socket.sessionId, 'error', err.message);
        } finally {
            updateSessionStatus(socket.sessionId, 'Idle');
        }
    });



    socket.on('disconnect', () => {
        // Handle remote agent disconnection
        if (socket.deviceId) {
            deviceManager.unregisterDevice(socket.deviceId);
        }
        console.log('Client disconnected');
        if (watcher) {
            watcher.close();
        }
        if (socket.sessionId) {
            const sockets = sessionSockets.get(socket.sessionId);
            if (sockets) {
                sockets.delete(socket);
                if (sockets.size === 0) {
                    sessionManager.setSessionActivity(socket.sessionId, false);
                }
            }
        }
    });
});

function truncateHistory(history) {
    const RAM_LIMIT = 50;
    const ANCHOR_TURN_LIMIT = 10; // 10 turns = 20 messages

    if (!history || history.length === 0) return [];

    // If history fits in RAM, just use it raw
    if (history.length <= RAM_LIMIT) {
        let updatedHistory = [...history];
        while (updatedHistory.length > 1 && updatedHistory[0].role !== 'user') {
            updatedHistory.shift();
        }
        return updatedHistory;
    }

    // 1. RAM: Keep the last 50 messages raw
    const ram = history.slice(-RAM_LIMIT);

    // 2. Anchor: Compress the preceding history into Turns
    const anchorCandidates = history.slice(0, history.length - RAM_LIMIT);
    const turns = [];
    let currentTurn = null;

    for (const msg of anchorCandidates) {
        if (msg.role === 'user') {
            // If we have a finished turn, push it to the list
            if (currentTurn) {
                turns.push(currentTurn);
            }
            // Start a new turn
            currentTurn = {
                user: msg,
                assistant: null
            };
        } else if (msg.role === 'assistant' && currentTurn) {
            // Keep updating the assistant part of the turn to ensure we have the FINAL response
            currentTurn.assistant = msg;
        }
    }
    // Push the last turn if it exists
    if (currentTurn) {
        turns.push(currentTurn);
    }

    // Take the 10 most recent turns
    const recentTurns = turns.slice(-ANCHOR_TURN_LIMIT);
    const compressedAnchor = [];
    for (const turn of recentTurns) {
        compressedAnchor.push(turn.user);
        if (turn.assistant) {
            compressedAnchor.push(turn.assistant);
        }
    }

    // 3. Merge Anchor + RAM
    let updatedHistory = [...compressedAnchor, ...ram];

    // 4. API Alignment: Ensure it starts with a 'user' role
    while (updatedHistory.length > 1 && updatedHistory[0].role !== 'user') {
        updatedHistory.shift();
    }

    return updatedHistory;
}


const ORCHESTRATOR_ALLOWED_TOOLS = toolDefinitions.map(t => t.name).filter(name => name !== 'update_file' && name !== 'create_file' && name !== 'run_command');

const CODER_ALLOWED_TOOLS = toolDefinitions.map(t => t.name).filter(name => name !== 'spawn_coder');

async function runAgentLoop(userId, sessionId, history, workspacePath, iteration = 0, agentConfig = { type: 'orchestrator' }) {
    while (iteration < 100) {
        // Check if session has been interrupted
        if (sessionInterrupted.has(sessionId)) {
            console.log(`[main] Agent loop interrupted for session ${sessionId}`);
            sessionInterrupted.delete(sessionId);
            updateSessionStatus(sessionId, 'Idle');
            emitToSession(sessionId, 'done');
            return INTERRUPTED_SIGNAL;
        }

    const deviceId = getDeviceIdForSession(userId, sessionId);
    let dirContext = '';
    try {
        // Request the workspace tree from the remote agent
        const tree = await requestFromAgent(deviceId, 'ui_get_workspace_tree', { dir: workspacePath, workspaceRoot: workspacePath });
        dirContext = typeof tree === 'string' ? tree : JSON.stringify(tree, null, 2);
    } catch (e) {
        dirContext = `Error getting directory context: ${e.message}`;
    }

    if (dirContext.length > MAX_DIR_CONTEXT_LENGTH) {
        dirContext = dirContext.substring(0, MAX_DIR_CONTEXT_LENGTH) + "\n\n... [Workspace tree truncated due to size]";
    }
    
    const sessionManager = getUserSessionManager(userId);
    const artifacts = sessionManager.getArtifacts(sessionId);
    let artifactsBlock = artifacts && Object.keys(artifacts).length > 0 
        ? "\n\n### 🧠 AGENT ARTIFACTS\n" + JSON.stringify(artifacts, null, 2) 
        : "";

    if (artifactsBlock.length > MAX_ARTIFACTS_LENGTH) {
        artifactsBlock = artifactsBlock.substring(0, MAX_ARTIFACTS_LENGTH) + "\n\n... [Artifacts truncated due to size]";
    }

    // Load system instruction based on agent type
    let baseInstruction = '';
    try {
        const instructionFile = agentConfig.type === 'coder' ? 'coder.instruction.md' : 'orchestrator.instruction.md';
        baseInstruction = fs.readFileSync(path.join(__dirname, instructionFile), 'utf8');
    } catch (e) {
        console.error(`[main] Error loading instruction file for ${agentConfig.type}:`, e);
        baseInstruction = systemInstruction; // Fallback
    }

    const dynamicSystemInstruction = `${baseInstruction}\n\n${artifactsBlock}\n\nWorkspace Context:\n${dirContext}\n`;

    console.log(`[main] ${agentConfig.type} System Instruction Length:`, dynamicSystemInstruction.length);

    // Filter tools based on agent type and allowedTools
    let activeTools;
    if (agentConfig.type === 'orchestrator') {
        activeTools = toolDefinitions.filter(t => ORCHESTRATOR_ALLOWED_TOOLS.includes(t.name));
    } else if (agentConfig.type === 'coder') {
        activeTools = toolDefinitions.filter(t => CODER_ALLOWED_TOOLS.includes(t.name));
    } else if (agentConfig.allowedTools) {
        activeTools = toolDefinitions.filter(t => agentConfig.allowedTools.includes(t.name));
    } else {
        activeTools = toolDefinitions;
    }

    const options = {
        systemInstruction: dynamicSystemInstruction,
        tools: activeTools,
        generationConfig:{
            "temperature": 2,
            thinkingConfig: { "thinkingLevel": "MINIMAL" }
        }
    };

    // Filter history based on agent type
    // Orchestrator: only sees user and orchestrator messages
    // Coder: sees user, orchestrator, and coder messages
    const filteredHistory = history.filter(msg => {
        if (msg.role === 'user') return true;
        if (agentConfig.type === 'orchestrator') {
            return msg.agentType === 'orchestrator';
        } else {
            return msg.agentType === 'orchestrator' || msg.agentType === 'coder';
        }
    });

    const truncatedHistory = truncateHistory(filteredHistory);
    console.log(`[main] History length: ${history.length}, Filtered: ${filteredHistory.length}, Truncated: ${truncatedHistory.length}`);
    try {
        const generator = provider.generate(truncatedHistory, options);
        let assistantMessage = { role: 'assistant', parts: [] };
        sessionInProgressMessages.set(sessionId, assistantMessage);
        let toolCalls = [];
        let chunkCount = 0;
        let totalTextLength = 0;

        for await (const partGen of generator) {
            if (sessionInterrupted.has(sessionId)) {
                console.log(`[main] Agent stream interrupted (outer loop) for session ${sessionId}`);
                sessionInterrupted.delete(sessionId);
                emitToSession(sessionId, 'chunk', { type: 'text', content: '\n\n🛑 **User Interrupted**\n\n' });
                updateSessionStatus(sessionId, 'Idle');
                sessionInProgressMessages.delete(sessionId);
                emitToSession(sessionId, 'done');
                return INTERRUPTED_SIGNAL;
            }
            for await (const data of partGen) {
                if (sessionInterrupted.has(sessionId)) {
                    console.log(`[main] Agent stream interrupted (inner loop) for session ${sessionId}`);
                    sessionInterrupted.delete(sessionId);
                    emitToSession(sessionId, 'chunk', { type: 'text', content: '\n\n🛑 **User Interrupted**\n\n' });
                    updateSessionStatus(sessionId, 'Idle');
                    sessionInProgressMessages.delete(sessionId);
                    emitToSession(sessionId, 'done');
                    return INTERRUPTED_SIGNAL;
                }
                if (data.text) {
                    chunkCount++;
                    totalTextLength += data.text.length;
                    updateSessionStatus(sessionId, 'Thinking');
                    emitToSession(sessionId, 'chunk', { type: 'text', content: data.text });
                    const lastPart = assistantMessage.parts[assistantMessage.parts.length - 1];
                    if (lastPart && lastPart.text) {
                        lastPart.text += data.text;
                    } else {
                        assistantMessage.parts.push({ text: data.text });
                    }
                } else if (data.thought) {
                    emitToSession(sessionId, 'chunk', { type: 'thought', content: data.thought });
                    const lastPart = assistantMessage.parts[assistantMessage.parts.length - 1];
                    if (lastPart && lastPart.thought) {
                        lastPart.thought += data.thought;
                    } else {
                        assistantMessage.parts.push({ thought: data.thought });
                    }
                } else if (data.functionCall) {
                    const { name, args, id } = data.functionCall;
                    const thoughtSignature = data.thoughtSignature || data.functionCall.thoughtSignature;
                    const toolCallId = id || data.id;
                    emitToSession(sessionId, 'chunk', { type: 'tool_call', name, args, id: toolCallId });

                    toolCalls.push({ name, args, id: toolCallId });
                    assistantMessage.parts.push({
                        functionCall: { name, args, id: toolCallId },
                        thoughtSignature
                    });
                }
            }
        }

        // Garbage response guard: if no tool calls were made and the response is abnormally short
        if (toolCalls.length === 0 && chunkCount < 5 && totalTextLength < 10) {
            console.warn(`[main] Garbage response detected (chunks: ${chunkCount}, length: ${totalTextLength}). Triggering recovery.`);
            throw new Error('GEMINI_EMPTY_RESPONSE');
        }

        if (toolCalls.length > 0) {
            updateSessionStatus(sessionId, 'Executing');
            assistantMessage.agentType = agentConfig.type;
            history.push(assistantMessage);
            getUserSessionManager(userId).addHistoryEntry(sessionId, 'assistant', assistantMessage.parts, agentConfig.type);

            const toolResultsParts = [];
            for (const toolCall of toolCalls) {
                // Enforce tool permissions: check if the tool is in the activeTools list
                if (!activeTools.some(t => t.name === toolCall.name)) {
                    const errorResult = `Error: You are forbidden from using '${toolCall.name}' for this agent.`;
                    console.warn(`[main] Agent ${agentConfig.type} attempted to use unauthorized tool: ${toolCall.name}`);
                    
                    emitToSession(sessionId, 'chunk', { type: 'tool_result', name: toolCall.name, result: errorResult });
                    toolResultsParts.push({
                        functionResponse: {
                            name: toolCall.name,
                            response: { result: errorResult },
                            id: toolCall.id
                        }
                    });
                    continue;
                }

                // Intercept spawn_coder tool
                if (toolCall.name === 'spawn_coder') {
                    console.log(`[main] Orchestrator spawning Coder AI...`);
                    const { task_description, allowed_tools } = toolCall.args;
                    
                    emitToSession(sessionId, 'chunk', { type: 'text', content: `\n🤖 **Spawning Coder AI** for task: ${task_description}\n` });

                    // Build a rich context for the Coder
                    const sm = getUserSessionManager(userId);
                    const artifacts = sm.getArtifacts(sessionId);
                    
                    // 1. Artifacts
                    const artifactsBlock = artifacts && Object.keys(artifacts).length > 0
                        ? `\n\n### 🧠 CURRENT ARTIFACTS\n${JSON.stringify(artifacts, null, 2)}`
                        : "";

                    // 2. Recent Images (from the last user message in history)
                    let imageParts = [];
                    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
                    if (lastUserMsg && lastUserMsg.parts) {
                        imageParts = lastUserMsg.parts.filter(p => p.inlineData);
                    }

                    const coderHistory = [
                        { 
                            role: 'user', 
                            parts: [
                                ...imageParts,
                                { text: `${artifactsBlock}\n\nTASK DESCRIPTION:\n${task_description}` }
                            ] 
                        }
                    ];

                    // Run the Coder loop
                    const coderResult = await runAgentLoop(userId, sessionId, coderHistory, workspacePath, 0, { 
                        type: 'coder', 
                        allowedTools: allowed_tools 
                    });

                    if (coderResult === INTERRUPTED_SIGNAL) {
                        return INTERRUPTED_SIGNAL;
                    }

                    // The coderResult is the final assistant message from the coder loop
                    const result = `Coder AI completed the task. Result: ${coderResult}`;
                    
                    emitToSession(sessionId, 'chunk', { type: 'tool_result', name: toolCall.name, result });
                    toolResultsParts.push({
                        functionResponse: {
                            name: toolCall.name,
                            response: { result },
                            id: toolCall.id
                        }
                    });
                    continue;
                }

                const deviceId = getDeviceIdForSession(userId, sessionId);
                const sm = getUserSessionManager(userId);
                
                // Backup original content before the update is performed
                if (toolCall.name === 'update_file') {
                    try {
                        const filePath = toolCall.args.path;
                        let originalContent = '';
                        if (requestFromAgent) {
                            originalContent = await requestFromAgent(deviceId, 'read_file', { path: filePath, workspaceRoot: workspacePath });
                        }
                        
                        const pendingChanges = sessionPendingChanges.get(sessionId);
                        if (pendingChanges) {
                            const current = pendingChanges.get(filePath) || {};
                            pendingChanges.set(filePath, { ...current, originalContent });
                        }
                    } catch (err) {
                        // File might not exist yet, which is normal for new files
                        console.log(`[Backup] No existing content for ${toolCall.args.path} (possibly new file).`);
                    }
                }

                const result = await executeTool(toolCall.name, toolCall.args, workspacePath, sessionId, deviceId, requestFromAgent, sm);
                
                if (toolCall.name === 'setArtifact' || toolCall.name === 'deleteArtifact' || toolCall.name === 'updateArtifact') {
                    const artifacts = sm.getArtifacts(sessionId);
                    emitToSession(sessionId, 'artifacts_updated', artifacts);
                }
                if (toolCall.name === 'session_name') {
                    const session = sm.getSession(sessionId);
                    emitToSession(sessionId, 'session_name_updated', { name: session ? session.name : 'Unknown Session' });
                }

                if (toolCall.name === 'create_checkpoint') {
                    const pendingChanges = sessionPendingChanges.get(sessionId);
                    if (pendingChanges) {
                        pendingChanges.clear();
                    }
                    emitToSession(sessionId, 'pending_changes', []);
                }
                
                // Intercept proposed file updates to stage them in sessionPendingChanges
                if (typeof result === 'object' && result.status === 'proposed') {
                    const pendingChanges = sessionPendingChanges.get(sessionId);
                    if (pendingChanges) {
                        const current = pendingChanges.get(result.path) || {};
                        pendingChanges.set(result.path, { ...current, proposedContent: result.content });
                    }
                    
                    // Notify frontend that a file has pending changes
                    emitToSession(sessionId, 'file_proposed', { 
                        path: result.path, 
                        content: result.content,
                        syntaxError: result.syntaxError 
                    });
                    
                    const finalResult = result.message;
                    emitToSession(sessionId, 'chunk', { type: 'tool_result', name: toolCall.name, result: finalResult });
                    toolResultsParts.push({
                        functionResponse: {
                            name: toolCall.name,
                            response: { result: finalResult },
                            id: toolCall.id
                        }
                    });
                } else {
                    emitToSession(sessionId, 'chunk', { type: 'tool_result', name: toolCall.name, result });
                    toolResultsParts.push({
                        functionResponse: {
                            name: toolCall.name,
                            response: { result },
                            id: toolCall.id
                        }
                    });
                }
            }

            history.push({
                role: 'function',
                parts: toolResultsParts,
                agentType: agentConfig.type
            });
            sessionManager.addHistoryEntry(sessionId, 'function', toolResultsParts, agentConfig.type);

            // Continue the loop after tool execution
            iteration++;
            continue;
        }

        if (assistantMessage.parts.length > 0) {
            console.log(`[main] Saving assistant message to session ${sessionId}`);
            assistantMessage.agentType = agentConfig.type;
            history.push(assistantMessage);
            sessionManager.addHistoryEntry(sessionId, 'assistant', assistantMessage.parts, agentConfig.type);
        }
        break;
    } catch (error) {
        console.error(`[main] Agent loop error caught:`, error);
        
        let recoveryContent = `\n⚠️ **An unexpected error occurred. Attempting to recover...**\n`;
        let aiRecoveryText = "The last attempt encountered an error. Please try again.";

        if (error.message === 'GEMINI_EMPTY_RESPONSE') {
            recoveryContent = `\n⚠️ **Empty or malformed response detected. Attempting to recover...**\n`;
            aiRecoveryText = "The last generation output was empty or malformed. Please provide a complete response and continue.";
        } else if (error.message === 'GEMINI_MALFORMED_RESPONSE') {
            recoveryContent = `\n⚠️ **Malformed response detected. Attempting to recover...**\n`;
            aiRecoveryText = "The last generation output was in a malformed format. Please correct the format and try again.";
        } else if (error.message === 'GEMINI_INTERNAL_ERROR') {
            recoveryContent = `\n⚠️ **Internal API error detected. Attempting to recover...**\n`;
            aiRecoveryText = "The previous attempt encountered an internal server error. Please try generating the response again.";
        }

        emitToSession(sessionId, 'chunk', { type: 'text', content: recoveryContent });
        
        const recoveryMsg = { 
            role: 'user', 
            parts: [{ text: aiRecoveryText }] 
        };
        history.push(recoveryMsg);
        sessionManager.addHistoryEntry(sessionId, 'user', recoveryMsg.parts);
        
        iteration++;
        continue;
    }
}



    const lastAssistantMsg = [...history].reverse().find(m => m.role === 'assistant');
    const finalContent = lastAssistantMsg?.parts
        ?.filter(p => p.text)
        .map(p => p.text)
        .join('') || '';

    if (agentConfig.type === 'orchestrator') {
        sessionInProgressMessages.delete(sessionId);
        updateSessionStatus(sessionId, 'Idle');
        emitToSession(sessionId, 'done');
    }
    return finalContent;
}



server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
});
