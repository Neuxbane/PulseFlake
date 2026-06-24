const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

// --- HELPERS ---
const isPidAlive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
};

// --- CONFIGURATION ---
const APPS_DIR = path.join(__dirname, 'apps');
const daemonPidPath = path.join(__dirname, 'launcher.pid');

// --- STOP EXISTING DAEMON ---
// If running interactively, stop the background watcher daemon first
if (!process.argv.includes('--daemon')) {
    if (fs.existsSync(daemonPidPath)) {
        try {
            const daemonPid = parseInt(fs.readFileSync(daemonPidPath, 'utf8'), 10);
            if (daemonPid && isPidAlive(daemonPid)) {
                console.log(`🛑 Stopping running background daemon (PID: ${daemonPid})...`);
                process.kill(daemonPid, 'SIGTERM');
                
                // Synchronous wait loop for daemon exit
                const start = Date.now();
                while (isPidAlive(daemonPid) && Date.now() - start < 1000) {
                    // spin
                }
                if (isPidAlive(daemonPid)) {
                    process.kill(daemonPid, 'SIGKILL');
                }
            }
            fs.unlinkSync(daemonPidPath);
        } catch (e) {
            console.error('Error stopping existing daemon:', e.message);
        }
    }
}

// --- DISCOVER APPS ---
const getAppsList = () => {
    try {
        if (!fs.existsSync(APPS_DIR)) return [];
        return fs.readdirSync(APPS_DIR)
            .filter(name => {
                if (name === 'template' || name === 'console') {
                    return name === 'console';
                }
                const indexFile = path.join(APPS_DIR, name, 'index.js');
                return fs.existsSync(indexFile);
            })
            .sort()
            .map(name => {
                const appPath = path.join(APPS_DIR, name);
                const pidPath = path.join(appPath, 'app.pid');
                let running = false;
                let pid = null;
                
                if (fs.existsSync(pidPath)) {
                    try {
                        const filePid = parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
                        if (filePid && isPidAlive(filePid)) {
                            running = true;
                            pid = filePid;
                        } else {
                            // clean stale files
                            try { fs.unlinkSync(pidPath); } catch (e) {}
                            const socketPath = path.join(appPath, `${name}.sock`);
                            try { fs.unlinkSync(socketPath); } catch (e) {}
                        }
                    } catch (e) {}
                }
                
                return {
                    name,
                    path: appPath,
                    running,
                    pid,
                    process: null
                };
            });
    } catch (e) {
        console.error('Error scanning apps directory:', e);
        return [];
    }
};

const apps = getAppsList();
let selectedIndex = 0;
let isShuttingDown = false;

// --- RENDER HELPERS ---
const getAppLogs = (app, lineCount = 10) => {
    const logPath = path.join(app.path, 'app.log');
    if (!fs.existsSync(logPath)) {
        return '  (No logs found)';
    }
    try {
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.split('\n');
        // Filter out empty lines at the very end
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
            lines.pop();
        }
        // Get last N lines
        const lastLines = lines.slice(-lineCount);
        if (lastLines.length === 0) {
            return '  (No log output yet)';
        }
        return lastLines.map(line => `  ${line}`).join('\n');
    } catch (e) {
        return `  Error reading logs: ${e.message}`;
    }
};

let lastRenderOutput = '';

