require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const server = new (require('#UnixSocket'))("device");
const deviceApp = require('./main');

// Start the internal device servers (WS on 7778, HTTP on 7777)
deviceApp.start(server);

// Register listeners for each tool defined in main.js
for (const [method, handler] of Object.entries(deviceApp.listeners)) {
    server.listen('*', method, async (req, res) => {
        console.log(`[device] Handling tool: ${method}`, req.data);
        const result = await handler(server, req.data);
        res.send(result);
    });
}

const toolsSocketPath = require('path').resolve(__dirname, '../tools/tools.sock');

server.connect(toolsSocketPath).then(async() => {
    console.log('[device] Connected to tools server.');
    const fs = require('fs');
    const path = require('path');
    let instruction = "";
    try {
        const instPath = path.resolve(__dirname, 'instruction.txt');
        if (fs.existsSync(instPath)) {
            instruction = fs.readFileSync(instPath, 'utf8').trim();
        }
    } catch (e) {
        console.error('[device] Failed to read instruction.txt:', e.message);
    }

    const deviceTools = Object.entries(deviceApp.schema).map(([method, definition]) => ({
        parameters: {
            type: definition.type,
            properties: definition.properties,
            required: definition.required
        },
        description: definition.description,
        name: method
    }));

    await server.request('tools', 'register', { instruction, tools: deviceTools }).then(() => {
        console.log('[device] Registered tools with tools server.');
    }).catch(err => {
        console.error('[device] Failed to register tools:', err);
    });
});

server.start().then(() => {
    console.log('[device] Server is running via Unix Socket.');
}).catch(err => {
    console.error('[device] Failed to start server:', err);
});