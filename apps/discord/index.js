require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const path = require('path');
const server = new (require('#UnixSocket'))("discord");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// --- TIMEZONE UTILITIES (UTC+7 / Asia/Jakarta) ---
const JAKARTA_OFFSET = 7 * 60 * 60 * 1000; // UTC+7 in milliseconds

const getTimeInJakarta = () => {
    const now = new Date();
    const jakartaTime = new Date(now.getTime() + JAKARTA_OFFSET);
    return jakartaTime.toISOString().replace('Z', '+07:00');
};

server.connect(path.resolve(__dirname, '../agent/agent.sock')).then(() => {
    console.log('[discord] Connected to agent server for tool calls.');
}).catch(err => {
    console.error('[discord] Failed to connect to agent server:', err);
});

client.once('ready', () => {
    console.log(`[discord] Discord bot ready as ${client.user.tag}`);
    // Register tool with the tools app
    const path = require('path');
    const toolsSocketPath = path.resolve(__dirname, '../tools/tools.sock');
    server.connect(toolsSocketPath,() => {
        const discordTools = [
            {
                name: 'sendMessage',
                description: 'Send a message to a specific Discord channel, user, or server group.',
                parameters: {
                    type: 'object',
                    properties: {
                        channelId: { type: 'string', description: 'The ID of the channel to send the message to.' },
                        content: { type: 'string', description: 'Message content to send' },
                        files: { type: 'array', items: { type: 'string' }, description: 'A list of absolute file paths to upload as attachments. could be image' }
                    },
                    required: ['channelId', 'content']
                }
            },
            {
                name: 'addReaction',
                description: 'Add a reaction (emoji) to a specific message in a channel.',
                parameters: {
                    type: 'object',
                    properties: {
                        channelId: { type: 'string', description: 'The ID of the channel where the message is.' },
                        messageId: { type: 'string', description: 'The ID of the message to react to.' },
                        emoji: { type: 'string', description: 'The emoji to react with (e.g., "👍", "❤️", or a custom emoji name/ID).' }
                    },
                    required: ['channelId', 'messageId', 'emoji']
                }
            }
        ];

        // 1. Register with the Tools RAG server
        server.request('tools', 'register', discordTools).then(res => {
            console.log(`[discord] Tools registered with RAG server:`, res);
        });

        // 2. Broadcast to any listening Agents (Many-to-Many)
        server.broadcast('register', discordTools);
    });
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    console.log(`[discord] Received message from ${message.author.username} (${message.author.id}) in ${message.guild ? `guild ${message.guild.name}` : 'DMs'}: ${message.content}`);
    
    const eventData = {
        type: 'discord_message',
        author: message.author.username,
        authorId: message.author.id,
        content: message.content,
        messageId: message.id,
        channelId: message.channel.id,
        channelName: message.channel.name || 'DM',
        guildId: message.guild ? message.guild.id : null,
        guildName: message.guild ? message.guild.name : null,
        isDM: !message.guild,
        timestamp: getTimeInJakarta()
    };

    if (message.attachments.size > 0) {
        eventData.attachments = message.attachments.map(att => ({
            url: att.url,
            contentType: att.contentType,
            name: att.name
        }));
    }
    
    // Broadcast generic event to anyone subscribed
    server.broadcast('event', eventData);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (newMessage.author.bot) return;
    if (oldMessage.content === newMessage.content) return;

    console.log(`[discord] Message edited by ${newMessage.author.username} in ${newMessage.guild ? `guild ${newMessage.guild.name}` : 'DMs'}: ${oldMessage.content} -> ${newMessage.content}`);

    const eventData = {
        type: 'discord_message_edit',
        author: newMessage.author.username,
        authorId: newMessage.author.id,
        oldContent: oldMessage.content,
        newContent: newMessage.content,
        messageId: newMessage.id,
        channelId: newMessage.channel.id,
        channelName: newMessage.channel.name || 'DM',
        guildId: newMessage.guild ? newMessage.guild.id : null,
        guildName: newMessage.guild ? newMessage.guild.name : null,
        isDM: !newMessage.guild,
        timestamp: getTimeInJakarta()
    };

    server.broadcast('event', eventData);
});

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;

    // Partial handling
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('[discord] Error fetching partial reaction:', error);
            return;
        }
    }

    console.log(`[discord] Reaction added: ${reaction.emoji.name} by ${user.username} on message ${reaction.message.id}`);

    const eventData = {
        type: 'discord_reaction_add',
        user: user.username,
        userId: user.id,
        emoji: reaction.emoji.name,
        emojiId: reaction.emoji.id,
        messageId: reaction.message.id,
        channelId: reaction.message.channel.id,
        guildId: reaction.message.guild ? reaction.message.guild.id : null,
        timestamp: getTimeInJakarta()
    };

    server.broadcast('event', eventData);
});

server.listen('*', 'sendMessage', async (req, res) => {
    const { channelId, content, files } = req.data;
    
    try {
        const channel = await client.channels.fetch(channelId);
        if (channel && channel.send) {
            const splitMessage = (text, maxLen = 2000) => {
                if (!text) return [];
                const chunks = [];
                for (let i = 0; i < text.length; i += maxLen) {
                    chunks.push(text.slice(i, i + maxLen));
                }
                return chunks;
            };

            const chunks = splitMessage(content);
            const messageOptions = files ? { files } : {};

            if (chunks.length === 0 && files) {
                await channel.send(messageOptions);
            } else {
                for (let i = 0; i < chunks.length; i++) {
                    const options = (i === 0) ? { content: chunks[i], ...messageOptions } : { content: chunks[i] };
                    await channel.send(options);
                }
            }
            res.send({ success: true, timestamp: getTimeInJakarta() });
        } else {
            // Try user DM fallback
            const user = await client.users.fetch(channelId);
            if (user) {
                await user.send({ content: content, files: files });
                res.send({ success: true, timestamp: getTimeInJakarta() });
            } else {
                res.send({ success: false, error: "Channel/User not found or not sendable" });
            }
        }
    } catch (err) {
        console.error('[discord] Error sending message:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'addReaction', async (req, res) => {
    const { channelId, messageId, emoji } = req.data;
    try {
        const channel = await client.channels.fetch(channelId);
        const message = await channel.messages.fetch(messageId);
        await message.react(emoji);
        res.send({ success: true, timestamp: getTimeInJakarta() });
    } catch (err) {
        console.error('[discord] Error adding reaction:', err);
        res.send({ success: false, error: err.message });
    }
});

server.start().then(() => {
    console.log('📱 Discord app server is running.');
    client.login(DISCORD_TOKEN);
}).catch(err => {
    console.error('❌ Failed to start discord app server:', err);
});