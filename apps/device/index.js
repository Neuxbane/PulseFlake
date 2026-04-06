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

server.connect(toolsSocketPath).then(() => {
    console.log('[device] Connected to tools server.');
    
    // Register schemas in the registry
    for (const [name, definition] of Object.entries(deviceApp.schema)) {
        server.request('tools', 'register', {
            name,
            definition,
            identifier: 'device'
        }).then(res => {
            console.log(`[device] Registered tool: ${name}`, res);
        }).catch(err => {
            console.error(`[device] Failed to register tool: ${name}`, err.message);
        });
    }
});

server.start().then(() => {
    console.log('[device] Server is running via Unix Socket.');
}).catch(err => {
    console.error('[device] Failed to start server:', err);
});