// --- RENDER INTERFACE ---
const render = () => {
    if (isShuttingDown) return;

    let output = '';
    
    // Header
    output += '\x1b[1m\x1b[35m\n';
    output += '  💕 PulseFlake App Launcher & Process Monitor 💕\n';
    output += '  ================================================\n';
    output += '\x1b[0m\n';

    if (apps.length === 0) {
        output += '  \x1b[31mNo apps found with index.js in apps/ folder.\x1b[0m\n';
        output += '  Press [q] or [Ctrl+C] to exit.\n';
        process.stdout.write('\x1B[2J\x1B[3J\x1B[H' + output);
        return;
    }

    // App List
    apps.forEach((app, index) => {
        const isSelected = index === selectedIndex;
        const selector = isSelected ? ' \x1b[1m\x1b[35m💕 ' : '    ';
        
        let statusText = '';
        if (app.running) {
            statusText = `\x1b[1m\x1b[32m[ RUNNING ]\x1b[0m \x1b[90m(PID: ${app.pid})\x1b[0m`;
        } else {
            statusText = `\x1b[90m[ STOPPED ]\x1b[0m`;
        }

        const appNameColor = isSelected ? '\x1b[1m\x1b[37m' : '\x1b[37m';
        const logPath = path.join(app.path, 'app.log');
        const hasLogs = fs.existsSync(logPath) ? `\x1b[90m(logs: apps/${app.name}/app.log)\x1b[0m` : '';

        output += `${selector}${appNameColor}${app.name.padEnd(15)}\x1b[0m ${statusText}  ${hasLogs}\n`;
    });

    output += '\x1b[0m\n';
    output += '\x1b[90m  ------------------------------------------------\n';
    output += '  [↑/↓] Navigate   [Enter] Toggle   [a] Active All   [d] Detach   [q/Ctrl+C] Stop All & Exit\n';
    output += '\x1b[0m\n';
    
    // Append logs
    const selectedApp = apps[selectedIndex];
    if (selectedApp) {
        // Calculate remaining terminal rows dynamically
        const totalUIHeight = 13 + apps.length;
        const terminalHeight = process.stdout.rows || 24;
        const lineCount = Math.max(3, terminalHeight - totalUIHeight);
        
        output += `  \x1b[1m\x1b[36mLog Viewer - ${selectedApp.name}\x1b[0m\n`;
        output += `\x1b[90m  ------------------------------------------------\x1b[0m\n`;
        output += getAppLogs(selectedApp, lineCount) + '\n';
        output += `\x1b[90m  ------------------------------------------------\x1b[0m\n`;
    }

    // Only update terminal if output changed to avoid flickering
    if (output !== lastRenderOutput) {
        lastRenderOutput = output;
        process.stdout.write('\x1B[2J\x1B[3J\x1B[H' + output);
    }
};

// --- GRACEFUL TEARDOWN ---
const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    // Show cursor
    process.stdout.write('\x1B[?25h');
    console.log('\n\x1b[1m\x1b[33m🛑 Stopping all processes and cleaning sockets...\x1b[0m');

    const killPromises = apps.map(app => {
        return new Promise((resolve) => {
            const pidPath = path.join(app.path, 'app.pid');
            const socketPath = path.join(app.path, `${app.name}.sock`);
            
            if (!app.running) {
                // Clean stale socket if it exists
                if (fs.existsSync(socketPath)) {
                    try { fs.unlinkSync(socketPath); } catch (e) {}
                }
                return resolve();
            }

            console.log(`  Stopping ${app.name}...`);
            
            let resolved = false;
            const cleanup = () => {
                if (resolved) return;
                resolved = true;
                
                if (fs.existsSync(socketPath)) {
                    try { fs.unlinkSync(socketPath); } catch (e) {}
                }
                if (fs.existsSync(pidPath)) {
                    try { fs.unlinkSync(pidPath); } catch (e) {}
                }
                resolve();
            };

            if (app.process) {
                app.process.removeAllListeners('exit');
                app.process.on('exit', cleanup);
                app.process.kill('SIGINT');
            } else if (app.pid) {
                try {
                    process.kill(app.pid, 'SIGINT');
                } catch (e) {}
                
                // Poll PID exit
                let pollCount = 0;
                const interval = setInterval(() => {
                    pollCount++;
                    if (!isPidAlive(app.pid) || pollCount > 15) {
                        clearInterval(interval);
                        cleanup();
                    }
                }, 100);
            } else {
                cleanup();
            }

            // Force kill after 1.6 seconds
            setTimeout(() => {
                if (!resolved) {
                    if (app.process) {
                        try { app.process.kill('SIGKILL'); } catch (e) {}
                    } else if (app.pid) {
                        try { process.kill(app.pid, 'SIGKILL'); } catch (e) {}
                    }
                    cleanup();
                }
            }, 1600);
        });
    });

    await Promise.all(killPromises);
    
    // Clean daemon PID
    if (fs.existsSync(daemonPidPath)) {
        try { fs.unlinkSync(daemonPidPath); } catch (e) {}
    }
    
    console.log('\x1b[1m\x1b[32m✨ Clean teardown complete. Goodbye!\x1b[0m\n');
    process.exit(0);
};

