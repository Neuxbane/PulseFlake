require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');
const axios = require('axios');
const server = new (require('#UnixSocket'))("compute");

const TOOLS_SOCKET_PATH = path.resolve(__dirname, '../tools/tools.sock');
const CONSOLE_PORT = process.env.CONSOLE_PORT || 6969;

// --- HELPERS ---
const getContainerName = (sessionId) => {
    const safeId = (sessionId || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
    return `pulseflake-session-${safeId}`;
};

const getSafeContainerPath = (relPath) => {
    if (!relPath) return '/root';
    const resolved = path.posix.resolve('/root', relPath);
    if (!resolved.startsWith('/root')) {
        throw new Error('Path traversal detected: Path is outside of /root');
    }
    return resolved;
};

const getHostTempPath = () => {
    const baseTemp = path.resolve(__dirname, 'temp');
    if (!fs.existsSync(baseTemp)) {
        fs.mkdirSync(baseTemp, { recursive: true });
    }
    return fs.mkdtempSync(path.join(baseTemp, 'transfer-'));
};

const getHostRootPath = (sessionId) => {
    const safeId = (sessionId || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const hostRootPath = path.resolve(__dirname, 'root', safeId);
    if (!fs.existsSync(hostRootPath)) {
        fs.mkdirSync(hostRootPath, { recursive: true });
    }
    return hostRootPath;
};

const startContainer = (containerName, image, sessionId) => {
    const hostRootPath = getHostRootPath(sessionId);
    const runCmd = `docker run -d --name ${containerName} -v "${hostRootPath}:/root" "${image}" tail -f /dev/null`;
    console.log(`[compute] Starting background container: ${runCmd}`);
    return new Promise((resolve, reject) => {
        exec(runCmd, (err) => {
            if (err) reject(err);
            else resolve(containerName);
        });
    });
};

const ensureContainer = async (sessionId, image = 'python:3.10-alpine') => {
    const containerName = getContainerName(sessionId);
    
    // Check if container exists
    const checkCmd = `docker ps -a --filter "name=^/${containerName}$" --format "{{.Names}} {{.Status}} {{.Image}}"`;
    return new Promise((resolve, reject) => {
        exec(checkCmd, (err, stdout) => {
            if (err) return reject(err);
            
            const output = stdout.trim();
            if (output) {
                const parts = output.split(' ');
                const isRunning = output.includes('Up');
                const containerImage = parts[parts.length - 1];
                
                if (containerImage !== image) {
                    console.log(`[compute] Container ${containerName} image mismatch (current: ${containerImage}, requested: ${image}). Recreating...`);
                    exec(`docker rm -f ${containerName}`, (rmErr) => {
                        startContainer(containerName, image, sessionId).then(resolve).catch(reject);
                    });
                } else if (!isRunning) {
                    console.log(`[compute] Container ${containerName} exists but is stopped. Starting...`);
                    exec(`docker start ${containerName}`, (startErr) => {
                        if (startErr) reject(startErr);
                        else resolve(containerName);
                    });
                } else {
                    resolve(containerName);
                }
            } else {
                startContainer(containerName, image, sessionId).then(resolve).catch(reject);
            }
        });
    });
};

const executeInContainer = (containerName, cmd, timeout = 30000) => {
    const dockerCmd = `docker exec --user root ${containerName} sh -c ${JSON.stringify(cmd)}`;
    return new Promise((resolve, reject) => {
        exec(dockerCmd, { timeout }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
};

const copyToContainer = (containerName, hostPath, containerPath) => {
    const dockerCmd = `docker cp "${hostPath}" "${containerName}:${containerPath}"`;
    return new Promise((resolve, reject) => {
        exec(dockerCmd, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
            } else {
                resolve();
            }
        });
    });
};

const copyFromContainer = (containerName, containerPath, hostPath) => {
    const dockerCmd = `docker cp "${containerName}:${containerPath}" "${hostPath}"`;
    return new Promise((resolve, reject) => {
        exec(dockerCmd, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
            } else {
                resolve();
            }
        });
    });
};

// --- TOOL DEFINITIONS ---
const computeTools = [
    {
        name: 'run',
        description: 'Execute a command inside a sandboxed, ephemeral Docker container. You can pass files to be written in the workspace before execution. Use a consistent sessionId to persist files between runs.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to execute inside the container (e.g. "python script.py" or "ls -la")' },
                image: { type: 'string', description: 'The Docker image to use (default: "python:3.10-alpine" or "node:18-alpine")' },
                files: { 
                    type: 'object', 
                    description: 'Optional dictionary of files to create before running. Key is the filename, value is the file text content. E.g. {"script.py": "print(\'hello\')"}' 
                },
                sessionId: { type: 'string', description: 'Optional workspace identifier to persist state and files across multiple tool calls' },
                timeout: { type: 'number', description: 'Execution timeout in milliseconds (default: 30000)' }
            },
            required: ['command']
        }
    },
    {
        name: 'downloadToSandbox',
        description: 'Download a file from a URL directly into the sandbox session workspace.',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'HTTP/S URL of the file to download' },
                filename: { type: 'string', description: 'Name of the destination file inside the sandbox' },
                sessionId: { type: 'string', description: 'Session workspace identifier' }
            },
            required: ['url', 'filename', 'sessionId']
        }
    },
    {
        name: 'downloadable',
        description: 'Expose a file in the session workspace to a public downloadable URL that expires after a set time.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path of the file inside the session workspace' },
                sessionId: { type: 'string', description: 'Session workspace identifier' },
                expires: { type: 'number', description: 'Expiration time in seconds (default: 3600 / 1 hour)' }
            },
            required: ['path', 'sessionId']
        }
    },
    {
        name: 'write',
        description: 'Create or overwrite a file inside the sandbox session workspace.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path of the file to write' },
                content: { type: 'string', description: 'The text content to write to the file' },
                sessionId: { type: 'string', description: 'Session workspace identifier' }
            },
            required: ['path', 'content', 'sessionId']
        }
    },
    {
        name: 'read',
        description: 'Read the contents of a file inside the sandbox session workspace. Supports line range selection.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path of the file to read' },
                sessionId: { type: 'string', description: 'Session workspace identifier' },
                from: { type: 'number', description: 'Optional starting line number to read (1-indexed)' },
                to: { type: 'number', description: 'Optional ending line number to read (inclusive, 1-indexed)' }
            },
            required: ['path', 'sessionId']
        }
    },
    {
        name: 'search',
        description: 'Search for text patterns using regex within files in the sandbox workspace.',
        parameters: {
            type: 'object',
            properties: {
                searchRegex: { type: 'string', description: 'Regex pattern to search for in file contents (e.g. "function .*")' },
                pathsRegex: { 
                    type: 'array', 
                    items: { type: 'string' },
                    description: 'Optional array of regex patterns to filter target file paths (e.g. [".*\\\\.js$"])' 
                },
                sessionId: { type: 'string', description: 'Session workspace identifier' }
            },
            required: ['searchRegex', 'sessionId']
        }
    },
    {
        name: 'list',
        description: 'List files and directories inside the sandbox session workspace.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Optional relative path to list (defaults to session root)' },
                sessionId: { type: 'string', description: 'Session workspace identifier' }
            },
            required: ['sessionId']
        }
    },
    {
        name: 'copy',
        description: 'Copy a file inside the sandbox session workspace.',
        parameters: {
            type: 'object',
            properties: {
                src: { type: 'string', description: 'Source relative path' },
                dest: { type: 'string', description: 'Destination relative path' },
                sessionId: { type: 'string', description: 'Session workspace identifier' }
            },
            required: ['src', 'dest', 'sessionId']
        }
    },
    {
        name: 'move',
        description: 'Move or rename a file inside the sandbox session workspace.',
        parameters: {
            type: 'object',
            properties: {
                src: { type: 'string', description: 'Source relative path' },
                dest: { type: 'string', description: 'Destination relative path' },
                sessionId: { type: 'string', description: 'Session workspace identifier' }
            },
            required: ['src', 'dest', 'sessionId']
        }
    },
    {
        name: 'remove',
        description: 'Remove a file or directory inside the sandbox session workspace.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path to remove' },
                recursive: { type: 'boolean', description: 'Whether to remove recursively if directory (default: false)' },
                sessionId: { type: 'string', description: 'Session workspace identifier' }
            },
            required: ['path', 'sessionId']
        }
    },
    {
        name: 'patch',
        description: 'Search and replace text inside a file in the sandbox session workspace.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Relative path of the file to patch' },
                patches: {
                    type: 'array',
                    description: 'Array of search-and-replace patches to apply in order',
                    items: {
                        type: 'object',
                        properties: {
                            find: { type: 'string', description: 'The exact string to search for' },
                            replace: { type: 'string', description: 'The replacement string' }
                        },
                        required: ['find', 'replace']
                    }
                },
                sessionId: { type: 'string', description: 'Session workspace identifier' }
            },
            required: ['path', 'patches', 'sessionId']
        }
    },
    {
        name: 'convertMarkdown',
        description: 'Convert document files (PDF, PPTX, DOCX, XLSX, HTML, etc.) into Markdown (.md) files.',
        parameters: {
            type: 'object',
            properties: {
                paths: { 
                    type: 'array', 
                    items: { type: 'string' },
                    description: 'Array of relative file paths in the sandbox workspace to convert' 
                },
                sessionId: { type: 'string', description: 'Session workspace identifier' }
            },
            required: ['paths', 'sessionId']
        }
    },
    {
        name: 'copyFromHost',
        description: 'Copy a file or directory from the host filesystem into the sandbox session workspace.',
        parameters: {
            type: 'object',
            properties: {
                hostPath: { type: 'string', description: 'Absolute or relative path of the file or directory on the host filesystem' },
                sandboxPath: { type: 'string', description: 'Destination relative path inside the sandbox workspace' },
                sessionId: { type: 'string', description: 'Session workspace identifier' }
            },
            required: ['hostPath', 'sandboxPath', 'sessionId']
        }
    }
];

