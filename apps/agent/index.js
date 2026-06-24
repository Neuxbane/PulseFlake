require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const server = new (require('#UnixSocket'))("agent");
const { GeminiProvider } = require('#Providers');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

const apiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
const models = process.env.GEMINI_MODELS ? process.env.GEMINI_MODELS.split(',') : ["gemma-4-31b-it"];

const provider = new GeminiProvider({ apiKeys, models });

const tryExtractFunctionCall = (text) => {
    if (!text) return null;
    
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && parsed.name && parsed.args) {
            return parsed;
        }
    } catch (e) {}

    let braceCount = 0;
    let currentStart = -1;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
            if (braceCount === 0) currentStart = i;
            braceCount++;
        } else if (text[i] === '}') {
            if (braceCount > 0) {
                braceCount--;
                if (braceCount === 0 && currentStart !== -1) {
                    const candidate = text.substring(currentStart, i + 1);
                    try {
                        const parsed = JSON.parse(candidate);
                        if (parsed && typeof parsed === 'object' && parsed.name && parsed.args) {
                            return parsed;
                        }
                    } catch (e) {
                        i = currentStart;
                    }
                    braceCount = 0;
                    currentStart = -1;
                }
            }
        }
    }
    
    return null;
};

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
const subAgents = new Map();
let subAgentCounter = 0;

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

const invalidateChats = (chats)=> {
    let role, correctedHistory = [];
    for (let chat of chats) {
        if(chat.role !== role) {
            role = chat.role;
            correctedHistory.push(chat);
        }
    }
    return correctedHistory;
}

const invalidateHistory = () => {
    chatHistory = invalidateChats(chatHistory);
};

invalidateHistory();

const saveHistory = () => {
    invalidateHistory();
    fs.writeFileSync(historyPath, JSON.stringify(chatHistory, null, 2));
};

const loadHistory = () => {
    if (fs.existsSync(historyPath)) {
        try {
            chatHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        } catch (e) {
            console.error('Failed to load history:', e);
        }
    }
}

