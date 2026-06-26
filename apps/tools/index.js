require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const server = new (require('#UnixSocket'))("tools");

const apiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];
const models = process.env.GEMINI_MODELS ? process.env.GEMINI_MODELS.split(',') : ["gemini-3.1-flash-lite-preview"];

const provider = require('../../utils/createProvider')({ apiKeys, models });

let tools = {};
let toolEmbeddings = {};
let appInstructions = {
    tools: "Registry for all available system tools, supporting semantic search (RAG) and keyword strict-search."
};

const cosineSimilarity = (vecA, vecB) => {
    const dotProduct = vecA.reduce((sum, a, idx) => sum + a * vecB[idx], 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    return dotProduct / (magnitudeA * magnitudeB);
}

server.listen('*', 'register', async(req, res) => {
  const toolName = req.from;
  const payload = req.data;
  
  let toolsToRegister = [];
  let appInstruction = "";
  
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.tools) {
    toolsToRegister = Array.isArray(payload.tools) ? payload.tools : [payload.tools];
    appInstruction = payload.instruction || "";
  } else {
    toolsToRegister = Array.isArray(payload) ? payload : [payload];
  }
  
  if (appInstruction) {
    appInstructions[toolName] = appInstruction;
    console.log(`🔧 Registered instruction for app: ${toolName}`);
  }
  
  // Store tool with its originating identifier
  if (!tools[toolName]) tools[toolName] = [];
  
  for (const info of toolsToRegister) {
    const toolActualName = info.name;
    const fullToolName = `${toolName}.${toolActualName}`;
    try {
      const vector = await provider.embed([{text: `${info.description} ${JSON.stringify(info.parameters)}`}]);
      toolEmbeddings[fullToolName] = vector;
      // Keep a reference to the full tool definition
      if (!tools[toolName].find(t => t.name === toolActualName)) {
        tools[toolName].push(info);
      }
      console.log(`🔧 Registered scoped tool: ${fullToolName}`);
    } catch (err) {
      console.error(`❌ Registration Error for ${fullToolName}:`, err.message);
    }
  }
  res.send({ success: true });
});

server.listen('*', 'getInstructions', async(req, res) => {
    res.send(appInstructions);
});

// Sending the tools's tools
server.listen('*', 'built-in', async(req, res) => {
    res.send(tools['tools'].map(t => ({ ...t, name: `tools.${t.name}` })));
});

server.listen('*', 'listApps', async (req, res) => {
    res.send(Object.keys(tools));
});

server.listen('*', 'listAppTools', async (req, res) => {
    const appName = req.data?.app || req.data?.identifier || req.data;
    if (!appName || typeof appName !== 'string') {
        return res.send({ success: false, error: 'app name is required' });
    }
    const list = tools[appName] || [];
    res.send(list.map(t => ({
        ...t,
        fullName: `${appName}.${t.name}`,
        identifier: appName
    })));
});

server.listen('*', 'search', async(req, res) => {
    try {
        const query = req.data?.query || (typeof req.data === 'string' ? req.data : '');
        const appFilter = req.data?.app;
        if (!query) {
            return res.send([]);
        }
        const queryEmbedding = await provider.embed([{text: query}]);
        let results = Object.entries(toolEmbeddings).map(([fullToolName, embedding]) => {
            const similarity = cosineSimilarity(queryEmbedding, embedding);
            const [identifier, name] = fullToolName.split('.');
            const definition = tools[identifier]?.find(t => t.name === name);
            return { 
                fullName: fullToolName, 
                identifier, 
                name, 
                similarity,
                definition,
                searchMethod: 'rag'
            };
        });

        if (appFilter) {
            results = results.filter(r => r.identifier === appFilter);
        }

        res.send(results.sort((a, b) => b.similarity - a.similarity).slice(0, 20));
    } catch (err) {
        console.error(`[tools] Search (RAG) error:`, err.message);
        res.send([]);
    }
});

