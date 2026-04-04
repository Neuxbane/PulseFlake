require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const path = require('path');
const server = new (require('#UnixSocket'))("template");

/**
 * [TEMPLATE APP]
 * This is a boilerplate for creating new micro-apps in the FuckingLonely ecosystem.
 * 
 * 1. Define your app name in the UnixSocket constructor above.
 * 2. Connect to the 'agent' and 'tools' sockets.
 * 3. Register your tools in the 'tools' connection callback.
 * 4. Implement your tool listeners.
 * 5. Broadcast events as needed.
 */

const AGENT_SOCKET_PATH = path.resolve(__dirname, '../agent/agent.sock');
const TOOLS_SOCKET_PATH = path.resolve(__dirname, '../tools/tools.sock');

// --- 1. TOOL DEFINITIONS ---
const templateTools = [
    {
        name: 'ping',
        description: 'A simple ping-pong tool to test connectivity.',
        parameters: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'Optional message to echo back.' }
            }
        }
    }
];

// --- 2. CONNECT TO TOOLS ---
server.connect(TOOLS_SOCKET_PATH, async () => {
    console.log('[template] Connected to Tools; registering capabilities...');
    
    // Register with the RAG server
    try {
        await server.request('tools', 'register', templateTools);
        console.log('[template] Tools registered with RAG server.');
    } catch (err) {
        console.error('[template] Failed to register tools:', err.message);
    }

    // Broadcast registration to any listening Agents
    server.broadcast('register', templateTools);
});

// --- 3. CONNECT TO AGENT ---
server.connect(AGENT_SOCKET_PATH).then(() => {
    console.log('[template] Connected to agent server for event broadcasting.');
    
    // Example: Broadcast an 'online' event
    server.broadcast('event', {
        type: 'status',
        source: 'template',
        content: 'Template app is now online',
        timestamp: new Date().toISOString()
    });
}).catch(err => {
    console.error('[template] Failed to connect to agent server:', err.message);
});

// --- 4. TOOL LISTENERS ---
/**
 * Listen for the 'ping' tool call.
 * The Agent will call this using 'template.ping'.
 */
server.listen('*', 'ping', async (req, res) => {
    const { message } = req.data || {};
    console.log(`[template] ping received: ${message || 'no message'}`);
    
    res.send({ 
        success: true, 
        reply: `Pong! ${message || ''}`,
        timestamp: new Date().toISOString()
    });
});

// --- 5. START SERVER ---
server.start().then(() => {
    console.log('🚀 Template app server is running.');
});