const cosineSimilarity = (vecA, vecB) => {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    const dotProduct = vecA.reduce((sum, a, idx) => sum + a * vecB[idx], 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
};

const getTurnText = (turn) => {
    const userText = turn.user.parts ? turn.user.parts.map(p => p.text || '').join(' ').trim() : '';
    const modelText = turn.model && turn.model.parts ? turn.model.parts.map(p => p.text || '').join(' ').trim() : '';
    return `${userText} ${modelText}`.trim();
};

const truncateHistory = async (history, queryText) => {
    const RAM_LIMIT = 50;
    const RAG_LIMIT = 40; // up to 40 turns

    if (!history || history.length === 0) return [];

    // If history fits in RAM, just use it raw
    if (history.length <= RAM_LIMIT) {
        let updatedHistory = [...history];
        while (updatedHistory.length > 1 && updatedHistory[0].role !== 'user') {
            updatedHistory.shift();
        }
        return updatedHistory;
    }

    // 1. RAM: Keep the last 50 messages raw
    const ram = history.slice(-RAM_LIMIT);

    // 2. Anchor Candidates: All preceding history turned into Turns
    const anchorCandidates = history.slice(0, history.length - RAM_LIMIT);
    const turns = [];
    let currentTurn = null;

    for (const msg of anchorCandidates) {
        if (msg.role === 'user') {
            if (currentTurn) {
                turns.push(currentTurn);
            }
            currentTurn = {
                user: msg,
                model: null
            };
        } else if ((msg.role === 'model' || msg.role === 'assistant') && currentTurn) {
            currentTurn.model = msg;
        }
    }
    if (currentTurn) {
        turns.push(currentTurn);
    }

    // Backfill turn embeddings if missing
    for (const turn of turns) {
        if (!turn.user.embedding) {
            const turnText = getTurnText(turn);
            if (turnText) {
                try {
                    const vector = await provider.embed([{ text: turnText }]);
                    if (vector && vector.length > 0) {
                        turn.user.embedding = vector;
                        // Save back to the original message in history reference
                        const origMsg = history.find(m => m === turn.user);
                        if (origMsg) origMsg.embedding = vector;
                    }
                } catch (e) {
                    console.error('[agent] Failed to embed turn context:', e.message);
                }
            }
        }
    }

    let selectedTurns = [];
    let queryEmbedding = null;

    if (queryText) {
        try {
            queryEmbedding = await provider.embed([{ text: queryText }]);
        } catch (e) {
            console.error('[agent] Failed to embed query:', e.message);
        }
    }

    if (queryEmbedding && queryEmbedding.length > 0) {
        const turnsWithSimilarity = [];
        for (const turn of turns) {
            const similarity = turn.user.embedding ? cosineSimilarity(queryEmbedding, turn.user.embedding) : 0;
            turnsWithSimilarity.push({ turn, similarity });
        }

        // Sort by similarity descending
        turnsWithSimilarity.sort((a, b) => b.similarity - a.similarity);

        // Take top 40 turns
        const topTurns = turnsWithSimilarity.slice(0, RAG_LIMIT).map(x => x.turn);

        // Sort chronologically based on their original order
        const turnIndices = new Map(turns.map((t, idx) => [t, idx]));
        topTurns.sort((a, b) => turnIndices.get(a) - turnIndices.get(b));
        selectedTurns = topTurns;
    } else {
        // Fallback to the 40 most recent turns
        selectedTurns = turns.slice(-RAG_LIMIT);
    }

    const compressedAnchor = [];
    for (const turn of selectedTurns) {
        compressedAnchor.push(turn.user);
        if (turn.model) {
            compressedAnchor.push(turn.model);
        }
    }

    let updatedHistory = [...compressedAnchor, ...ram];

    while (updatedHistory.length > 1 && updatedHistory[0].role !== 'user') {
        updatedHistory.shift();
    }

    return updatedHistory;
};

const getInjectedAppInstructions = async () => {
    let appInstructions = "";
    try {
        const registeredInstructions = await server.request('tools', 'getInstructions');
        if (registeredInstructions) {
            for (const [appName, instruction] of Object.entries(registeredInstructions)) {
                if (instruction) {
                    appInstructions += `\n<app name="${appName}">${instruction}</app>`;
                }
            }
        }
    } catch (e) {
        console.error('Failed to load app instructions from tools registry:', e.message);
    }
    return appInstructions;
};

const getSystemInstruction = async (memoryContext) => {
    let baseInstruction = "";
    if (fs.existsSync(instructionPath)) {
        try {
            baseInstruction = fs.readFileSync(instructionPath, 'utf8').trim();
        } catch (e) {
            console.error('Failed to load instruction:', e);
        }
    }
    if (!baseInstruction) {
        baseInstruction = `This system runs on Event-Driven architecture. No Naked Text, use function calling.
To ignore or when there is nothing to do, just go to tool.sleep to skip the time to the future when action maybe needed.
Use \`agent.addMemory\`, \`updateMemory\`, or \`deleteMemory\` to store/curate key facts. If at 20, delete or replace low-value memories. Priority: user identity, core goals, and critical long-term context.

### AGENT ROLE, DELEGATION & EXECUTION PROTOCOL
You are the Main Agent. Your core role is to serve as a fast-responding bridge between the User and the AI system while maintaining a persistent, helpful persona.
You have FULL, direct access to all registered apps and tools, just like sub-agents. However, you must carefully choose between direct execution and sub-agent spawning based on the task:

1. **Direct Execution (Simple/Informational Tasks)**:
   - Handle simple, single-step tasks directly to ensure maximum response speed.
   - Examples: Checking a single status, fetching a current memory, sending a quick message, answering simple informational questions, or executing a single, non-blocking tool call.
2. **Sub-Agent Delegation (Complex/Multi-Step Workflows)**:
   - Delegate complex, long-running, multi-step tasks, or workflows requiring loops and logic checks across multiple apps to sub-agents via \`agent.spawnSubagent\`.
   - Examples: Writing code, researching web pages in a loop, gathering reports from multiple apps, or conducting multi-turn tasks.
   - When spawning a sub-agent, immediately notify the user that a sub-agent has been dispatched.

### SUB-AGENT CONTROL & MONITORING TOOLS
You can manage and interact with running sub-agents in the background using the following tools:
- \`agent.listSubagents\`: Get the IDs, goals, and parent details of all active background sub-agents.
- \`agent.getSubagentHistory\`: Retrieve the chat history and logs of a running sub-agent to monitor its progress.
- \`agent.sendMessageToSubagent\`: Send message updates, user feedback, or append new instructions/data directly to a running sub-agent's event queue/history.
- \`agent.stopSubagent\`: Terminate/stop a running sub-agent immediately by its ID.

*Note: Sub-agents do NOT have spawning capability; they cannot spawn nested sub-agents and must only call \`agent.done\` to report results back when completed.*

### SUB-AGENT TOOL DISCOVERY & EXECUTION PROTOCOL (For Spawning)
When spawning a sub-agent, specify a goal that instructs the sub-agent to:
1. Identify the appropriate app for the task by checking the \`<app name="NAME">\` descriptions in the "REGISTERED SERVICES & APPS" section.
2. Directly query the tools for that specific app using \`tools.listAppTools\`.
3. Locate general tools using \`tools.search\` or \`tools.strict-search\` as needed.
4. Execute the appropriate tools and loops until the goal is achieved.
5. Call \`agent.done\` to report findings and results back to the parent.`;
    }

    const appInstructions = await getInjectedAppInstructions();
    let instruction = baseInstruction;
    if (appInstructions) {
        instruction += `\n\n### REGISTERED SERVICES & APPS\nThe following apps are available in the system. Use tools.listAppTools to inspect their functions:\n${appInstructions}`;
    }
    
    if (memoryContext) {
        instruction += `\n\n### MEMORY STORAGE (MAX 20)\n${memoryContext}`;
    }

    // Active sub-agents context injection
    let activeSubAgentsContext = "";
    if (subAgents && subAgents.size > 0) {
        activeSubAgentsContext = Array.from(subAgents.values())
            .map(sub => `[Sub-Agent ${sub.id}] Goal: "${sub.goal}" | Status: ${sub.isRunning ? 'RUNNING' : 'STOPPED'} (Turns: ${Math.floor(sub.history.length / 2)})`)
            .join('\n');
    } else {
        activeSubAgentsContext = "No active sub-agents currently running.";
    }
    instruction += `\n\n### ACTIVE BACKGROUND SUB-AGENTS\n${activeSubAgentsContext}`;

    return instruction;
};

class SubAgent {
    constructor(id, parentId, instruction, goal, toolsForAI, parentResolve) {
        this.id = id;
        this.parentId = parentId;
        this.goal = goal;
        this.parentResolve = parentResolve;
        this.history = [
            { role: 'user', parts: [{ text: `Sub-agent initialized. Goal: ${goal}` }] }
        ];
        this.isRunning = true;

        // Fork the child process
        this.child = fork(path.resolve(__dirname, 'subagent.js'), [], {
            env: { ...process.env }
        });

        // Listen for messages from the child process
        this.child.on('message', (msg) => {
            if (msg.type === 'history') {
                this.history = msg.history;
            } else if (msg.type === 'done') {
                this.isRunning = false;
                this.parentResolve(msg.message);
            }
        });

        this.child.on('exit', (code, signal) => {
            console.log(`🤖 [SubAgent ${this.id}] Process exited with code ${code} and signal ${signal}`);
            this.isRunning = false;
            this.parentResolve(`Sub-agent exited with code ${code}`);
        });

        // Initialize child
        this.child.send({
            type: 'init',
            id,
            parentId,
            instruction,
            goal,
            toolsForAI
        });
    }

    sendMessage(message) {
        if (this.child && this.child.connected) {
            this.child.send({ type: 'message', message });
        }
    }

    stop() {
        this.isRunning = false;
        if (this.child && this.child.connected) {
            this.child.send({ type: 'stop' });
            setTimeout(() => {
                if (this.child && this.child.connected) {
                    this.child.kill('SIGKILL');
                }
            }, 500);
        }
    }
}

async function handleSpawnSubagent(args, parentId = 'main') {
    const id = ++subAgentCounter;
    console.log(`🤖 Agent spawning sub-agent ${id} (parent: ${parentId}) with goal: ${args.goal}`);
    
    // Pass along the same tools availability for now, ideally search again or pass filtered
    const defaultTools = await server.request('tools', 'built-in');
    
    // 1. RAG search for relevant tools
    const ragSearchResults = await server.request('tools', 'search', args.goal);
    console.log(`🔍 RAG search found ${ragSearchResults.length} potential tools for sub-agent ${id}`);
    
    // 2. Contain rules search for relevant tools
    const rulesSearchResults = await server.request('tools', 'strict-search', args.goal);
    console.log(`🔍 Rules search found ${rulesSearchResults.length} potential tools for sub-agent ${id}`);
    
    // Combine both results, deduplicate by tool name
    const seenTools = new Set();
    const combinedResults = [];
    
    [...ragSearchResults, ...rulesSearchResults].forEach(r => {
        if (!seenTools.has(r.fullName)) {
            seenTools.add(r.fullName);
            combinedResults.push(r);
        }
    });
    
    const toolsForAI = [...combinedResults.slice(0, 10).map(r => ({
        name: `${r.identifier}.${r.name}`,
        description: r.definition.description,
        parameters: r.definition.parameters
    })), ...defaultTools];

    // Read current instruction for the sub-agent
    const baseInstruction = await getSystemInstruction("");

    return new Promise((resolve) => {
        const sub = new SubAgent(id, parentId, baseInstruction, args.goal, toolsForAI, resolve);
        subAgents.set(id, sub);
        sub.child.on('exit', () => {
            subAgents.delete(id);
        });
    });
}

let pendingEvents = [];
let lastEventTime = 0;
const DEBOUNCE_DELAY = 5000; // 5 seconds
let isProcessing = false;

const queue = (event) => {
    pendingEvents.push(event);
    lastEventTime = Date.now();
};

const processEvents = async (eventsToProcess) => {
    if (isProcessing) return;
    isProcessing = true;
    
    try {
        invalidateHistory();
        let toolCalls = [];
        console.log(`🤖 Processing batch of ${eventsToProcess.length} events...`);

        try {
            // Build combined content with support for attachments
            const combinedContent = [];
            
            for (const event of eventsToProcess) {
                // Separate attachments from the event data
                const eventCopy = typeof event === 'string' ? event : { ...event };
                let attachments = [];
                
                if (typeof eventCopy === 'object' && eventCopy?.data?.attachments) {
                    attachments = eventCopy.data?.attachments;
                    delete eventCopy.data?.attachments;
                }
                
                // Add the event as text
                combinedContent.push({ 
                    text: typeof eventCopy === 'string' ? eventCopy : JSON.stringify(eventCopy) 
                });
                
                // Add each attachment as a separate part
                for (const attachmentPath of attachments) {
                    combinedContent.push({ attachment: attachmentPath });
                }
            }

            const defaultTools = await server.request('tools', 'built-in');
            
            // 1. RAG search for relevant tools
            const ragSearchResults = await server.request('tools', 'search', combinedContent);
            console.log(`🔍 RAG search found ${ragSearchResults.length} potential tools`);
            
            // 2. Contain rules search for relevant tools
            const rulesSearchResults = await server.request('tools', 'strict-search', combinedContent);
            console.log(`🔍 Rules search found ${rulesSearchResults.length} potential tools`);
            
            // Combine both results, prioritizing RAG then Rules, deduplicate by tool name
            const seenTools = new Set();
            const combinedResults = [];
            
            [...ragSearchResults, ...rulesSearchResults].forEach(r => {
                if (!seenTools.has(r.fullName)) {
                    seenTools.add(r.fullName);
                    combinedResults.push(r);
                }
            });
            
            const toolsForAI = [...combinedResults.slice(0, 10).map(r => ({
                name: `${r.identifier}.${r.name}`,
                description: r.definition.description,
                parameters: r.definition.parameters
            })), ...defaultTools];

            if (chatHistory.slice(-1)[0] && chatHistory.slice(-1)[0].role == 'user') {
                // combine the old part
                combinedContent.push(...chatHistory.slice(-1)[0].parts);
                chatHistory = chatHistory.slice(0, -1);
            }

            // 2. Update chat history
            chatHistory.push({ role: 'user', parts: combinedContent });
            saveHistory();

            const queryText = combinedContent.map(p => p.text || '').join(' ').trim();
            let messages = await truncateHistory(chatHistory, queryText);
            saveHistory();

            // Fetch memories and inject into context (as pseudo-history/system setup)
            const currentMemories = getMemories();
            const memoryContext = currentMemories.length > 0
                ? currentMemories.map((m, i) => `[MEMORY ${i+1}] ${m.content}`).join('\n')
                : "No memories stored.";

            const systemInstruction = await getSystemInstruction(memoryContext);

            console.log('🤖 Thinking...');
            const stream = provider.generate(messages, { 
                systemInstruction, 
                thinkingConfig: { include_thoughts: true }, // Enabling thinking for Gemini 2.0+
                tools: [
                    ...toolsForAI, 
                    { 
                        name: 'agent.spawnSubagent',
                        description: 'Spawn a sub-agent to handle a specific sub-task. It will run based on instructions and report back.',
                        parameters: {
                            type: 'object',
                            properties: {
                                goal: { type: 'string', description: 'The specific sub-task goal for the sub-agent.' }
                            },
                            required: ['goal']
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
                    },
                    {
                        name: 'agent.listSubagents',
                        description: 'Get a list of all currently running sub-agents with their IDs and goals.',
                        parameters: {
                            type: 'object',
                            properties: {}
                        }
                    },
                    {
                        name: 'agent.sendMessageToSubagent',
                        description: 'Send a message, feedback, or add a prompt/instruction to a running sub-agent\'s queue.',
                        parameters: {
                            type: 'object',
                            properties: {
                                subagentId: { type: 'integer', description: 'The ID of the target sub-agent.' },
                                message: { type: 'string', description: 'The message or new instructions/queue details to send.' }
                            },
                            required: ['subagentId', 'message']
                        }
                    },
                    {
                        name: 'agent.stopSubagent',
                        description: 'Terminate/stop a running sub-agent by its ID.',
                        parameters: {
                            type: 'object',
                            properties: {
                                subagentId: { type: 'integer', description: 'The ID of the sub-agent to stop.' }
                            },
                            required: ['subagentId']
                        }
                    },
                    {
                        name: 'agent.getSubagentHistory',
                        description: 'Read the complete chat history/logs of a running sub-agent to monitor its progress.',
                        parameters: {
                            type: 'object',
                            properties: {
                                subagentId: { type: 'integer', description: 'The ID of the sub-agent.' }
                            },
                            required: ['subagentId']
                        }
                    }
                ]
            });

            for await (const chunkGenerator of stream) {
                for await (const part of chunkGenerator) {
                    if (part.done) {
                        // print out the part
                        console.log('🤖 LLM Output:', part);
                        // Check if text contains JSON-formatted function call
                        let functionCallToExecute = part.functionCall;
                        
                        const textToParse = part.text || part.thought;
                        if (textToParse && !functionCallToExecute) {
                            functionCallToExecute = tryExtractFunctionCall(textToParse);
                            if (functionCallToExecute) {
                                console.log('🤖 Parsed JSON function call from text/thought');
                            }
                        }

                        if (textToParse && !functionCallToExecute) {
                            queue({
                                eventName: 'warning',
                                from: 'agent',
                                message: `LLM output was not a function call: ${textToParse}. Please use function calling.`
                            });
                        }

                        if (functionCallToExecute) {
                            const fullName = functionCallToExecute.name;
                            console.log(`🤖 Function call detected: ${fullName}`);
                            toolCalls.push({ text: JSON.stringify(functionCallToExecute) });

                            const [targetApp, toolName] = fullName.includes('.') ? fullName.split('.') : ['unknown', fullName];
                            // Ensure args is always an object
                            const args = functionCallToExecute.args || {};
                            
                            console.log(`🤖 AI calling ${targetApp} -> ${toolName} with`, args);

                            // Execute asynchronously in the background
                            (async () => {
                                try {
                                    let toolRes;
                                    if (fullName === 'agent.spawnSubagent') {
                                        toolRes = await handleSpawnSubagent(args, 'main');
                                    } else if (fullName === 'agent.listSubagents') {
                                        const list = [];
                                        for (const [id, sub] of subAgents.entries()) {
                                            list.push({ id, goal: sub.goal, parentId: sub.parentId });
                                        }
                                        toolRes = { success: true, subagents: list };
                                    } else if (fullName === 'agent.sendMessageToSubagent') {
                                        const sub = subAgents.get(args.subagentId);
                                        if (!sub) {
                                            toolRes = { success: false, message: `Sub-agent ${args.subagentId} not found.` };
                                        } else {
                                            sub.sendMessage(args.message);
                                            toolRes = { success: true, message: `Message sent to sub-agent ${args.subagentId}.` };
                                        }
                                    } else if (fullName === 'agent.stopSubagent') {
                                        const sub = subAgents.get(args.subagentId);
                                        if (!sub) {
                                            toolRes = { success: false, message: `Sub-agent ${args.subagentId} not found.` };
                                        } else {
                                            sub.stop();
                                            toolRes = { success: true, message: `Sub-agent ${args.subagentId} stopped.` };
                                        }
                                    } else if (fullName === 'agent.getSubagentHistory') {
                                        const sub = subAgents.get(args.subagentId);
                                        if (!sub) {
                                            toolRes = { success: false, message: `Sub-agent ${args.subagentId} not found.` };
                                        } else {
                                            toolRes = { success: true, history: sub.history };
                                        }
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
                                        if (!fs.existsSync(socketPath)) {
                                            throw new Error(`No app or socket found for "${targetApp}"`);
                                        }
                                        await server.connect(socketPath);
                                        toolRes = await server.request(targetApp, toolName, args);
                                    }
                                    
                                    console.log(`🤖 Tool [${fullName}] response:`, toolRes);
                                    queue({ name: fullName, output: toolRes, time: (new Date()).toString() });
                                } catch (err) {
                                    console.error(`🤖 Failed to call tool ${fullName}:`, err.message);
                                    queue({
                                        eventName: 'warning',
                                        from: 'agent',
                                        message: `Failed to call tool ${fullName}: ${err.message}. Check or search tools first using tools.search.`
                                    });
                                }
                            })();
                        }
                    }
                }
            }

            if (toolCalls.length > 0) {
                chatHistory.push({ role: 'model', parts: toolCalls });
                saveHistory();
            }

        } catch (err) {
            console.error('🤖 Batch Process Error:', err);
            queue({
                eventName: 'error',
                from: 'agent',
                message: `Error during processing: ${err.message}. please response with function calling to fix the issue or tools.sleep to skip time.`
            });
        }
    } finally {
        isProcessing = false;
    }
};

const toolsSocketPath = path.resolve(__dirname, '../tools/tools.sock');

server.connect(toolsSocketPath).then(() => {
    console.log('🤖 Agent connected to tools server.');
});

// Listener for ANY generic event - with Debounce aggregation
server.subscribe('*', 'event', async (req) => {
    console.log(`🤖 Received [${req.eventName}] from ${req.from}. Queuing...`);
    queue({ req, time: (new Date()).toString() });
});

setTimeout(async () => {
    while (true) {
        try {
            const now = Date.now();
            const inDebounce = (now - lastEventTime) < DEBOUNCE_DELAY;
            const hasEvents = pendingEvents.length > 0;
            
            if (hasEvents && !isProcessing && !inDebounce) {
                const eventsToProcess = [...pendingEvents];
                pendingEvents = [];
                await processEvents(eventsToProcess);
            }
        } catch (err) {
            console.error('Error in agent loop:', err);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}, 1000);

server.start().then(() => {
    console.log('🤖 Agent server is running.');
}).catch(err => {
    console.error('❌ Failed to start agent server:', err);
});
