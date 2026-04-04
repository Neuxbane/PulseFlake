require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const server = new (require('#UnixSocket'))("agent");
const { GeminiProvider } = require('#Providers');
const path = require('path');
const fs = require('fs');

const apiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
const models = process.env.GEMINI_MODELS ? process.env.GEMINI_MODELS.split(',') : ["gemini-3.1-flash-lite-preview"];

const provider = new GeminiProvider({ apiKeys, models });

const historyPath = path.resolve(__dirname, 'history.json');
const instructionPath = path.resolve(__dirname, 'instruction.txt');
const memoryPath = path.resolve(__dirname, 'memory.jsonl');

const getMemories = () => {
    if (!fs.existsSync(memoryPath)) return [];
    const lines = fs.readFileSync(memoryPath, 'utf8').split('\n').filter(l => l.trim());
    return lines.map(l => JSON.parse(l));
};

const saveMemories = (memories) => {
    const content = memories.map(m => JSON.stringify(m)).join('\n');
    fs.writeFileSync(memoryPath, content);
};

let chatHistory = [];
if (fs.existsSync(historyPath)) {
    try {
        chatHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    } catch (e) {
        console.error('Failed to load history:', e);
    }
}

// Initial bootstrapping if history is empty
if (chatHistory.length === 0) {
    chatHistory.push(
        { 
            role: 'user', 
            parts: [{ text: "System Initialized. You are in Event-Driven System Architecture. We only accept using Function Calling" }] 
        },
        { 
            role: 'model', 
            parts: [{ text: JSON.stringify({
                name: "tools.sleep",
                args: { duration: 10 }
            })}]
        }
    );
}

const saveHistory = () => {
    fs.writeFileSync(historyPath, JSON.stringify(chatHistory, null, 2));
};

let pendingEvents = [];
let debounceTimer = null;
const DEBOUNCE_DELAY = 5000; // 5 seconds