// --- DETACH TO BACKGROUND ---
const detach = () => {
    if (isShuttingDown) return;
    
    // Stop raw stdin
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    
    console.log('\n\x1b[1m\x1b[32m✨ Detached successfully! Background monitoring daemon started.\x1b[0m\n');
    
    // Spawn daemon watcher
    const daemon = spawn(process.execPath, [__filename, '--daemon'], {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore'
    });
    daemon.unref();
    
    // Exit CLI without killing apps
    process.stdout.write('\x1B[?25h');
    process.exit(0);
};

// --- TOGGLE APP ---
const toggleApp = (app) => {
    const pidPath = path.join(app.path, 'app.pid');
    const socketPath = path.join(app.path, `${app.name}.sock`);

    if (app.running) {
        // Stop
        if (app.process) {
            app.process.kill('SIGINT');
        } else if (app.pid) {
            try {
                process.kill(app.pid, 'SIGINT');
            } catch (e) {
                // Fallback clean
                app.running = false;
                app.pid = null;
                if (fs.existsSync(pidPath)) try { fs.unlinkSync(pidPath); } catch (err) {}
                if (fs.existsSync(socketPath)) try { fs.unlinkSync(socketPath); } catch (err) {}
                render();
            }
        }
    } else {
        // Start
        try {
            const logPath = path.join(app.path, 'app.log');
            fs.appendFileSync(logPath, `\n--- App started by CLI launcher at ${new Date().toISOString()} ---\n`);

            const outFd = fs.openSync(logPath, 'a');

            const child = spawn('node', ['index.js'], {
                cwd: app.path,
                stdio: ['ignore', outFd, outFd],
                env: { ...process.env },
                detached: true
            });

            fs.closeSync(outFd);

            app.process = child;
            app.running = true;
            app.pid = child.pid;
            
            // Write PID file
            fs.writeFileSync(pidPath, child.pid.toString(), 'utf8');

            child.on('error', (err) => {
                fs.appendFileSync(logPath, `Spawn error: ${err.message}\n`);
                app.running = false;
                app.pid = null;
                app.process = null;
                if (fs.existsSync(pidPath)) {
                    try { fs.unlinkSync(pidPath); } catch (e) {}
                }
                render();
            });

            child.on('exit', (code, signal) => {
                fs.appendFileSync(logPath, `App exited with code ${code} and signal ${signal}\n`);
                app.running = false;
                app.pid = null;
                app.process = null;
                
                if (fs.existsSync(socketPath)) {
                    try { fs.unlinkSync(socketPath); } catch (e) {}
                }
                if (fs.existsSync(pidPath)) {
                    try { fs.unlinkSync(pidPath); } catch (e) {}
                }
                
                render();
            });

            child.unref();
            render();
        } catch (e) {
            console.error(`Failed to start app ${app.name}:`, e);
        }
    }
};

// --- ACTIVE ALL ---
const activeAll = () => {
    apps.forEach(app => {
        if (!app.running) {
            toggleApp(app);
        }
    });
};

// --- SETUP STDIN KEY HANDLING ---
const setupInput = () => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
    }
    
    // Hide cursor
    process.stdout.write('\x1B[?25l');

    process.stdin.on('keypress', (str, key) => {
        if (key.ctrl && key.name === 'c') {
            shutdown();
            return;
        }

        switch (key.name) {
            case 'up':
                selectedIndex = (selectedIndex - 1 + apps.length) % apps.length;
                render();
                break;
            case 'down':
                selectedIndex = (selectedIndex + 1) % apps.length;
                render();
                break;
            case 'return':
            case 'enter':
                if (apps[selectedIndex]) {
                    toggleApp(apps[selectedIndex]);
                }
                break;
            case 'a':
                activeAll();
                break;
            case 'd':
                detach();
                break;
            case 'q':
                shutdown();
                break;
        }
    });

    // Periodic state polling (500ms) to update liveness and re-render logs in real-time
    setInterval(() => {
        let changed = false;
        apps.forEach(app => {
            if (app.running && !app.process) {
                if (!isPidAlive(app.pid)) {
                    app.running = false;
                    app.pid = null;
                    
                    const socketPath = path.join(app.path, `${app.name}.sock`);
                    if (fs.existsSync(socketPath)) try { fs.unlinkSync(socketPath); } catch (e) {}
                    const pidPath = path.join(app.path, 'app.pid');
                    if (fs.existsSync(pidPath)) try { fs.unlinkSync(pidPath); } catch (e) {}
                    changed = true;
                }
            }
        });
        // Always render to fetch and show real-time log updates in the viewer
        render();
    }, 500);
};

