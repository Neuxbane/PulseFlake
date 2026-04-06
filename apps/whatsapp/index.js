require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const server = new (require('#UnixSocket'))("whatsapp");

const appName = 'whatsapp';
const configPath = path.join(__dirname, 'config.json');

// --- CONFIG UTILITIES ---
let cachedConfig = { chats: [] };

const loadConfig = () => {
    if (fs.existsSync(configPath)) {
        try {
            const data = fs.readFileSync(configPath, 'utf8');
            cachedConfig = JSON.parse(data);
        } catch (e) {
            console.error(`[${appName}] Error reading config:`, e);
        }
    }
    return cachedConfig;
};

const saveConfig = (config) => {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
        cachedConfig = config;
    } catch (e) {
        console.error(`[${appName}] Error saving config:`, e);
    }
};

const updateChatInConfig = (chatId, chatName) => {
    const config = loadConfig();
    const existingIndex = config.chats.findIndex(c => c.id === chatId);
    
    if (existingIndex > -1) {
        const chat = config.chats.splice(existingIndex, 1)[0];
        chat.name = chatName;
        config.chats.unshift(chat);
    } else {
        config.chats.unshift({ id: chatId, name: chatName, allowAI: false });
    }
    saveConfig(config);
};

const isAIAllowed = (chatId) => {
    const config = loadConfig();
    const chat = config.chats.find(c => c.id === chatId);
    return chat ? chat.allowAI : false;
};

const getChatSettings = (chatId) => {
    const config = loadConfig();
    const chat = config.chats.find(c => c.id === chatId);
    const note = chat?.note || (chat?.notes && chat.notes.length > 0 ? chat.notes[chat.notes.length - 1].content : 'Author don\'t want to listen this whatsapp, just summarize silently using `addSummary(chatId, summary)`');
    const summary = chat?.summary || (chat?.summaries && chat.summaries.length > 0 ? chat.summaries[chat.summaries.length - 1].content : '');
    
    return { note, summary };
};

const updateChatSettings = (chatId, updates) => {
    const config = loadConfig();
    const chatIndex = config.chats.findIndex(c => c.id === chatId);
    if (chatIndex > -1) {
        const timestamp = getTimeInJakarta();
        const chat = config.chats[chatIndex];

        if (updates.note !== undefined) {
            if (!chat.notes) chat.notes = [];
            chat.notes.push({ content: updates.note, timestamp });
            chat.note = updates.note;
        }

        if (updates.summary !== undefined) {
            if (!chat.summaries) chat.summaries = [];
            chat.summaries.push({ content: updates.summary, timestamp });
            chat.summary = updates.summary;
        }

        Object.keys(updates).forEach(key => {
            if (key !== 'note' && key !== 'summary') {
                chat[key] = updates[key];
            }
        });

        saveConfig(config);
        return true;
    }
    return false;
};

// --- TIMEZONE UTILITIES ---
const JAKARTA_OFFSET = 7 * 60 * 60 * 1000;
const getTimeInJakarta = () => {
    const now = new Date();
    const jakartaTime = new Date(now.getTime() + JAKARTA_OFFSET);
    return jakartaTime.toISOString().replace('Z', '+07:00');
};

const getRecentMessages = async (chat, limit = 10) => {
    try {
        if (!chat || typeof chat.fetchMessages !== 'function') return [];
        const messages = await chat.fetchMessages({ limit });
        return messages.map(msg => ({
            from: msg.from,
            author: msg.author || msg.from,
            body: msg.body,
            timestamp: new Date(msg.timestamp * 1000 + JAKARTA_OFFSET).toISOString().replace('Z', '+07:00')
        }));
    } catch (e) {
        console.error(`[whatsapp] Error fetching messages:`, e);
        return [];
    }
};

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'fucking-lonely-whatsapp',
        dataPath: path.resolve(__dirname, './.wwebjs_auth')
    }),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

server.connect(path.resolve(__dirname, '../agent/agent.sock')).then(() => {
    console.log('[whatsapp] Connected to agent server.');
}).catch(err => {
    console.error('[whatsapp] Failed to connect to agent server:', err);
});

client.on('qr', (qr) => {
    console.log(`[${appName}] QR RECEIVED, saving to qr.txt`);
    qrcode.generate(qr, { small: true }, (status) => {
        fs.writeFileSync(path.resolve(__dirname, 'qr.txt'), status);
    });
});