const processEvents = async () => {
    if (pendingEvents.length === 0) return;
    
    const eventsToProcess = [...pendingEvents];
    pendingEvents = [];
    
    console.log(`🤖 Processing batch of ${eventsToProcess.length} events...`);

    try {
        const combinedContent = eventsToProcess.map(e => JSON.stringify(e)).join('\n');

        const defaultTools = await server.request('tools', 'built-in');
        
        // 1. RAG search for relevant tools
        const searchResults = await server.request('tools', 'search', combinedContent);
        
        console.log(`🔍 RAG found ${searchResults.length} potential tools`);
        
        const toolsForAI = [...searchResults.slice(0, 10).map(r => ({
            name: `${r.identifier}.${r.name}`,
            description: r.definition.description,
            parameters: r.definition.parameters
        })), ...defaultTools];

        // 2. Update chat history
        chatHistory.push({ role: 'user', parts: [{ text: `INCOMING_EVENT: ${JSON.stringify(combinedContent)}` }] });
        
        let messages = chatHistory.slice(-100);

        // Fetch memories and inject into context (as pseudo-history/system setup)
        const currentMemories = getMemories();
        const memoryContext = currentMemories.length > 0
            ? currentMemories.map((m, i) => `[MEMORY ${i+1}] ${m.content}`).join('\n')
            : "No memories stored.";

        // Ensure the very old messages start with user
        if (messages.length > 0 && messages[0].role !== 'user') {
            messages.unshift({ role: 'user', parts: [{ text: "System Initialized. You are in Event-Driven System Architecture. We only accept using Function Calling" }] });
        }

        let systemInstruction = `This system runs on Event-Driven. No Naked Text, use function calling. The history are use function call but they saved via Naked Text because of the compatibility issue.
To ignore or when there is nothing to do, just go to tool.sleep to skip the time to the future when action maybe needed.
Use \`agent.addMemory\`, \`updateMemory\`, or \`deleteMemory\` to store/curate key facts. If at 20, delete or replace low-value memories. Priority: user identity, core goals, and critical long-term context.

### MEMORY STORAGE (MAX 20)
${memoryContext}`;

        if (fs.existsSync(instructionPath)) {
            try {
                systemInstruction = fs.readFileSync(instructionPath, 'utf8') + `\n\n### MEMORY STORAGE (MAX 20)\n${memoryContext}`;
            } catch (e) {
                console.error('Failed to load instruction:', e);
            }
        }

        console.log('🤖 Thinking...');
        const stream = provider.generate(messages, { 
            systemInstruction, 
            thinkingConfig: { include_thoughts: true }, // Enabling thinking for Gemini 2.0+
            tools: [
                ...toolsForAI, 
                {
                    name: 'agent.updateInstruction',
                    description: 'Update the agent system instruction/personality.',
                    parameters: {
                        type: 'object',
                        properties: {
                            instruction: { type: 'string', description: 'The new system instruction' }
                        },
                        required: ['instruction']
                    }
                },
                {
                    name: 'agent.addMemory',
                    description: 'Add a new fact/memory to memory.jsonl (Max 20).',
                    parameters: {
                        type: 'object',
                        properties: {
                            content: { type: 'string', description: 'The fact or memory to store.' }
                        },
                        required: ['content']
                    }
                },
                {
                    name: 'agent.deleteMemory',
                    description: 'Delete a memory from memory.jsonl by index (1-based).',
                    parameters: {
                        type: 'object',
                        properties: {
                            index: { type: 'integer', description: 'The index of the memory to delete (1-20).' }
                        },
                        required: ['index']
                    }
                },
                {
                    name: 'agent.updateMemory',
                    description: 'Update an existing memory at a specific index (1-based).',
                    parameters: {
                        type: 'object',
                        properties: {
                            index: { type: 'integer', description: 'The index of the memory to update (1-20).' },
                            content: { type: 'string', description: 'The new content for the memory.' }
                        },
                        required: ['index', 'content']
                    }
                }
            ]
        });

        for await (const chunkGenerator of stream) {
            for await (const part of chunkGenerator) {
                if (part.done) {
                    // Check if text contains JSON-formatted function call
                    let functionCallToExecute = part.functionCall;
                    
                    if (part.text && !functionCallToExecute) {
                        try {
                            const parsed = JSON.parse(part.text);
                            if (parsed && parsed.name && parsed.args) {
                                functionCallToExecute = parsed;
                                console.log('🤖 Parsed JSON function call from text');
                            }
                        } catch (e) {
                            // Not JSON or not a function call, treat as regular text
                        }
                    }

                    if (part.text && !functionCallToExecute) {
                        pendingEvents.push({
                            eventName: 'warning',
                            from: 'agent',
                            message: `LLM output was not a function call: ${part.text}. Please use function calling.`
                        });
                        if (debounceTimer) clearTimeout(debounceTimer);
                        processEvents();
                    }

                    if (functionCallToExecute) {
                        chatHistory.push({ role: 'model', parts: [{ text: JSON.stringify(functionCallToExecute) }] });
                        saveHistory();

                        const fullName = functionCallToExecute.name;
                        const [targetApp, toolName] = fullName.includes('.') ? fullName.split('.') : ['unknown', fullName];
                        const args = functionCallToExecute.args;
                        
                        console.log(`🤖 AI calling ${targetApp} -> ${toolName} with`, args);

                        try {
                            let toolRes;
                            if (fullName === 'agent.updateInstruction') {
                                fs.writeFileSync(instructionPath, args.instruction);
                                toolRes = { success: true, message: 'Instruction updated.' };
                                console.log('🤖 System instruction updated.');
                            } else if (fullName === 'agent.addMemory') {
                                const memories = getMemories();
                                if (memories.length >= 20) {
                                    toolRes = { success: false, message: 'Max memory limit reached (20). Please delete or update an existing memory.' };
                                } else {
                                    memories.push({ content: args.content });
                                    saveMemories(memories);
                                    toolRes = { success: true, message: 'Memory added.' };
                                }
                            } else if (fullName === 'agent.deleteMemory') {
                                const memories = getMemories();
                                const idx = args.index - 1;
                                if (idx >= 0 && idx < memories.length) {
                                    memories.splice(idx, 1);
                                    saveMemories(memories);
                                    toolRes = { success: true, message: 'Memory deleted.' };
                                } else {
                                    toolRes = { success: false, message: 'Invalid memory index.' };
                                }
                            } else if (fullName === 'agent.updateMemory') {
                                const memories = getMemories();
                                const idx = args.index - 1;
                                if (idx >= 0 && idx < memories.length) {
                                    memories[idx].content = args.content;
                                    saveMemories(memories);
                                    toolRes = { success: true, message: 'Memory updated.' };
                                } else {
                                    toolRes = { success: false, message: 'Invalid memory index.' };
                                }
                            } else {
                                const socketPath = path.resolve(__dirname, `../${targetApp}/${targetApp}.sock`);
                                await server.connect(socketPath);
                                toolRes = await server.request(targetApp, toolName, args);
                            }
                            
                            console.log(`🤖 Tool [${fullName}] response:`, toolRes);

                            console.log(`🤖 Tool result received for ${fullName}. Triggering immediate event loop...`);
                            pendingEvents.push({
                                eventName: 'tool_result',
                                from: targetApp,
                                tool: fullName,
                                result: toolRes
                            });
                            if (debounceTimer) clearTimeout(debounceTimer);
                            processEvents();
                        } catch (err) {
                            console.error(`🤖 Failed to call tool ${fullName}:`, err.message);
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.error('🤖 Batch Process Error:', err);
    }
};

const toolsSocketPath = path.resolve(__dirname, '../tools/tools.sock');

server.connect(toolsSocketPath).then(() => {
    console.log('🤖 Agent connected to tools server.');
});

// Listener for ANY generic event - with Debounce aggregation
server.subscribe('*', 'event', async (req) => {
    console.log(`🤖 Received [${req.eventName}] from ${req.from}. Queuing...`);
    pendingEvents.push(req);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processEvents, DEBOUNCE_DELAY);
});

server.start().then(() => {
    console.log('🤖 Agent server is running.');
}).catch(err => {
    console.error('❌ Failed to start agent server:', err);
});
