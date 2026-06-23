require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const path = require('path');
const fs = require('fs');
const server = new (require('#UnixSocket'))("university");
const UAJYScraper = require('./class');

const AGENT_SOCKET_PATH = path.resolve(__dirname, '../agent/agent.sock');
const TOOLS_SOCKET_PATH = path.resolve(__dirname, '../tools/tools.sock');
const CONFIG_PATH = path.resolve(__dirname, 'config.json');

const instances = new Map();

// --- 1. CONFIG PERSISTENCE ---
const saveConfig = () => {
    const data = {};
    for (const [username, scraper] of instances) {
        data[username] = {
            username: scraper.username,
            password: scraper.password
        };
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
};

const loadConfig = async () => {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            for (const username in data) {
                const scraper = new UAJYScraper(data[username].username, data[username].password);
                instances.set(username, scraper);
            }
            console.log(`[university] Loaded ${Object.keys(data).length} preserved session(s).`);
        }
    } catch (error) {
        console.error('[university] Failed to load sessions config:', error);
    }
};

const getScraper = async (username) => {
    return instances.get(username);
};

// --- 2. TOOL DEFINITIONS ---
const universityTools = [
    {
        name: 'login',
        description: 'Login to UAJY student portal (Moodle/Kuliah). Required before other calls.',
        parameters: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Student ID/Username' },
                password: { type: 'string', description: 'Student Password' }
            },
            required: ['username', 'password']
        }
    },
    {
        name: 'getCourses',
        description: 'Retrieve the list of active courses for the logged-in user.',
        parameters: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Student ID/Username' }
            },
            required: ['username']
        }
    },
    {
        name: 'getTasks',
        description: 'Retrieve pending tasks and calendar events from the portal.',
        parameters: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Student ID/Username' }
            },
            required: ['username']
        }
    },
    {
        name: 'getCourseContent',
        description: 'Retrieve content, modules, and links for a specific course by its ID.',
        parameters: {
            type: 'object',
            properties: {
                username: { type: 'string', description: 'Student ID/Username' },
                courseId: { type: 'string', description: 'The numeric course ID' }
            },
            required: ['username', 'courseId']
        }
    },
    {
        name: 'listLoggedInSessions',
        description: 'List all currently logged-in student sessions/usernames that are active and can be used directly without re-entering credentials.',
        parameters: {
            type: 'object',
            properties: {}
        }
    }
];

// --- 3. CONNECT TO TOOLS ---
server.connect(TOOLS_SOCKET_PATH, async () => {
    console.log('[university] Connected to Tools; registering capabilities...');
    let instruction = "";
    try {
        const instPath = path.resolve(__dirname, 'instruction.txt');
        if (fs.existsSync(instPath)) {
            instruction = fs.readFileSync(instPath, 'utf8').trim();
        }
    } catch (e) {
        console.error('[university] Failed to read instruction.txt:', e.message);
    }
    try {
        await server.request('tools', 'register', { instruction, tools: universityTools });
        console.log('[university] University tools registered.');
    } catch (err) {
        console.error('[university] Registration error:', err.message);
    }
    server.broadcast('register', { instruction, tools: universityTools });
});

// --- 4. CONNECT TO AGENT ---
server.connect(AGENT_SOCKET_PATH).then(() => {
    console.log('[university] Connected to agent for status updates.');
}).catch(err => {
    console.error('[university] Agent connection failed:', err.message);
});

// --- 5. TOOL LISTENERS ---

// Helper function for auto-relogin logic
const withAutoLogin = async (username, res, action) => {
    const scraper = await getScraper(username);
    if (!scraper) return res.send({ error: 'Not logged in. Use university.login first.' });
    
    try {
        const result = await action(scraper);
        res.send({ success: true, ...result });
    } catch (err) {
        if (err.message.includes('Not logged in')) {
            try {
                console.log(`[university] Session expired for ${username}, re-logging in...`);
                await scraper.login();
                const result = await action(scraper);
                res.send({ success: true, ...result });
            } catch (reLoginErr) {
                res.send({ error: 'Re-login failed: ' + reLoginErr.message });
            }
        } else {
            res.send({ error: err.message });
        }
    }
};

server.listen('*', 'login', async (req, res) => {
    const { username, password } = req.data;
    try {
        const scraper = new UAJYScraper(username, password);
        await scraper.login();
        instances.set(username, scraper);
        saveConfig();
        res.send({ success: true, message: `Login successful for ${username}` });
    } catch (error) {
        res.send({ error: 'Login failed: ' + error.message });
    }
});

server.listen('*', 'getCourses', async (req, res) => {
    await withAutoLogin(req.data.username, res, async (scraper) => {
        const courses = await scraper.getCourses();
        return { courses };
    });
});

server.listen('*', 'getTasks', async (req, res) => {
    await withAutoLogin(req.data.username, res, async (scraper) => {
        const tasks = await scraper.getTasks();
        return { tasks };
    });
});

server.listen('*', 'getCourseContent', async (req, res) => {
    const { username, courseId } = req.data;
    await withAutoLogin(username, res, async (scraper) => {
        const content = await scraper.getCourseContent(courseId);
        return { content };
    });
});

server.listen('*', 'listLoggedInSessions', async (req, res) => {
    try {
        const loggedInUsernames = Array.from(instances.keys());
        res.send({ success: true, sessions: loggedInUsernames });
    } catch (err) {
        console.error('[university] Error listing sessions:', err);
        res.send({ success: false, error: err.message });
    }
});

// --- 6. START SERVER ---
loadConfig().then(() => {
    server.start().then(() => {
        process.stdout.write('\x1b]1337;SetLabel=university\x07');
        console.log('🏛️  University app (UAJY) is active.');
    });
});