// Contain rules based search - keyword matching
server.listen('*', 'strict-search', async(req, res) => {
    try {
        const query = req.data?.query || (typeof req.data === 'string' ? req.data : '');
        const appFilter = req.data?.app;
        if (!query) {
            return res.send([]);
        }
        
        // Extract keywords (split by space, remove special chars, lowercase)
        const keywords = query.toLowerCase()
            .split(/\s+/)
            .filter(k => k.length > 2)
            .map(k => k.replace(/[^a-z0-9]/g, ''));

        const results = [];
        
        for (const [identifier, toolList] of Object.entries(tools)) {
            if (appFilter && identifier !== appFilter) continue;

            for (const definition of toolList) {
                const fullToolName = `${identifier}.${definition.name}`;
                
                // Build searchable text from tool name and description only
                const searchText = `${definition.name} ${definition.description}`.toLowerCase();
                
                // Count how many keywords match
                let matchCount = 0;
                for (const keyword of keywords) {
                    if (searchText.includes(keyword)) {
                        matchCount++;
                    }
                }
                
                // Only include tools that have at least one keyword match
                if (matchCount > 0) {
                    results.push({
                        fullName: fullToolName,
                        identifier,
                        name: definition.name,
                        matchCount,
                        definition,
                        searchMethod: 'strict'
                    });
                }
            }
        }
        
        // Sort by match count (descending) and limit to 20
        results.sort((a, b) => b.matchCount - a.matchCount);
        res.send(results.slice(0, 20));
    } catch (err) {
        console.error(`[tools] Strict search error:`, err.message);
        res.send([]);
    }
});

server.listen('*', 'dump', async(req, res) => {
    const allTools = [];
    for (const [identifier, toolList] of Object.entries(tools)) {
        for (const definition of toolList) {
            allTools.push({
                identifier,
                name: definition.name,
                fullName: `${identifier}.${definition.name}`,
                definition
            });
        }
    }
    res.send(allTools);
});

server.listen('*', 'sleep', async(req, res) => {
    const { duration, until } = req.data;
    let sleepTime = 0;

    if (duration) {
        sleepTime = duration * 1000;
    } else if (until) {
        const untilTime = new Date(until).getTime();
        const now = Date.now();
        sleepTime = untilTime - now;
    }

    if (sleepTime > 0) {
        console.log(`🛠️ Sleeping for ${sleepTime} ms...`);
        await new Promise(r => setTimeout(r, sleepTime));
    }

    res.send({ success: true });
});

server.start().then(() => {
    console.log('🛠️  Tools server is running and ready to accept registrations and searches.');

    // No need to call server.request here, as we are the server.
    // Instead, we just manually populate the tools object.
    const internalTools = [
        {
            name: 'sleep',
            description: 'Sleep for a specified duration',
            parameters: {
                type: 'object',
                properties: {
                    duration: { type: 'number', description: 'Duration in seconds' },
                    until: { type: 'string', description: 'Sleep until a specific ISO timestamp, please be aware about the timezone' }
                },
                oneOf: [
                    { required: ['duration'] },
                    { required: ['until'] }
                ]
            }
        },
        {
            name: 'listApps',
            description: 'List all registered app names/services in the ecosystem.',
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'listAppTools',
            description: 'List all registered tools for a specific app name.',
            parameters: {
                type: 'object',
                properties: {
                    app: { type: 'string', description: 'The exact name/identifier of the app (e.g. "calendar", "whatsapp", "tools")' }
                },
                required: ['app']
            }
        },
        {
            name: 'search',
            description: 'Search for tools relevant to a query using RAG/embedding similarity. Optionally filter by a specific app.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query' },
                    app: { type: 'string', description: 'Optional name of the app to restrict search to' }
                },
                required: ['query']
            }
        },
        {
            name: 'strict-search',
            description: 'Search for tools relevant to a query using keyword matching. Optionally filter by a specific app.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query with keywords' },
                    app: { type: 'string', description: 'Optional name of the app to restrict search to' }
                },
                required: ['query']
            }
        }
    ];

    tools['tools'] = internalTools;
    for (const info of internalTools) {
        const fullToolName = `tools.${info.name}`;
        provider.embed([{text: `${info.description} ${JSON.stringify(info.parameters)}`}]).then(embedding => {
            if (embedding && embedding[0] && embedding[0].embedding) {
                toolEmbeddings[fullToolName] = embedding[0].embedding;
                console.log(`🔧 Registered internal tool: ${fullToolName}`);
            }
        });
    }
}).catch(err => {
    console.error('❌ Failed to start tools server:', err);
});
