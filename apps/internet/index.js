const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const cheerio = require('cheerio');
const path = require('path');
const server = new (require('#UnixSocket'))("internet");

const internetTools = [
    {
        name: 'search',
        description: "Search the web for real-time information using DuckDuckGo (Tor-based).",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The search query" }
            },
            required: ["query"]
        }
    }
];

const searchHandler = async (params) => {
    const query = params.query || '';
    console.log(`🌐 Searching for: ${query}`);
    
    try {
        const onionUrl = `https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/html/?q=${encodeURIComponent(query)}`;
        const curlCommand = `curl -s --max-time 30 --socks5-hostname 127.0.0.1:9050 -L -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36" "${onionUrl}"`;
        
        const { stdout: responseData } = await execPromise(curlCommand);
        
        if (!responseData || responseData.length < 500) {
            return { error: 'Empty or too short response from search engine. Is Tor running?' };
        }

        const $ = cheerio.load(responseData);
        const results = [];
        $('.result').each((_, el) => {
            const titleElem = $(el).find('.result__title a');
            const title = titleElem.text().trim();
            let rawUrl = titleElem.attr('href');
            
            if (rawUrl && rawUrl.startsWith('/l/?')) {
                try {
                    const urlParams = new URL(rawUrl, 'https://duckduckgo.com').searchParams;
                    rawUrl = urlParams.get('uddg') || rawUrl;
                } catch (e) {}
            }

            const desc = $(el).find('.result__snippet').text().trim();
            if (title && rawUrl) {
                results.push({ title, url: rawUrl, description: desc });
            }
        });

        return results;
    } catch (err) {
        console.error(`🌐 Search error: ${err.message}`);
        return { error: err.message };
    }
};

const toolsSocketPath = path.resolve(__dirname, '../tools/tools.sock');

server.connect(toolsSocketPath,async () => {
    console.log('🌐 Internet app connected to tools server.');
    
    try {
        await server.request('tools', 'register', internetTools);
        console.log(`🌐 Registered tools with RAG server`);
    } catch (err) {
        console.error(`🌐 Registration failed:`, err.message);
    }

    server.broadcast('register', internetTools);
});

server.listen('*', 'search', async (req, res) => {
    console.log(`🌐 Received search request:`, req.data);
    const result = await searchHandler(req.data);
    res.send(result);
});

server.start().then(() => {
    console.log('🌐 Internet service running.');
});