// --- DAEMON MONITORING MODE ---
const runDaemon = () => {
    // Write daemon PID
    fs.writeFileSync(daemonPidPath, process.pid.toString(), 'utf8');
    
    // Setup hot-reload watchers on running apps
    apps.forEach(app => {
        const indexPath = path.join(app.path, 'index.js');
        const pidPath = path.join(app.path, 'app.pid');
        
        if (fs.existsSync(indexPath)) {
            let debounceTimer;
            fs.watch(indexPath, (eventType) => {
                if (eventType === 'change') {
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(() => {
                        // Check if the app is currently running
                        let runningPid = null;
                        if (fs.existsSync(pidPath)) {
                            try {
                                const pid = parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
                                if (pid && isPidAlive(pid)) {
                                    runningPid = pid;
                                }
                            } catch (e) {}
                        }
                        
                        if (runningPid) {
                            console.log(`[launcher-daemon] 🔄 Restarting ${app.name} due to code change...`);
                            
                            try {
                                process.kill(runningPid, 'SIGINT');
                            } catch (e) {}
                            
                            // Re-start app after a short delay
                            setTimeout(() => {
                                startAppSilent(app);
                            }, 500);
                        }
                    }, 500);
                }
            });
        }
    });

    // Keep daemon process active
    setInterval(() => {
        // Heartbeat
    }, 10000);
};

const startAppSilent = (app) => {
    const pidPath = path.join(app.path, 'app.pid');
    const socketPath = path.join(app.path, `${app.name}.sock`);
    try {
        const logPath = path.join(app.path, 'app.log');
        fs.appendFileSync(logPath, `\n--- App auto-restarted by daemon at ${new Date().toISOString()} ---\n`);

        const outFd = fs.openSync(logPath, 'a');

        const child = spawn('node', ['index.js'], {
            cwd: app.path,
            stdio: ['ignore', outFd, outFd],
            env: { ...process.env },
            detached: true
        });

        fs.closeSync(outFd);
        
        fs.writeFileSync(pidPath, child.pid.toString(), 'utf8');

        child.on('exit', (code, signal) => {
            fs.appendFileSync(logPath, `App exited with code ${code} and signal ${signal}\n`);
            if (fs.existsSync(pidPath)) {
                try {
                    const currentPid = parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
                    if (currentPid === child.pid) {
                        fs.unlinkSync(pidPath);
                        if (fs.existsSync(socketPath)) {
                            fs.unlinkSync(socketPath);
                        }
                    }
                } catch (e) {}
            }
        });
        
        child.unref();
    } catch (e) {
        console.error(`[launcher-daemon] Failed to start ${app.name}:`, e.message);
    }
};

const startTUI = ()=>{
    // Handle TUI termination signals
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('uncaughtException', (err) => {
        console.error('\nUncaught Exception:', err);
        shutdown();
    });

    setupInput();

    // Listen for terminal resize events to adjust log viewer height dynamically
    process.stdout.on('resize', () => {
        render();
    });

    render();
}

// --- RUN ENTRYPOINT ---
if (process.argv.includes('--daemon')) {
    runDaemon();
} else if (process.argv.includes('--start')) {
    const startIdx = process.argv.indexOf('--start');
    const argsAfterStart = process.argv.slice(startIdx + 1);
    
    let appsToStart;
    if (argsAfterStart.includes('--all')) {
        appsToStart = apps.map(a => a.name);
        console.log(`🚀 Starting ALL apps in background! ✨`);
    } else {
        appsToStart = argsAfterStart;
        console.log(`🚀 Starting apps in background: ${appsToStart.join(', ')}...`);
    }
    
    appsToStart.forEach(name => {
        const app = apps.find(a => a.name === name);
        if (app) {
            if (!app.running) {
                startAppSilent(app);
            } else {
                console.log(`  ${app.name} is already running (PID: ${app.pid}).`);
            }
        } else {
            console.error(`  App not found: ${name}`);
        }
    });

    
    // Spawn background daemon to monitor
    const daemon = spawn(process.execPath, [__filename, '--daemon'], {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore'
    })
    daemon.unref();
} else {
    startTUI();
}

if(process.argv.includes('--tui')) {
    startTUI();
}