// --- TOOL LISTENERS ---

// 1. Run in Sandbox
server.listen('*', 'run', async (req, res) => {
    const { command, image = 'python:3.10-alpine', files, sessionId, timeout = 30000 } = req.data;
    let tempDir = null;
    
    try {
        const containerName = await ensureContainer(sessionId, image);
        
        // Write files to workspace if provided
        if (files && typeof files === 'object') {
            tempDir = getHostTempPath();
            for (const [filename, content] of Object.entries(files)) {
                const tempFilePath = path.join(tempDir, filename);
                const parentDir = path.dirname(tempFilePath);
                if (!fs.existsSync(parentDir)) {
                    fs.mkdirSync(parentDir, { recursive: true });
                }
                fs.writeFileSync(tempFilePath, content, 'utf8');
                
                const containerPath = getSafeContainerPath(filename);
                const containerParentDir = path.posix.dirname(containerPath);
                
                // Ensure container parent directory exists
                await executeInContainer(containerName, `mkdir -p "${containerParentDir}"`);
                
                // Copy to container
                await copyToContainer(containerName, tempFilePath, containerPath);
            }
        }
        
        // Execute the command in the persistent container's `/root` directory
        const dockerCmd = `docker exec --user root -w /root ${containerName} sh -c ${JSON.stringify(command)}`;
        console.log(`[compute] Executing docker exec: ${dockerCmd}`);
        
        exec(dockerCmd, { timeout }, (error, stdout, stderr) => {
            res.send({
                success: !error,
                stdout: stdout,
                stderr: stderr,
                exitCode: error ? error.code : 0,
                error: error ? error.message : null
            });
        });
        
    } catch (e) {
        console.error('[compute] Run error:', e.message);
        res.send({ success: false, error: e.message });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

// 2. Download File to Sandbox
server.listen('*', 'downloadToSandbox', async (req, res) => {
    const { url, filename, sessionId } = req.data;
    let tempDir = null;
    try {
        const containerName = await ensureContainer(sessionId);
        const containerPath = getSafeContainerPath(filename);
        
        tempDir = getHostTempPath();
        const tempFile = path.join(tempDir, path.basename(filename));
        
        const isUrl = url.startsWith('http://') || url.startsWith('https://');
        
        if (isUrl) {
            console.log(`[compute] Downloading URL on host: ${url} -> ${tempFile}`);
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream',
                timeout: 15000
            });
            
            const writer = fs.createWriteStream(tempFile);
            response.data.pipe(writer);
            
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
        } else {
            console.log(`[compute] Copying local host file: ${url} -> ${tempFile}`);
            if (!fs.existsSync(url)) {
                return res.send({ success: false, error: `Local host file not found: ${url}` });
            }
            fs.copyFileSync(url, tempFile);
        }
        
        // Ensure container parent dir exists
        const containerParentDir = path.posix.dirname(containerPath);
        await executeInContainer(containerName, `mkdir -p "${containerParentDir}"`);
        
        // Copy to container
        await copyToContainer(containerName, tempFile, containerPath);
        res.send({ success: true, filepath: filename });
        
    } catch (e) {
        console.error('[compute] Download error:', e.message);
        res.send({ success: false, error: e.message });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

// 3. Expose as Downloadable URL
server.listen('*', 'downloadable', async (req, res) => {
    const { path: relPath, sessionId, expires = 3600 } = req.data;
    
    try {
        const containerName = await ensureContainer(sessionId);
        const containerPath = getSafeContainerPath(relPath);
        
        // Define destination in console public folder
        const consoleDownloadsDir = path.resolve(__dirname, '../console/public/downloads');
        if (!fs.existsSync(consoleDownloadsDir)) {
            fs.mkdirSync(consoleDownloadsDir, { recursive: true });
        }
        
        const token = crypto.randomBytes(16).toString('hex');
        const originalFilename = path.posix.basename(containerPath);
        const destFilename = `${token}_${originalFilename}`;
        const destPath = path.join(consoleDownloadsDir, destFilename);
        
        // Copy file from container to host destPath
        await copyFromContainer(containerName, containerPath, destPath);
        console.log(`[compute] Exposing file from container: ${containerPath} -> ${destPath}`);
        
        // Schedule cleanup
        setTimeout(() => {
            try {
                if (fs.existsSync(destPath)) {
                    fs.unlinkSync(destPath);
                    console.log(`[compute] Expired file deleted: ${destFilename}`);
                }
            } catch (err) {
                console.error(`[compute] Error cleaning up expired file ${destFilename}:`, err.message);
            }
        }, expires * 1000);
        
        const downloadUrl = `http://localhost:${CONSOLE_PORT}/downloads/${destFilename}`;
        
        res.send({
            success: true,
            url: downloadUrl,
            expiresAt: new Date(Date.now() + expires * 1000).toISOString()
        });
        
    } catch (e) {
        console.error('[compute] Expose file error:', e.message);
        res.send({ success: false, error: e.message });
    }
});

// 4. Write file in sandbox
server.listen('*', 'write', async (req, res) => {
    const { path: relPath, content, sessionId } = req.data;
    let tempDir = null;
    try {
        const containerName = await ensureContainer(sessionId);
        const containerPath = getSafeContainerPath(relPath);
        
        // Create host temp file
        tempDir = getHostTempPath();
        const tempFile = path.join(tempDir, path.basename(relPath));
        fs.writeFileSync(tempFile, content, 'utf8');
        
        // Ensure parent directory exists in container
        const containerParentDir = path.posix.dirname(containerPath);
        await executeInContainer(containerName, `mkdir -p "${containerParentDir}"`);
        
        // Copy to container
        await copyToContainer(containerName, tempFile, containerPath);
        
        console.log(`[compute] Wrote file to container: ${containerPath}`);
        res.send({ success: true, filepath: relPath });
    } catch (e) {
        console.error('[compute] Write error:', e.message);
        res.send({ success: false, error: e.message });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

// 5. Read file in sandbox
server.listen('*', 'read', async (req, res) => {
    const { path: relPath, sessionId, from, to } = req.data;
    let tempDir = null;
    try {
        const containerName = await ensureContainer(sessionId);
        const containerPath = getSafeContainerPath(relPath);
        
        tempDir = getHostTempPath();
        const tempFile = path.join(tempDir, 'read_file');
        
        // Copy file from container to host temp file
        await copyFromContainer(containerName, containerPath, tempFile);
        
        let content = fs.readFileSync(tempFile, 'utf8');
        
        if (from !== undefined || to !== undefined) {
            const lines = content.split('\n');
            const startIdx = from !== undefined ? Math.max(0, from - 1) : 0;
            const endIdx = to !== undefined ? Math.min(lines.length, to) : lines.length;
            content = lines.slice(startIdx, endIdx).join('\n');
        }
        
        res.send({ success: true, content });
    } catch (e) {
        console.error('[compute] Read error:', e.message);
        res.send({ success: false, error: e.message });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

// 6. List files in sandbox path
server.listen('*', 'list', async (req, res) => {
    const { path: relPath = '', sessionId } = req.data;
    let tempDir = null;
    try {
        const containerName = await ensureContainer(sessionId);
        const containerPath = getSafeContainerPath(relPath);
        
        tempDir = getHostTempPath();
        
        // We copy the target directory or file from the container to host tempDir
        const destName = relPath ? path.posix.basename(containerPath) : 'root';
        const hostCopyDest = path.join(tempDir, destName);
        
        await copyFromContainer(containerName, containerPath, hostCopyDest);
        
        const stat = fs.statSync(hostCopyDest);
        if (!stat.isDirectory()) {
            return res.send({ success: false, error: `Path is a file, not a directory: ${relPath}` });
        }
        
        const files = fs.readdirSync(hostCopyDest).map(name => {
            const fullPath = path.join(hostCopyDest, name);
            const fileStat = fs.statSync(fullPath);
            return {
                name,
                path: path.join(relPath, name),
                isDir: fileStat.isDirectory(),
                size: fileStat.size,
                mtime: fileStat.mtime
            };
        });
        res.send({ success: true, files });
    } catch (e) {
        console.error('[compute] List error:', e.message);
        res.send({ success: false, error: e.message });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

// 7. Copy file in sandbox
server.listen('*', 'copy', async (req, res) => {
    const { src, dest, sessionId } = req.data;
    try {
        const containerName = await ensureContainer(sessionId);
        const srcPath = getSafeContainerPath(src);
        const destPath = getSafeContainerPath(dest);
        
        // Ensure parent of dest exists
        const destParentDir = path.posix.dirname(destPath);
        await executeInContainer(containerName, `mkdir -p "${destParentDir}"`);
        
        // Run cp inside container
        await executeInContainer(containerName, `cp -r "${srcPath}" "${destPath}"`);
        console.log(`[compute] Copied in container: ${srcPath} -> ${destPath}`);
        res.send({ success: true });
    } catch (e) {
        console.error('[compute] Copy error:', e.message);
        res.send({ success: false, error: e.message });
    }
});

// 8. Move/rename file in sandbox
server.listen('*', 'move', async (req, res) => {
    const { src, dest, sessionId } = req.data;
    try {
        const containerName = await ensureContainer(sessionId);
        const srcPath = getSafeContainerPath(src);
        const destPath = getSafeContainerPath(dest);
        
        // Ensure parent of dest exists
        const destParentDir = path.posix.dirname(destPath);
        await executeInContainer(containerName, `mkdir -p "${destParentDir}"`);
        
        // Run mv inside container
        await executeInContainer(containerName, `mv "${srcPath}" "${destPath}"`);
        console.log(`[compute] Moved in container: ${srcPath} -> ${destPath}`);
        res.send({ success: true });
    } catch (e) {
        console.error('[compute] Move error:', e.message);
        res.send({ success: false, error: e.message });
    }
});

// 9. Remove file/directory in sandbox
server.listen('*', 'remove', async (req, res) => {
    const { path: relPath, recursive = false, sessionId } = req.data;
    try {
        const containerName = await ensureContainer(sessionId);
        const targetPath = getSafeContainerPath(relPath);
        
        const flag = recursive ? '-rf' : '-f';
        await executeInContainer(containerName, `rm ${flag} "${targetPath}"`);
        console.log(`[compute] Removed in container: ${targetPath}`);
        res.send({ success: true });
    } catch (e) {
        console.error('[compute] Remove error:', e.message);
        res.send({ success: false, error: e.message });
    }
});

// 10. Patch file in sandbox (search-and-replace)
server.listen('*', 'patch', async (req, res) => {
    const { path: relPath, patches, sessionId } = req.data;
    let tempDir = null;
    try {
        const containerName = await ensureContainer(sessionId);
        const containerPath = getSafeContainerPath(relPath);
        
        tempDir = getHostTempPath();
        const tempFile = path.join(tempDir, path.basename(relPath));
        
        // Copy from container
        await copyFromContainer(containerName, containerPath, tempFile);
        
        let content = fs.readFileSync(tempFile, 'utf8');
        
        for (let i = 0; i < patches.length; i++) {
            const { find, replace } = patches[i];
            if (!content.includes(find)) {
                return res.send({ success: false, error: `Pattern to replace not found: "${find}"` });
            }
            content = content.replace(find, replace);
        }
        
        fs.writeFileSync(tempFile, content, 'utf8');
        
        // Copy back to container
        await copyToContainer(containerName, tempFile, containerPath);
        console.log(`[compute] Patched file in container: ${containerPath}`);
        res.send({ success: true });
    } catch (e) {
        console.error('[compute] Patch error:', e.message);
        res.send({ success: false, error: e.message });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

// Helper for search: recursively get files
const getAllFiles = (dir, baseDir) => {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
            results = results.concat(getAllFiles(fullPath, baseDir));
        } else {
            const relPath = path.relative(baseDir, fullPath);
            results.push({ fullPath, relPath });
        }
    });
    return results;
};

// 11. Search in sandbox using regex
server.listen('*', 'search', async (req, res) => {
    const { searchRegex, pathsRegex, sessionId } = req.data;
    let tempDir = null;
    try {
        const containerName = await ensureContainer(sessionId);
        
        tempDir = getHostTempPath();
        const hostCopyDest = path.join(tempDir, 'root');
        
        // Copy /root from container to host tempDir/root
        await copyFromContainer(containerName, '/root', hostCopyDest);
        
        const allFiles = getAllFiles(hostCopyDest, hostCopyDest);
        
        let pathRegexObjs = null;
        if (pathsRegex && Array.isArray(pathsRegex)) {
            pathRegexObjs = pathsRegex.map(r => new RegExp(r));
        }
        
        const contentRegex = new RegExp(searchRegex);
        const matches = [];
        
        for (const file of allFiles) {
            // Apply path filtering regexes
            if (pathRegexObjs) {
                const matchesFilter = pathRegexObjs.some(regex => regex.test(file.relPath));
                if (!matchesFilter) continue;
            }
            
            // Read and search file content
            const content = fs.readFileSync(file.fullPath, 'utf8');
            if (contentRegex.test(content)) {
                const lines = content.split('\n');
                lines.forEach((lineText, idx) => {
                    if (contentRegex.test(lineText)) {
                        matches.push({
                            path: file.relPath,
                            line: idx + 1,
                            content: lineText
                        });
                    }
                });
            }
        }
        
        res.send({ success: true, matches: matches.slice(0, 100) });
    } catch (e) {
        console.error('[compute] Search error:', e.message);
        res.send({ success: false, error: e.message });
    } finally {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});

// --- CONVERTER SETUP ---
const CONVERTER_IMAGE = 'pulseflake-converter';
const DOCKERFILE_CONTENT = `FROM python:3.10-slim
RUN pip install --no-cache-dir "markitdown[all]"
WORKDIR /app
`;

// Write Dockerfile to compute directory
const dockerfilePath = path.join(__dirname, 'converter.Dockerfile');
fs.writeFileSync(dockerfilePath, DOCKERFILE_CONTENT, 'utf8');

let isConverterReady = false;

const ensureConverterImage = async () => {
    if (isConverterReady) return true;
    return new Promise((resolve) => {
        exec(`docker image inspect ${CONVERTER_IMAGE}`, (err) => {
            if (!err) {
                isConverterReady = true;
                return resolve(true);
            }
            console.log(`[compute] Docker image ${CONVERTER_IMAGE} not found. Building it...`);
            exec(`docker build -t ${CONVERTER_IMAGE} -f "${dockerfilePath}" "${__dirname}"`, (buildErr) => {
                if (buildErr) {
                    console.error('[compute] Failed to build converter image:', buildErr.message);
                    resolve(false);
                } else {
                    console.log(`[compute] Successfully built ${CONVERTER_IMAGE} image.`);
                    isConverterReady = true;
                    resolve(true);
                }
            });
        });
    });
};

// Start ensure image check in background
ensureConverterImage();

// 12. Convert files to Markdown
server.listen('*', 'convertMarkdown', async (req, res) => {
    const { paths: relPaths, sessionId } = req.data;
    try {
        const containerName = await ensureContainer(sessionId);
        
        if (!isConverterReady) {
            console.log('[compute] Converter image not ready yet, waiting for build...');
            const ready = await ensureConverterImage();
            if (!ready) {
                return res.send({ success: false, error: 'Converter docker image could not be built.' });
            }
        }
        
        const uid = process.getuid ? process.getuid() : 1000;
        const gid = process.getgid ? process.getgid() : 1000;
        const userOption = `--user ${uid}:${gid}`;
        
        const results = [];
        const paths = Array.isArray(relPaths) ? relPaths : [relPaths];
        
        for (const relPath of paths) {
            let fileTempDir = null;
            try {
                const containerSrcPath = getSafeContainerPath(relPath);
                
                // Output path replaces extension with .md
                const parsedPath = path.parse(relPath);
                const outRelPath = path.posix.join(parsedPath.dir, `${parsedPath.name}.md`);
                const containerDestPath = getSafeContainerPath(outRelPath);
                
                fileTempDir = getHostTempPath();
                const tempSrcFile = path.join(fileTempDir, 'input_file');
                const tempDestFile = path.join(fileTempDir, 'output.md');
                
                // Copy file from container to host temp dir
                await copyFromContainer(containerName, containerSrcPath, tempSrcFile);
                
                // Run docker run on host temp dir
                const dockerCmd = `docker run --rm ${userOption} -v "${fileTempDir}":/app -w /app ${CONVERTER_IMAGE} sh -c "markitdown input_file > output.md"`;
                console.log(`[compute] Converting file via converter container: ${dockerCmd}`);
                
                await new Promise((resolve, reject) => {
                    exec(dockerCmd, { timeout: 60000 }, (error, stdout, stderr) => {
                        if (error) {
                            reject(new Error(stderr || error.message));
                        } else {
                            resolve();
                        }
                    });
                });
                
                // Ensure parent of dest exists in container
                const destParentDir = path.posix.dirname(containerDestPath);
                await executeInContainer(containerName, `mkdir -p "${destParentDir}"`);
                
                // Copy converted file back to container
                await copyToContainer(containerName, tempDestFile, containerDestPath);
                
                results.push({ 
                    path: relPath, 
                    outputPath: outRelPath, 
                    success: true 
                });
            } catch (err) {
                results.push({ 
                    path: relPath, 
                    success: false, 
                    error: err.message
                });
            } finally {
                if (fileTempDir && fs.existsSync(fileTempDir)) {
                    fs.rmSync(fileTempDir, { recursive: true, force: true });
                }
            }
        }
        
        res.send({ success: true, results });
    } catch (e) {
        console.error('[compute] ConvertMarkdown error:', e.message);
        res.send({ success: false, error: e.message });
    }
});

// 13. Copy from Host to Sandbox
server.listen('*', 'copyFromHost', async (req, res) => {
    const { hostPath, sandboxPath, sessionId } = req.data;
    try {
        const containerName = await ensureContainer(sessionId);
        const containerPath = getSafeContainerPath(sandboxPath);
        
        if (!fs.existsSync(hostPath)) {
            return res.send({ success: false, error: `Host path not found: ${hostPath}` });
        }
        
        const stat = fs.statSync(hostPath);
        
        // Ensure parent of containerPath exists
        const containerParentDir = path.posix.dirname(containerPath);
        await executeInContainer(containerName, `mkdir -p "${containerParentDir}"`);
        
        // Use docker cp to copy directly from hostPath to containerName:containerPath
        await copyToContainer(containerName, hostPath, containerPath);
        console.log(`[compute] Copied from host to container: ${hostPath} -> ${containerPath}`);
        res.send({ success: true });
    } catch (e) {
        console.error('[compute] CopyFromHost error:', e.message);
        res.send({ success: false, error: e.message });
    }
});

// --- CONNECT ---
server.connect(TOOLS_SOCKET_PATH, async () => {
    console.log('[compute] Connected to Tools; registering capabilities...');
    try {
        await server.request('tools', 'register', computeTools);
        console.log('[compute] Compute tools registered.');
    } catch (err) {
        console.error('[compute] Tool registration failed:', err.message);
    }
});

server.start();
// trigger restart
