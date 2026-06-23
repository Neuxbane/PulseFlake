require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Client, GatewayIntentBits, Partials, ChannelType, GuildScheduledEventPrivacyLevel, GuildScheduledEventEntityType, GuildScheduledEventStatus } = require('discord.js');
const path = require('path');
const fs = require('fs');
const https = require('https');
const server = new (require('#UnixSocket'))("discord");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// --- ATTACHMENT DOWNLOAD UTILITY ---
const downloadAttachment = (url, filepath) => {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }
            const fileStream = fs.createWriteStream(filepath);
            response.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close();
                resolve(filepath);
            });
            fileStream.on('error', (err) => {
                fs.unlink(filepath, () => {}); // Delete the file if error
                reject(err);
            });
        }).on('error', reject);
    });
};

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildScheduledEvents
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

const getGuild = async (guildId) => {
    if (guildId) {
        return await client.guilds.fetch(guildId);
    }
    const guilds = client.guilds.cache;
    if (guilds.size === 0) {
        const fetchedGuilds = await client.guilds.fetch();
        if (fetchedGuilds.size === 0) throw new Error("Bot is not in any guilds (servers).");
        return await client.guilds.fetch(fetchedGuilds.first().id);
    }
    return guilds.first();
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
            },
            {
                name: 'listGuilds',
                description: 'List all servers (guilds) the bot is in.',
                parameters: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'getGuildDetails',
                description: 'Get detailed information about a Discord server.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional, defaults to first server bot is in).' }
                    }
                }
            },
            {
                name: 'listChannels',
                description: 'List all channels (including category headings) in a server.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' }
                    }
                }
            },
            {
                name: 'createChannel',
                description: 'Create a new text channel, voice channel, or category in a server.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' },
                        name: { type: 'string', description: 'The name of the new channel.' },
                        type: { type: 'string', enum: ['text', 'voice', 'category', 'announcement'], description: 'The type of channel (default: "text").' },
                        parentId: { type: 'string', description: 'The ID of the parent category channel (optional).' },
                        reason: { type: 'string', description: 'Audit log reason for creating this channel (optional).' }
                    },
                    required: ['name']
                }
            },
            {
                name: 'updateChannel',
                description: 'Update the configuration of a channel or category.',
                parameters: {
                    type: 'object',
                    properties: {
                        channelId: { type: 'string', description: 'The ID of the channel to update.' },
                        name: { type: 'string', description: 'The new name of the channel (optional).' },
                        parentId: { type: 'string', description: 'The parent category ID (optional, pass null/empty to remove category).' },
                        reason: { type: 'string', description: 'Audit log reason for updating this channel (optional).' }
                    },
                    required: ['channelId']
                }
            },
            {
                name: 'deleteChannel',
                description: 'Delete a channel or category from a server.',
                parameters: {
                    type: 'object',
                    properties: {
                        channelId: { type: 'string', description: 'The ID of the channel to delete.' },
                        reason: { type: 'string', description: 'Audit log reason for deleting this channel (optional).' }
                    },
                    required: ['channelId']
                }
            },
            {
                name: 'listRoles',
                description: 'List all roles in a server.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' }
                    }
                }
            },
            {
                name: 'createRole',
                description: 'Create a new role in a server.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' },
                        name: { type: 'string', description: 'The name of the new role.' },
                        color: { type: 'string', description: 'The color of the role (e.g. "#FF0000" or a color name like "BLUE") (optional).' },
                        hoist: { type: 'boolean', description: 'Whether the role should be displayed separately in the sidebar (optional).' },
                        reason: { type: 'string', description: 'Audit log reason for creating this role (optional).' }
                    },
                    required: ['name']
                }
            },
            {
                name: 'updateRole',
                description: 'Update a role in a server.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' },
                        roleId: { type: 'string', description: 'The ID of the role to update.' },
                        name: { type: 'string', description: 'The new name of the role (optional).' },
                        color: { type: 'string', description: 'The new color of the role (optional).' },
                        hoist: { type: 'boolean', description: 'Whether the role should be hoisted (optional).' },
                        reason: { type: 'string', description: 'Audit log reason for updating this role (optional).' }
                    },
                    required: ['roleId']
                }
            },
            {
                name: 'deleteRole',
                description: 'Delete a role from a server.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' },
                        roleId: { type: 'string', description: 'The ID of the role to delete.' },
                        reason: { type: 'string', description: 'Audit log reason for deleting this role (optional).' }
                    },
                    required: ['roleId']
                }
            },
            {
                name: 'listMembers',
                description: 'List members in a server.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' },
                        limit: { type: 'number', description: 'Maximum number of members to return (optional, default: 50).' }
                    }
                }
            },
            {
                name: 'manageMember',
                description: 'Manage a server member (kick, ban, unban, edit nickname, add/remove role, timeout).',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' },
                        memberId: { type: 'string', description: 'The ID of the member/user to manage.' },
                        action: { type: 'string', enum: ['kick', 'ban', 'unban', 'setNickname', 'addRole', 'removeRole', 'timeout'], description: 'The action to take.' },
                        nickname: { type: 'string', description: 'Nickname to set (required for "setNickname", pass empty string to reset).' },
                        roleId: { type: 'string', description: 'Role ID to add or remove (required for "addRole" and "removeRole").' },
                        timeoutMinutes: { type: 'number', description: 'Minutes to timeout (required for "timeout", pass null or 0 to remove timeout).' },
                        reason: { type: 'string', description: 'Audit log reason for the action (optional).' }
                    },
                    required: ['memberId', 'action']
                }
            },
            {
                name: 'listMessages',
                description: 'List recent message history in a channel.',
                parameters: {
                    type: 'object',
                    properties: {
                        channelId: { type: 'string', description: 'The ID of the channel to fetch messages from.' },
                        limit: { type: 'number', description: 'Max number of messages to fetch (optional, default: 50).' },
                        before: { type: 'string', description: 'Message ID to fetch messages before (optional).' },
                        after: { type: 'string', description: 'Message ID to fetch messages after (optional).' }
                    },
                    required: ['channelId']
                }
            },
            {
                name: 'updateMessage',
                description: 'Edit a message previously sent by the bot.',
                parameters: {
                    type: 'object',
                    properties: {
                        channelId: { type: 'string', description: 'The ID of the channel containing the message.' },
                        messageId: { type: 'string', description: 'The ID of the message to edit.' },
                        content: { type: 'string', description: 'The new message content.' }
                    },
                    required: ['channelId', 'messageId', 'content']
                }
            },
            {
                name: 'deleteMessage',
                description: 'Delete a message from a channel.',
                parameters: {
                    type: 'object',
                    properties: {
                        channelId: { type: 'string', description: 'The ID of the channel containing the message.' },
                        messageId: { type: 'string', description: 'The ID of the message to delete.' },
                        reason: { type: 'string', description: 'Audit log reason for deleting this message (optional).' }
                    },
                    required: ['channelId', 'messageId']
                }
            },
            {
                name: 'searchGuilds',
                description: 'Search for servers (guilds) matching a name query.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'The search query to match against server names.' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'searchChannels',
                description: 'Search for channels matching a name query.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' },
                        query: { type: 'string', description: 'The search query to match against channel names.' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'searchRoles',
                description: 'Search for roles matching a name query.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' },
                        query: { type: 'string', description: 'The search query to match against role names.' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'searchMembers',
                description: 'Search for server members matching a name/nickname query.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' },
                        query: { type: 'string', description: 'The search query to match against usernames/nicknames.' },
                        limit: { type: 'number', description: 'Max number of results to return (optional, default: 50).' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'searchMessages',
                description: 'Search recent messages in a channel matching a content query.',
                parameters: {
                    type: 'object',
                    properties: {
                        channelId: { type: 'string', description: 'The ID of the channel to search messages in.' },
                        query: { type: 'string', description: 'The text query to search for inside message content.' },
                        limit: { type: 'number', description: 'Number of recent messages to scan (optional, default: 100).' }
                    },
                    required: ['channelId', 'query']
                }
            },
            {
                name: 'listScheduledEvents',
                description: 'List all scheduled events in a server.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' }
                    }
                }
            },
            {
                name: 'createScheduledEvent',
                description: 'Create a new scheduled event in a server.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' },
                        name: { type: 'string', description: 'The name of the scheduled event.' },
                        scheduledStartTime: { type: 'string', description: 'The start time of the event (ISO 8601 string, e.g. "2026-06-25T12:00:00+07:00").' },
                        scheduledEndTime: { type: 'string', description: 'The end time of the event (ISO 8601 string). Required if entityType is "external".' },
                        entityType: { type: 'string', enum: ['stageInstance', 'voice', 'external'], description: 'The type of the event.' },
                        channelId: { type: 'string', description: 'The channel ID where the event will take place. Required if entityType is "stageInstance" or "voice".' },
                        location: { type: 'string', description: 'The physical or virtual location of the event. Required if entityType is "external".' },
                        description: { type: 'string', description: 'The description of the scheduled event (optional).' },
                        reason: { type: 'string', description: 'Audit log reason for creating this event (optional).' }
                    },
                    required: ['name', 'scheduledStartTime', 'entityType']
                }
            },
            {
                name: 'updateScheduledEvent',
                description: 'Update an existing scheduled event (e.g. edit details or start/complete/cancel it).',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' },
                        eventId: { type: 'string', description: 'The ID of the scheduled event to update.' },
                        name: { type: 'string', description: 'The new name of the scheduled event (optional).' },
                        scheduledStartTime: { type: 'string', description: 'The new start time of the event (ISO 8601 string, optional).' },
                        scheduledEndTime: { type: 'string', description: 'The new end time of the event (ISO 8601 string, optional).' },
                        entityType: { type: 'string', enum: ['stageInstance', 'voice', 'external'], description: 'The new entity type of the event (optional).' },
                        channelId: { type: 'string', description: 'The new channel ID (optional). Pass null to clear channel (e.g. converting to external).' },
                        location: { type: 'string', description: 'The new location of the event (optional).' },
                        description: { type: 'string', description: 'The new description of the event (optional).' },
                        status: { type: 'string', enum: ['scheduled', 'active', 'completed', 'canceled'], description: 'The new status of the event (optional, e.g. "active" to start it, "completed" to finish it, "canceled" to cancel it).' },
                        reason: { type: 'string', description: 'Audit log reason for updating this event (optional).' }
                    },
                    required: ['eventId']
                }
            },
            {
                name: 'deleteScheduledEvent',
                description: 'Delete (cancel) a scheduled event.',
                parameters: {
                    type: 'object',
                    properties: {
                        guildId: { type: 'string', description: 'The ID of the server (optional).' },
                        eventId: { type: 'string', description: 'The ID of the scheduled event to delete.' }
                    },
                    required: ['eventId']
                }
            }
        ];

        let instruction = "";
        try {
            const instPath = path.resolve(__dirname, 'instruction.txt');
            if (fs.existsSync(instPath)) {
                instruction = fs.readFileSync(instPath, 'utf8').trim();
            }
        } catch (e) {
            console.error('[discord] Failed to read instruction.txt:', e.message);
        }

        // 1. Register with the Tools RAG server
        server.request('tools', 'register', { instruction, tools: discordTools }).then(res => {
            console.log(`[discord] Tools registered with RAG server:`, res);
        });

        // 2. Broadcast to any listening Agents (Many-to-Many)
        server.broadcast('register', { instruction, tools: discordTools });
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

    // Download attachments if any
    if (message.attachments.size > 0) {
        try {
            const mediaDir = path.join(__dirname, 'media');
            if (!fs.existsSync(mediaDir)) {
                fs.mkdirSync(mediaDir, { recursive: true });
            }

            const attachments = [];
            for (const att of message.attachments.values()) {
                try {
                    // Generate filename with timestamp
                    const ext = path.extname(att.name) || path.extname(att.url).split('?')[0];
                    const timestamp = Date.now();
                    const filename = `${timestamp}-${att.id}${ext}`;
                    const filepath = path.join(mediaDir, filename);

                    // Download the attachment
                    await downloadAttachment(att.url, filepath);
                    attachments.push(filepath);
                    console.log(`[discord] Downloaded attachment: ${filepath}`);
                } catch (err) {
                    console.error(`[discord] Failed to download attachment ${att.name}:`, err.message);
                }
            }
            if (attachments.length > 0) {
                eventData.attachments = attachments;
            }
        } catch (err) {
            console.error(`[discord] Error processing attachments:`, err.message);
        }
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

server.listen('*', 'listGuilds', async (req, res) => {
    try {
        const guilds = await client.guilds.fetch();
        const data = guilds.map(g => ({
            id: g.id,
            name: g.name
        }));
        res.send({ success: true, guilds: data });
    } catch (err) {
        console.error('[discord] Error in listGuilds:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'getGuildDetails', async (req, res) => {
    const { guildId } = req.data;
    try {
        const guild = await getGuild(guildId);
        res.send({
            success: true,
            guild: {
                id: guild.id,
                name: guild.name,
                description: guild.description || null,
                memberCount: guild.memberCount,
                ownerId: guild.ownerId,
                iconURL: guild.iconURL() || null,
                rolesCount: guild.roles.cache.size,
                channelsCount: guild.channels.cache.size
            }
        });
    } catch (err) {
        console.error('[discord] Error in getGuildDetails:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'listChannels', async (req, res) => {
    const { guildId } = req.data;
    try {
        const guild = await getGuild(guildId);
        const channels = await guild.channels.fetch();
        const data = channels.map(c => {
            let typeName = 'unknown';
            if (c.type === ChannelType.GuildText) typeName = 'text';
            else if (c.type === ChannelType.GuildVoice) typeName = 'voice';
            else if (c.type === ChannelType.GuildCategory) typeName = 'category';
            else if (c.type === ChannelType.GuildAnnouncement) typeName = 'announcement';
            
            return {
                id: c.id,
                name: c.name,
                type: typeName,
                parentId: c.parentId,
                position: c.position
            };
        });
        res.send({ success: true, channels: data });
    } catch (err) {
        console.error('[discord] Error in listChannels:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'createChannel', async (req, res) => {
    const { guildId, name, type = 'text', parentId, reason } = req.data;
    try {
        const guild = await getGuild(guildId);
        let channelType = ChannelType.GuildText;
        if (type === 'voice') channelType = ChannelType.GuildVoice;
        else if (type === 'category') channelType = ChannelType.GuildCategory;
        else if (type === 'announcement') channelType = ChannelType.GuildAnnouncement;

        const options = {
            name,
            type: channelType,
            reason
        };
        if (parentId) {
            options.parent = parentId;
        }

        const newChannel = await guild.channels.create(options);
        res.send({
            success: true,
            channel: {
                id: newChannel.id,
                name: newChannel.name,
                type: type,
                parentId: newChannel.parentId
            }
        });
    } catch (err) {
        console.error('[discord] Error in createChannel:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'updateChannel', async (req, res) => {
    const { channelId, name, parentId, reason } = req.data;
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) throw new Error("Channel not found.");
        
        const options = { reason };
        if (name !== undefined) options.name = name;
        if (parentId !== undefined) {
            options.parent = parentId || null;
        }

        const updated = await channel.edit(options);
        res.send({
            success: true,
            channel: {
                id: updated.id,
                name: updated.name,
                parentId: updated.parentId
            }
        });
    } catch (err) {
        console.error('[discord] Error in updateChannel:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'deleteChannel', async (req, res) => {
    const { channelId, reason } = req.data;
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) throw new Error("Channel not found.");
        await channel.delete(reason);
        res.send({ success: true });
    } catch (err) {
        console.error('[discord] Error in deleteChannel:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'listRoles', async (req, res) => {
    const { guildId } = req.data;
    try {
        const guild = await getGuild(guildId);
        const roles = await guild.roles.fetch();
        const data = roles.map(r => ({
            id: r.id,
            name: r.name,
            color: r.hexColor,
            position: r.position,
            hoist: r.hoist,
            managed: r.managed,
            permissions: r.permissions.toArray()
        }));
        res.send({ success: true, roles: data });
    } catch (err) {
        console.error('[discord] Error in listRoles:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'createRole', async (req, res) => {
    const { guildId, name, color, hoist, reason } = req.data;
    try {
        const guild = await getGuild(guildId);
        const options = { name, reason };
        if (color !== undefined) options.color = color;
        if (hoist !== undefined) options.hoist = hoist;

        const newRole = await guild.roles.create(options);
        res.send({
            success: true,
            role: {
                id: newRole.id,
                name: newRole.name,
                color: newRole.hexColor,
                hoist: newRole.hoist
            }
        });
    } catch (err) {
        console.error('[discord] Error in createRole:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'updateRole', async (req, res) => {
    const { guildId, roleId, name, color, hoist, reason } = req.data;
    try {
        const guild = await getGuild(guildId);
        const role = await guild.roles.fetch(roleId);
        if (!role) throw new Error("Role not found.");

        const options = { reason };
        if (name !== undefined) options.name = name;
        if (color !== undefined) options.color = color;
        if (hoist !== undefined) options.hoist = hoist;

        const updated = await role.edit(options);
        res.send({
            success: true,
            role: {
                id: updated.id,
                name: updated.name,
                color: updated.hexColor,
                hoist: updated.hoist
            }
        });
    } catch (err) {
        console.error('[discord] Error in updateRole:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'deleteRole', async (req, res) => {
    const { guildId, roleId, reason } = req.data;
    try {
        const guild = await getGuild(guildId);
        const role = await guild.roles.fetch(roleId);
        if (!role) throw new Error("Role not found.");
        await role.delete(reason);
        res.send({ success: true });
    } catch (err) {
        console.error('[discord] Error in deleteRole:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'listMembers', async (req, res) => {
    const { guildId, limit = 50 } = req.data;
    try {
        const guild = await getGuild(guildId);
        const members = await guild.members.fetch({ limit });
        const data = members.map(m => ({
            id: m.user.id,
            username: m.user.username,
            displayName: m.displayName,
            nickname: m.nickname,
            roles: m.roles.cache.map(r => r.id),
            joinedAt: m.joinedAt ? m.joinedAt.toISOString() : null,
            isBot: m.user.bot
        }));
        res.send({ success: true, members: data });
    } catch (err) {
        console.error('[discord] Error in listMembers:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'manageMember', async (req, res) => {
    const { guildId, memberId, action, nickname, roleId, timeoutMinutes, reason } = req.data;
    try {
        const guild = await getGuild(guildId);
        
        if (action === 'unban') {
            await guild.bans.remove(memberId, reason);
            return res.send({ success: true });
        }

        const member = await guild.members.fetch(memberId);
        if (!member) throw new Error("Member not found in guild.");

        if (action === 'kick') {
            await member.kick(reason);
        } else if (action === 'ban') {
            await member.ban({ deleteMessageSeconds: 604800, reason });
        } else if (action === 'setNickname') {
            await member.setNickname(nickname === undefined ? null : nickname, reason);
        } else if (action === 'addRole') {
            if (!roleId) throw new Error("roleId is required for addRole action.");
            await member.roles.add(roleId, reason);
        } else if (action === 'removeRole') {
            if (!roleId) throw new Error("roleId is required for removeRole action.");
            await member.roles.remove(roleId, reason);
        } else if (action === 'timeout') {
            const ms = timeoutMinutes ? timeoutMinutes * 60 * 1000 : null;
            await member.timeout(ms, reason);
        } else {
            throw new Error(`Invalid action: ${action}`);
        }

        res.send({ success: true });
    } catch (err) {
        console.error('[discord] Error in manageMember:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'listMessages', async (req, res) => {
    const { channelId, limit = 50, before, after } = req.data;
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.messages) throw new Error("Channel not found or has no message history.");
        const options = { limit };
        if (before) options.before = before;
        if (after) options.after = after;

        const messages = await channel.messages.fetch(options);
        const data = messages.map(m => ({
            id: m.id,
            author: {
                id: m.author.id,
                username: m.author.username
            },
            content: m.content,
            timestamp: m.createdAt.toISOString(),
            attachments: m.attachments.map(a => a.url)
        }));
        res.send({ success: true, messages: data });
    } catch (err) {
        console.error('[discord] Error in listMessages:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'updateMessage', async (req, res) => {
    const { channelId, messageId, content } = req.data;
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.messages) throw new Error("Channel not found.");
        const message = await channel.messages.fetch(messageId);
        if (!message) throw new Error("Message not found.");
        if (message.author.id !== client.user.id) throw new Error("Bot can only edit its own messages.");
        
        await message.edit(content);
        res.send({ success: true });
    } catch (err) {
        console.error('[discord] Error in updateMessage:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'deleteMessage', async (req, res) => {
    const { channelId, messageId, reason } = req.data;
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.messages) throw new Error("Channel not found.");
        const message = await channel.messages.fetch(messageId);
        if (!message) throw new Error("Message not found.");
        
        await message.delete(reason);
        res.send({ success: true });
    } catch (err) {
        console.error('[discord] Error in deleteMessage:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'searchGuilds', async (req, res) => {
    const { query } = req.data;
    try {
        const guilds = await client.guilds.fetch();
        const filtered = guilds.filter(g => g.name.toLowerCase().includes(query.toLowerCase()));
        const data = filtered.map(g => ({
            id: g.id,
            name: g.name
        }));
        res.send({ success: true, guilds: data });
    } catch (err) {
        console.error('[discord] Error in searchGuilds:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'searchChannels', async (req, res) => {
    const { guildId, query } = req.data;
    try {
        const guild = await getGuild(guildId);
        const channels = await guild.channels.fetch();
        const filtered = channels.filter(c => c.name.toLowerCase().includes(query.toLowerCase()));
        const data = filtered.map(c => {
            let typeName = 'unknown';
            if (c.type === ChannelType.GuildText) typeName = 'text';
            else if (c.type === ChannelType.GuildVoice) typeName = 'voice';
            else if (c.type === ChannelType.GuildCategory) typeName = 'category';
            else if (c.type === ChannelType.GuildAnnouncement) typeName = 'announcement';

            return {
                id: c.id,
                name: c.name,
                type: typeName,
                parentId: c.parentId
            };
        });
        res.send({ success: true, channels: data });
    } catch (err) {
        console.error('[discord] Error in searchChannels:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'searchRoles', async (req, res) => {
    const { guildId, query } = req.data;
    try {
        const guild = await getGuild(guildId);
        const roles = await guild.roles.fetch();
        const filtered = roles.filter(r => r.name.toLowerCase().includes(query.toLowerCase()));
        const data = filtered.map(r => ({
            id: r.id,
            name: r.name,
            color: r.hexColor
        }));
        res.send({ success: true, roles: data });
    } catch (err) {
        console.error('[discord] Error in searchRoles:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'searchMembers', async (req, res) => {
    const { guildId, query, limit = 50 } = req.data;
    try {
        const guild = await getGuild(guildId);
        const members = await guild.members.fetch({ query, limit });
        const data = members.map(m => ({
            id: m.user.id,
            username: m.user.username,
            displayName: m.displayName,
            nickname: m.nickname
        }));
        res.send({ success: true, members: data });
    } catch (err) {
        console.error('[discord] Error in searchMembers:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'searchMessages', async (req, res) => {
    const { channelId, query, limit = 100 } = req.data;
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.messages) throw new Error("Channel not found or does not support message history.");
        const messages = await channel.messages.fetch({ limit });
        const filtered = messages.filter(m => m.content.toLowerCase().includes(query.toLowerCase()));
        const data = filtered.map(m => ({
            id: m.id,
            author: {
                id: m.author.id,
                username: m.author.username
            },
            content: m.content,
            timestamp: m.createdAt.toISOString()
        }));
        res.send({ success: true, messages: data });
    } catch (err) {
        console.error('[discord] Error in searchMessages:', err);
        res.send({ success: false, error: err.message });
    }
});

// --- SCHEDULED EVENTS UTILITIES & LISTENERS ---
const formatScheduledEvent = (event) => {
    let privacyLevelName = 'unknown';
    if (event.privacyLevel === GuildScheduledEventPrivacyLevel.GuildOnly) privacyLevelName = 'GuildOnly';

    let entityTypeName = 'unknown';
    if (event.entityType === GuildScheduledEventEntityType.StageInstance) entityTypeName = 'stageInstance';
    else if (event.entityType === GuildScheduledEventEntityType.Voice) entityTypeName = 'voice';
    else if (event.entityType === GuildScheduledEventEntityType.External) entityTypeName = 'external';

    let statusName = 'unknown';
    if (event.status === GuildScheduledEventStatus.Scheduled) statusName = 'scheduled';
    else if (event.status === GuildScheduledEventStatus.Active) statusName = 'active';
    else if (event.status === GuildScheduledEventStatus.Completed) statusName = 'completed';
    else if (event.status === GuildScheduledEventStatus.Canceled) statusName = 'canceled';

    return {
        id: event.id,
        guildId: event.guildId,
        channelId: event.channelId,
        creatorId: event.creatorId,
        name: event.name,
        description: event.description,
        scheduledStartTime: event.scheduledStartAt ? event.scheduledStartAt.toISOString() : null,
        scheduledEndTime: event.scheduledEndAt ? event.scheduledEndAt.toISOString() : null,
        privacyLevel: privacyLevelName,
        entityType: entityTypeName,
        entityId: event.entityId,
        location: event.entityMetadata ? event.entityMetadata.location : null,
        status: statusName,
        userCount: event.userCount,
        creator: event.creator ? {
            id: event.creator.id,
            username: event.creator.username
        } : null
    };
};

server.listen('*', 'listScheduledEvents', async (req, res) => {
    const { guildId } = req.data;
    try {
        const guild = await getGuild(guildId);
        const events = await guild.scheduledEvents.fetch();
        const data = events.map(event => formatScheduledEvent(event));
        res.send({ success: true, events: data });
    } catch (err) {
        console.error('[discord] Error in listScheduledEvents:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'createScheduledEvent', async (req, res) => {
    const { guildId, name, scheduledStartTime, scheduledEndTime, entityType, channelId, location, description, reason } = req.data;
    try {
        const guild = await getGuild(guildId);

        let typeVal;
        if (entityType === 'stageInstance') typeVal = GuildScheduledEventEntityType.StageInstance;
        else if (entityType === 'voice') typeVal = GuildScheduledEventEntityType.Voice;
        else if (entityType === 'external') typeVal = GuildScheduledEventEntityType.External;
        else throw new Error(`Invalid entityType: ${entityType}`);

        const options = {
            name,
            scheduledStartTime: new Date(scheduledStartTime),
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType: typeVal,
            description,
            reason
        };

        if (scheduledEndTime) {
            options.scheduledEndTime = new Date(scheduledEndTime);
        }

        if (typeVal === GuildScheduledEventEntityType.External) {
            if (!location) throw new Error("location is required for external scheduled events.");
            options.entityMetadata = { location };
            if (!scheduledEndTime) throw new Error("scheduledEndTime is required for external scheduled events.");
        } else {
            if (!channelId) throw new Error("channelId is required for stageInstance/voice scheduled events.");
            options.channel = channelId;
        }

        const event = await guild.scheduledEvents.create(options);
        res.send({ success: true, event: formatScheduledEvent(event) });
    } catch (err) {
        console.error('[discord] Error in createScheduledEvent:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'updateScheduledEvent', async (req, res) => {
    const { guildId, eventId, name, scheduledStartTime, scheduledEndTime, entityType, channelId, location, description, status, reason } = req.data;
    try {
        const guild = await getGuild(guildId);
        const event = await guild.scheduledEvents.fetch(eventId);
        if (!event) throw new Error("Scheduled event not found.");

        const options = { reason };
        if (name !== undefined) options.name = name;
        if (scheduledStartTime !== undefined) options.scheduledStartTime = new Date(scheduledStartTime);
        if (scheduledEndTime !== undefined) options.scheduledEndTime = scheduledEndTime ? new Date(scheduledEndTime) : null;
        if (description !== undefined) options.description = description;

        if (entityType !== undefined) {
            let typeVal;
            if (entityType === 'stageInstance') typeVal = GuildScheduledEventEntityType.StageInstance;
            else if (entityType === 'voice') typeVal = GuildScheduledEventEntityType.Voice;
            else if (entityType === 'external') typeVal = GuildScheduledEventEntityType.External;
            else if (entityType === null) typeVal = null;
            else throw new Error(`Invalid entityType: ${entityType}`);
            options.entityType = typeVal;
        }

        if (channelId !== undefined) {
            options.channel = channelId || null;
        }

        if (location !== undefined) {
            options.entityMetadata = location ? { location } : null;
        }

        if (status !== undefined) {
            let statusVal;
            if (status === 'scheduled') statusVal = GuildScheduledEventStatus.Scheduled;
            else if (status === 'active') statusVal = GuildScheduledEventStatus.Active;
            else if (status === 'completed') statusVal = GuildScheduledEventStatus.Completed;
            else if (status === 'canceled') statusVal = GuildScheduledEventStatus.Canceled;
            else throw new Error(`Invalid status: ${status}`);
            options.status = statusVal;
        }

        const updated = await event.edit(options);
        res.send({ success: true, event: formatScheduledEvent(updated) });
    } catch (err) {
        console.error('[discord] Error in updateScheduledEvent:', err);
        res.send({ success: false, error: err.message });
    }
});

server.listen('*', 'deleteScheduledEvent', async (req, res) => {
    const { guildId, eventId } = req.data;
    try {
        const guild = await getGuild(guildId);
        const event = await guild.scheduledEvents.fetch(eventId);
        if (!event) throw new Error("Scheduled event not found.");
        await event.delete();
        res.send({ success: true });
    } catch (err) {
        console.error('[discord] Error in deleteScheduledEvent:', err);
        res.send({ success: false, error: err.message });
    }
});

server.start().then(() => {
    console.log('📱 Discord app server is running.');
    client.login(DISCORD_TOKEN);
}).catch(err => {
    console.error('❌ Failed to start discord app server:', err);
});