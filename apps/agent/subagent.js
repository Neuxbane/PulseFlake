require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const UnixSocket = require('#UnixSocket');
const { GeminiProvider } = require('#Providers');
const path = require('path');
const fs = require('fs');

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

const truncateHistory = (history) => {
    const RAM_LIMIT = 50;
    const ANCHOR_TURN_LIMIT = 10;

    if (!history || history.length === 0) return [];
    if (history.length <= RAM_LIMIT) {
        let updatedHistory = [...history];
        while (updatedHistory.length > 1 && updatedHistory[0].role !== 'user') {
            updatedHistory.shift();
        }
        return updatedHistory;
    }

    const ram = history.slice(-RAM_LIMIT);
    const anchorCandidates = history.slice(0, history.length - RAM_LIMIT);
    const turns = [];
    let currentTurn = null;

    for (const msg of anchorCandidates) {
        if (msg.role === 'user') {
            if (currentTurn) {
                turns.push(currentTurn);
            }
            currentTurn = { user: msg, model: null };
        } else if ((msg.role === 'model' || msg.role === 'assistant') && currentTurn) {
            currentTurn.model = msg;
        }
    }
    if (currentTurn) {
        turns.push(currentTurn);
    }

    const recentTurns = turns.slice(-ANCHOR_TURN_LIMIT);
    const compressedAnchor = [];
    for (const turn of recentTurns) {
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

// Bootstrap properties
let id, parentId, instruction, goal, toolsForAI;
let history = [];
let isRunning = true;
let socketClient = null;

process.on('message', async (msg) => {
    if (msg.type === 'init') {
        id = msg.id;
        parentId = msg.parentId;
        instruction = msg.instruction;
        goal = msg.goal;
        toolsForAI = msg.toolsForAI;
        history = [
            { role: 'user', parts: [{ text: `Sub-agent initialized. Goal: ${goal}` }] }
        ];
        
        socketClient = new UnixSocket(`subagent-${id}`);
        console.log(`🤖 [SubAgent Process ${id}] Initialized with goal: "${goal}"`);
        
        // Start running the loop
        run().catch(err => {
            console.error(`🤖 [SubAgent Process ${id}] Execution error:`, err);
            process.send({ type: 'done', message: `Error: ${err.message}` });
            process.exit(1);
        });
    } else if (msg.type === 'message') {
        history.push({ role: 'user', parts: [{ text: `MESSAGE FROM PARENT: ${msg.message}` }] });
        console.log(`🤖 [SubAgent Process ${id}] Received message from parent: "${msg.message}"`);
        process.send({ type: 'history', history });
    } else if (msg.type === 'stop') {
        console.log(`🤖 [SubAgent Process ${id}] Stop signal received from parent.`);
        isRunning = false;
        process.send({ type: 'done', message: "Terminated by parent agent." });
        process.exit(0);
    }
});

async function run() {
    while (isRunning) {
        try {
            const systemInstruction = `${instruction}\n\n### SUB-AGENT GOAL\n${goal}\n\nYou are a sub-agent. When your task is complete or you have a final report, use \`agent.done\` to finish and report back to your parent.`;
            
            process.send({ type: 'history', history });

            const stream = provider.generate(truncateHistory(history), {
                systemInstruction,
                thinkingConfig: { include_thoughts: true },
                tools: [
                    ...toolsForAI,
                    {
                        name: 'agent.done',
                        description: 'Finish the sub-agent task and report the result back to the parent agent.',
                        parameters: {
                            type: 'object',
                            properties: {
                                message: { type: 'string', description: 'The final report or result message.' }
                            },
                            required: ['message']
                        }
                    }
                ]
            });

            for await (const chunkGenerator of stream) {
                for await (const part of chunkGenerator) {
                    if (part.done) {
                        let functionCall = part.functionCall;
                        const textToParse = part.text || part.thought;
                        if (textToParse && !functionCall) {
                            functionCall = tryExtractFunctionCall(textToParse);
                        }

                        if (functionCall) {
                            history.push({ role: 'model', parts: [{ text: JSON.stringify(functionCall) }] });
                            console.log(`🤖 [SubAgent Process ${id}] Calling ${functionCall.name}`);

                            if (functionCall.name === 'agent.done') {
                                isRunning = false;
                                process.send({ type: 'done', message: functionCall.args.message });
                                process.send({ type: 'history', history });
                                process.exit(0);
                            }

                            // Execute normal tools
                            const [targetApp, toolName] = functionCall.name.includes('.') ? functionCall.name.split('.') : ['unknown', functionCall.name];
                            try {
                                const socketPath = path.resolve(__dirname, `../${targetApp}/${targetApp}.sock`);
                                if (!fs.existsSync(socketPath)) throw new Error(`No app or socket found for "${targetApp}"`);
                                await socketClient.connect(socketPath);
                                const res = await socketClient.request(targetApp, toolName, functionCall.args);
                                history.push({ 
                                    role: 'user', 
                                    parts: [{ text: `TOOL_RESULT [${functionCall.name}]: ${JSON.stringify(res)}` }] 
                                });
                            } catch (err) {
                                history.push({ 
                                    role: 'user', 
                                    parts: [{ text: `TOOL_ERROR [${functionCall.name}]: ${err.message}` }] 
                                });
                            }
                            process.send({ type: 'history', history });
                        } else if (part.text || part.thought) {
                            history.push({ role: 'model', parts: [{ text: part.text || part.thought }] });
                            history.push({ role: 'user', parts: [{ text: "Please use function calling to perform actions or finish the task with agent.done." }] });
                            process.send({ type: 'history', history });
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`🤖 [SubAgent Process ${id}] Loop error:`, err);
            isRunning = false;
            process.send({ type: 'done', message: `Error in sub-agent loop: ${err.message}` });
            process.exit(1);
        }
    }
}
