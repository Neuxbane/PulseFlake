require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const UnixSocket = require('#UnixSocket');
const createProvider = require('../../utils/createProvider');
const path = require('path');
const fs = require('fs');

const apiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
const models = process.env.GEMINI_MODELS ? process.env.GEMINI_MODELS.split(',') : ["gemma-4-26b-a4b-it"];
const provider = createProvider({ apiKeys, models });

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
                    console.error('[subagent] Failed to embed turn context:', e.message);
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
            console.error('[subagent] Failed to embed query:', e.message);
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

            const latestUserMessage = history[history.length - 1];
            const queryText = latestUserMessage && latestUserMessage.parts ? latestUserMessage.parts.map(p => p.text || '').join(' ').trim() : '';

            const stream = provider.generate(await truncateHistory(history, queryText), {
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