client.on('ready', () => {
    console.log(`[${appName}] WhatsApp client is ready!`);
    if (fs.existsSync(path.resolve(__dirname, 'qr.txt'))) {
        fs.unlinkSync(path.resolve(__dirname, 'qr.txt'));
    }

    const toolsSocketPath = path.resolve(__dirname, '../tools/tools.sock');
    server.connect(toolsSocketPath, () => {
        const whatsappTools = [
            {
                name: 'whatsapp_sendMessage',
                description: 'Send a message to a WhatsApp chat or group. Only works if AI is allowed for that chat.',
                parameters: {
                    type: 'object',
                    properties: {
                        chatId: { type: 'string', description: "The WhatsApp ID of the recipient (e.g., '123456789@c.us')." },
                        content: { type: 'string', description: "The text content of the message." }
                    },
                    required: ['chatId', 'content']
                }
            },
            {
                name: 'whatsapp_readChats',
                description: 'Read the list of recent WhatsApp chats/conversations.',
                parameters: {
                    type: 'object',
                    properties: {
                        limit: { type: 'number', description: 'Number of chats to retrieve (default 10).' }
                    }
                }
            },
            {
                name: 'whatsapp_addNote',
                description: 'Add or update a note for a specific WhatsApp chat/group.',
                parameters: {
                    type: 'object',
                    properties: {
                        chatId: { type: 'string', description: 'The WhatsApp ID of the chat/group.' },
                        note: { type: 'string', description: 'The content of the note.' }
                    },
                    required: ['chatId', 'note']
                }
            },
            {
                name: 'whatsapp_addSummary',
                description: 'Add or update a conversation summary for a specific WhatsApp chat/group.',
                parameters: {
                    type: 'object',
                    properties: {
                        chatId: { type: 'string', description: 'The WhatsApp ID of the chat/group.' },
                        summary: { type: 'string', description: 'The summary of the conversation history.' }
                    },
                    required: ['chatId', 'summary']
                }
            }
        ];

        server.request('tools', 'register', whatsappTools).then(res => {
            console.log(`[whatsapp] Tools registered with RAG server:`, res);
        });
        server.broadcast('register', whatsappTools);
    });
});

client.on('message', async (message) => {
    console.log(`[whatsapp] Received message from ${message.from}: ${message.body}`);
    try {
        const contact = await message.getContact().catch(() => ({}));
        const chat = await message.getChat().catch(() => ({}));
        const chatId = message.from;
        const chatName = chat?.name || contact.pushname || contact.name || 'Unknown';

        updateChatInConfig(chatId, chatName);

        const settings = getChatSettings(chatId);
        const recentHistory = await getRecentMessages(chat, 11);

        const eventData = {
            type: 'whatsapp_message',
            author: contact.pushname || contact.name || message.from,
            authorId: message.from,
            content: message.body,
            chatId: chatId,
            chatName: chatName,
            isGroup: chat?.isGroup || false,
            AllowAIToAnswer: isAIAllowed(chatId),
            note: settings.note,
            summary: settings.summary,
            history: recentHistory,
            timestamp: getTimeInJakarta()
        };

        if (message.hasMedia) {
            try {
                const media = await message.downloadMedia();
                if (media) {
                    const resource = {
                        base64: media.data,
                        mimeType: media.mimetype,
                        filename: media.filename || 'whatsapp_media'
                    };
                    if (media.mimetype.startsWith('image/')) {
                        eventData.images = [resource];
                    } else {
                        eventData.documents = [resource];
                    }
                }
            } catch (mediaError) {
                console.error(`[whatsapp] Failed to download media:`, mediaError);
            }
        }

        server.broadcast('event', eventData);
    } catch (error) {
        console.error(`[whatsapp] Error processing message:`, error);
    }
});

server.listen('*', 'whatsapp_sendMessage', async (req, res) => {
    const { chatId, content } = req.data;
    try {
        if (!isAIAllowed(chatId)) {
            return res.send({ success: false, error: 'AI not allowed in this chat' });
        }
        const chat = await client.getChatById(chatId);
        await chat.sendMessage(content);
        res.send({ success: true, timestamp: getTimeInJakarta() });
    } catch (err) {
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'whatsapp_readChats', async (req, res) => {
    try {
        const limit = req.data.limit || 10;
        const chats = await client.getChats();
        const results = chats.slice(0, limit).map(c => {
            const chatId = c.id._serialized;
            const settings = getChatSettings(chatId);
            return {
                id: chatId,
                name: c.name,
                unreadCount: c.unreadCount,
                timestamp: c.timestamp,
                note: settings.note,
                summary: settings.summary
            };
        });
        res.send({ success: true, chats: results });
    } catch (err) {
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'whatsapp_addNote', async (req, res) => {
    const { chatId, note } = req.data;
    const success = updateChatSettings(chatId, { note });
    res.send({ success });
});

server.listen('*', 'whatsapp_addSummary', async (req, res) => {
    const { chatId, summary } = req.data;
    const success = updateChatSettings(chatId, { summary });
    res.send({ success });
});

server.start().then(() => {
    console.log('📱 WhatsApp app server is running.');
    client.initialize().catch(err => {
        console.error('❌ WhatsApp initialization error:', err);
    });
}).catch(err => {
    console.error('❌ Failed to start whatsapp app server:', err);
});
