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
let chatHistory = [];
if (fs.existsSync(historyPath)) {
    try {
        chatHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    } catch (e) {
        console.error('Failed to load history:', e);
    }
}

const saveHistory = () => {
    fs.writeFileSync(historyPath, JSON.stringify(chatHistory.slice(-100), null, 2));
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
        eventsToProcess.forEach(events => {
            chatHistory.push({ role: 'user', parts: [{ text: `INCOMING_EVENT: ${JSON.stringify(events)}` }] });
        });
        
        const messages = chatHistory.slice(-100);

        let systemInstruction = `You are a helpful AI agent logic engine. 
You receive raw EVENT objects from various apps.
To interact, you MUST call tools using the format 'appIdentifier.toolName'.`;

        if (fs.existsSync(instructionPath)) {
            try {
                systemInstruction = fs.readFileSync(instructionPath, 'utf8');
            } catch (e) {
                console.error('Failed to load instruction:', e);
            }
        }

        console.log('🤖 Thinking...');
        const stream = provider.generate(messages, { systemInstruction, tools: [...toolsForAI, {
            name: 'agent.updateInstruction',
            description: 'Update the agent system instruction/personality.',
            parameters: {
                type: 'object',
                properties: {
                    instruction: { type: 'string', description: 'The new system instruction' }
                },
                required: ['instruction']
            }
        }] });

        for await (const chunkGenerator of stream) {
            let accumulated = {};
            for await (const part of chunkGenerator) {
                if (part.text) {
                    accumulated.text = (accumulated.text || '') + part.text;
                }
                if (part.functionCall) {
                    accumulated.functionCall = part.functionCall;
                }

                if (part.done) {
                    const result = accumulated;
                    if (result.functionCall) {
                        chatHistory.push({ role: 'model', parts: [{ functionCall: result.functionCall }] });
                        saveHistory();

                        const fullName = result.functionCall.name;
                        const [targetApp, toolName] = fullName.includes('.') ? fullName.split('.') : ['unknown', fullName];
                        const args = result.functionCall.args;
                        
                        console.log(`🤖 AI calling ${targetApp} -> ${toolName} with`, args);

                        try {
                            let toolRes;
                            if (fullName === 'agent.updateInstruction') {
                                fs.writeFileSync(instructionPath, args.instruction);
                                toolRes = { success: true, message: 'Instruction updated.' };
                                console.log('🤖 System instruction updated.');
                            } else {
                                const socketPath = path.resolve(__dirname, `../${targetApp}/${targetApp}.sock`);
                                await server.connect(socketPath);
                                toolRes = await server.request(targetApp, toolName, args);
                            }
                            
                            console.log(`🤖 Tool [${fullName}] response:`, toolRes);
                            chatHistory.push({ 
                                role: 'user', 
                                parts: [{ 
                                    functionResponse: { 
                                        name: fullName, 
                                        response: { output: JSON.stringify(toolRes) } 
                                    } 
                                }] 
                            });
                            saveHistory();

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
