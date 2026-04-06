const shellSessionManager = require('./shellSessionManager');
const serveBashScript = require('./serveBashScript');

module.exports = {
    start: (bus) => {
        shellSessionManager.startServer(7778, bus);
        serveBashScript(7777);
        console.log('[device] Ready');
    },
    listeners: {
        sendCommand: async (bus, data) => {
            const output = await shellSessionManager.sendCommand(data.workspaceName, data.command);
            return output;
        },
        readTerminalOutput: async (bus, data) => {
            const output = await shellSessionManager.readTerminalOutput(data.workspaceName);
            return output;
        },
        listSessions: (bus) => {
            const sessions = shellSessionManager.listSessions();
            return { ack: 'sessions listed', sessions };
        },
        listDir: async (bus, data) => {
            const result = await shellSessionManager.listDir(data.workspaceName, data && data.path ? data.path : "./");
            return { ack: 'dir listed', result };
        },
        createFile: async (bus, data) => {
            const result = await shellSessionManager.createFile(data.workspaceName, data.path, data.content);
            return { ack: 'file created', result };
        },
        deleteFile: async (bus, data) => {
            const result = await shellSessionManager.deleteFile(data.workspaceName, data.path);
            return { ack: 'file deleted', result };
        },
        updateFile: async (bus, data) => {
            const result = await shellSessionManager.updateFile(data.workspaceName, data.path, data.content);
            return { ack: 'file updated', result };
        },
        readFile: async (bus, data) => {
            const result = await shellSessionManager.readFile(data.workspaceName, data.path, data.lineFrom, data.lineTo);
            return { ack: 'file read', result };
        },
        applyPatch: async (bus, data) => {
            const result = await shellSessionManager.applyPatch(data.workspaceName, data.path, data.patch);
            return { ack: 'patch applied', result };
        },
    },
    schema: {
        sendCommand: {
            type: 'object',
            description: 'Send raw keys or commands to the terminal. Supports human-readable shortcuts (e.g., "Ctrl+C", "Alt+X", "Up", "Down", "Enter", "Space"). TIP: Use "Ctrl+A+A+D" to detach from screen. Standard text is auto-suffixed with Enter (\r).',
            properties: {
                workspaceName: { type: 'string', description: 'Workspace name' },
                command: { type: 'string', description: 'Command or key combination to send' }
            },
            required: ['workspaceName', 'command']
        },
        readTerminalOutput: {
            type: 'object',
            description: 'Read the latest 1024 characters of terminal output for a background process.',
            properties: {
                workspaceName: { type: 'string', description: 'Workspace name' }
            },
            required: ['workspaceName']
        },
        listSessions: {
            type: 'object',
            description: 'List all connected workspace sessions.',
            properties: {},
            required: []
        },
        listDir: {
            type: 'object',
            description: 'List directories and files at a given path, with line counts for files.',
            properties: {
                workspaceName: { type: 'string', description: 'Workspace name to send command to' },
                path: { type: 'string', description: 'Path to list', default: './' }
            },
            required: ['workspaceName']
        },
        createFile: {
            type: 'object',
            description: 'Create a file at a given path with provided content.',
            properties: {
                workspaceName: { type: 'string', description: 'Workspace name to send command to' },
                path: { type: 'string', description: 'Path to file' },
                content: { type: 'string', description: 'File content (multi-line string)' }
            },
            required: ['workspaceName', 'path', 'content']
        },
        deleteFile: {
            type: 'object',
            description: 'Delete a file at a given path.',
            properties: {
                workspaceName: { type: 'string', description: 'Workspace name to send command to' },
                path: { type: 'string', description: 'Path to file' }
            },
            required: ['workspaceName', 'path']
        },
        updateFile: {
            type: 'object',
            description: 'Replace the entire file content with new content.',
            properties: {
                workspaceName: { type: 'string', description: 'Workspace name to send command to' },
                path: { type: 'string', description: 'Path to file' },
                content: { type: 'string', description: 'New file content' }
            },
            required: ['workspaceName', 'path', 'content']
        },
        readFile: {
            type: 'object',
            description: 'Read a file from lineFrom to lineTo (inclusive, 1-based).',
            properties: {
                workspaceName: { type: 'string', description: 'Workspace name to send command to' },
                path: { type: 'string', description: 'Path to file' },
                lineFrom: { type: 'integer', description: 'Start line (1-based)', default: 1 },
                lineTo: { type: 'integer', description: 'End line (inclusive, 1-based)' }
            },
            required: ['workspaceName', 'path']
        },
        applyPatch: {
            type: 'object',
            description: 'Apply a simplified patch to a file. Use - for removal, + for addition, and plain lines as anchors.',
            properties: {
                workspaceName: { type: 'string', description: 'Workspace name to send command to' },
                path: { type: 'string', description: 'Path to the file to patch' },
                patch: { type: 'string', description: 'Simplified patch content. Format: "-" for line deletion, "+" for line addition, other lines are anchor context.' }
            },
            required: ['workspaceName', 'path', 'patch']
        },
    },
    interrupt: () => {}
};