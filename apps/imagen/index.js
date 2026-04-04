require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const path = require('path');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const server = new (require('#UnixSocket'))("imagen");

const AGENT_SOCKET_PATH = path.resolve(__dirname, '../agent/agent.sock');
const TOOLS_SOCKET_PATH = path.resolve(__dirname, '../tools/tools.sock');

// --- 1. TOOL DEFINITIONS ---
const imagenTools = [
    {
        name: 'generate_image',
        description: 'Generates an image based on a text prompt using Pollinations AI (Flux model).',
        parameters: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'The description of the image to generate.' },
                width: { type: 'number', default: 1024, description: 'Width of the image.' },
                height: { type: 'number', default: 1024, description: 'Height of the image.' },
                fileName: { type: 'string', description: 'Optional custom filename (without extension).' }
            },
            required: ['prompt']
        }
    }
];

// --- 2. CONNECT TO TOOLS ---
server.connect(TOOLS_SOCKET_PATH, async () => {
    console.log('[imagen] Connected to Tools; registering capabilities...');
    try {
        await server.request('tools', 'register', imagenTools);
        console.log('[imagen] Tools registered.');
    } catch (err) {
        console.error('[imagen] Failed to register tools:', err.message);
    }
    server.broadcast('register', imagenTools);
});

// --- 3. CONNECT TO AGENT ---
server.connect(AGENT_SOCKET_PATH).then(() => {
    console.log('[imagen] Connected to agent server.');
}).catch(err => {
    console.error('[imagen] Failed to connect to agent server:', err.message);
});

// --- 4. TOOL LISTENERS ---
server.listen('*', 'generate_image', async (req, res) => {
    const { prompt, width = 1024, height = 1024, fileName = `gen_${Date.now()}` } = req.data || {};
    console.log(`[imagen] Generating image for prompt: "${prompt}" [${width}x${height}]`);

    try {
        const apiKey = process.env.IMAGEN_API_KEY;
        const pollUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?key=${apiKey}&model=flux&width=${width}&height=${height}&seed=${Math.floor(Math.random() * 1000000)}&enhance=true`;

        const response = await fetch(pollUrl);
        if (!response.ok) {
            throw new Error(`Pollinations API error: ${response.statusText}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const mimeType = response.headers.get('content-type') || 'image/jpeg';
        const ext = 'jpg'; // Flux usually returns jpeg or it's a safe default for web
        
        const publicDir = path.join(__dirname, 'public');
        const relativeUrlPath = `/apps/imagen/public/${fileName}.${ext}`;
        const fullPath = path.join(publicDir, `${fileName}.${ext}`);

        // Ensure public dir exists
        if (!fs.existsSync(publicDir)) {
            fs.mkdirSync(publicDir, { recursive: true });
        }

        fs.writeFileSync(fullPath, buffer);
        console.log(`[imagen] Image saved to ${fullPath}`);

        res.send({
            success: true,
            path: fullPath,
            url: relativeUrlPath,
            mimeType,
            prompt
        });
    } catch (err) {
        console.error('[imagen] Error generating image:', err);
        res.send({ success: false, error: err.message });
    }
});

// --- 5. START SERVER ---
server.start().then(() => {
    console.log('🚀 Imagen app server is running.');
});
