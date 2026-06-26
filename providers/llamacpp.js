const axios = require('axios');
const BaseProvider = require('#BaseProvider');

const DEFAULT_BASE_URL = 'http://127.0.0.1:12124/v1';

const splitList = (value, fallback = []) => {
    if (Array.isArray(value)) {
        return value.map(item => String(item).trim()).filter(Boolean);
    }

    if (typeof value === 'string') {
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }

    return fallback;
};

const tryExtractFunctionCall = (text) => {
    if (!text) return null;

    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && parsed.name && parsed.args) {
            return parsed;
        }
    } catch (err) {}

    let braceCount = 0;
    let currentStart = -1;

    for (let index = 0; index < text.length; index++) {
        if (text[index] === '{') {
            if (braceCount === 0) currentStart = index;
            braceCount++;
        } else if (text[index] === '}') {
            if (braceCount > 0) {
                braceCount--;
                if (braceCount === 0 && currentStart !== -1) {
                    const candidate = text.substring(currentStart, index + 1);
                    try {
                        const parsed = JSON.parse(candidate);
                        if (parsed && typeof parsed === 'object' && parsed.name && parsed.args) {
                            return parsed;
                        }
                    } catch (err) {
                        index = currentStart;
                    }
                    braceCount = 0;
                    currentStart = -1;
                }
            }
        }
    }

    return null;
};

class LlamaCppProvider extends BaseProvider {
    constructor(config = {}) {
        super(config);
        this.baseURL = String(config.baseURL || process.env.LLAMACPP_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.models = splitList(
            config.models,
            splitList(process.env.LLAMACPP_MODELS, [process.env.LLAMACPP_MODEL || 'local-model'])
        );
        this.embeddingModel = config.embeddingModel || process.env.LLAMACPP_EMBEDDING_MODEL || this.models[0];
        this.apiKey = config.apiKey || process.env.LLAMACPP_API_KEY || process.env.OPENAI_API_KEY || '';
        this.temperature = typeof config.temperature === 'number' ? config.temperature : 0.2;
        this.currentModelIndex = 0;
    }

    _getNextModel() {
        if (this.models.length === 0) {
            throw new Error('No models configured for LlamaCppProvider');
        }

        const model = this.models[this.currentModelIndex];
        this.currentModelIndex = (this.currentModelIndex + 1) % this.models.length;
        return model;
    }

    _toText(part) {
        if (typeof part === 'string') {
            return part;
        }

        if (!part || typeof part !== 'object') {
            return '';
        }

        if (part.text) {
            return part.text;
        }

        if (part.functionCall) {
            return JSON.stringify(part.functionCall);
        }

        if (part.functionResponse) {
            return JSON.stringify({ functionResponse: part.functionResponse });
        }

        if (part.inlineData) {
            const mimeType = part.inlineData.mimeType || 'unknown';
            return `[Unsupported inline data: ${mimeType}]`;
        }

        if (part.attachment) {
            return `[Attachment: ${part.attachment}]`;
        }

        return JSON.stringify(part);
    }

    _buildSystemInstruction(systemInstruction, tools) {
        const systemText = Array.isArray(systemInstruction)
            ? systemInstruction.map(part => this._toText(part)).filter(Boolean).join('\n')
            : (typeof systemInstruction === 'string' ? systemInstruction : '');

        if (!tools || tools.length === 0) {
            return systemText;
        }

        const toolText = tools.map(tool => {
            const description = tool.description ? `: ${tool.description}` : '';
            const schema = tool.parameters ? `\n${JSON.stringify(tool.parameters, null, 2)}` : '';
            return `- ${tool.name}${description}${schema}`;
        }).join('\n');

        const toolInstruction = [
            'You can call a tool by replying with a single JSON object in this exact shape:',
            '{"name":"tool.name","args":{...}}',
            'Do not add markdown fences, explanations, or extra text when calling a tool.',
            'Available tools:',
            toolText
        ].join('\n');

        return [systemText, toolInstruction].filter(Boolean).join('\n\n');
    }

    _buildMessages(contents, systemInstruction, tools) {
        const messages = [];
        const systemText = this._buildSystemInstruction(systemInstruction, tools);

        if (systemText) {
            messages.push({ role: 'system', content: systemText });
        }

        for (const message of contents || []) {
            const role = message.role === 'model' || message.role === 'assistant' ? 'assistant' : 'user';
            const content = (message.parts || []).map(part => this._toText(part)).filter(Boolean).join('\n').trim();

            if (content) {
                messages.push({ role, content });
            }
        }

        return messages;
    }

    _buildToolPayload(tools) {
        if (!tools || tools.length === 0) {
            return undefined;
        }

        return tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description || '',
                parameters: tool.parameters || { type: 'object', properties: {} }
            }
        }));
    }

    _extractToolCalls(message) {
        const toolCalls = [];

        if (Array.isArray(message?.tool_calls)) {
            for (const toolCall of message.tool_calls) {
                const toolName = toolCall?.function?.name || toolCall?.name;
                const rawArgs = toolCall?.function?.arguments || toolCall?.arguments || {};
                let args = rawArgs;

                if (typeof rawArgs === 'string') {
                    try {
                        args = JSON.parse(rawArgs);
                    } catch (err) {
                        args = rawArgs;
                    }
                }

                if (toolName) {
                    toolCalls.push({ name: toolName, args });
                }
            }
        }

        return toolCalls;
    }

    _authHeaders() {
        const headers = { 'Content-Type': 'application/json' };

        if (this.apiKey) {
            headers.Authorization = `Bearer ${this.apiKey}`;
        }

        return headers;
    }

    async *generate(contents, options = {}) {
        const model = options.model || this._getNextModel();
        const messages = this._buildMessages(contents, options.systemInstruction, options.tools);
        const payload = {
            model,
            messages,
            stream: false,
            temperature: options.generationConfig?.temperature ?? this.temperature
        };

        const toolPayload = this._buildToolPayload(options.tools);
        if (toolPayload) {
            payload.tools = toolPayload;
            payload.tool_choice = 'auto';
        }

        const requestUrl = `${this.baseURL}/chat/completions`;

        try {
            const response = await axios.post(requestUrl, payload, {
                headers: this._authHeaders(),
                signal: options.signal,
                timeout: options.timeout || 0
            });

            const message = response.data?.choices?.[0]?.message || response.data?.message || {};
            const toolCalls = this._extractToolCalls(message);

            if (toolCalls.length > 0) {
                for (const toolCall of toolCalls) {
                    yield (async function* () {
                        yield { functionCall: toolCall, done: true };
                    })();
                }
                return;
            }

            const text = typeof message.content === 'string'
                ? message.content
                : Array.isArray(message.content)
                    ? message.content.map(part => this._toText(part)).join('\n')
                    : '';

            const functionCall = tryExtractFunctionCall(text.trim());
            if (functionCall) {
                yield (async function* () {
                    yield { functionCall, done: true };
                })();
                return;
            }

            yield (async function* () {
                yield { text: text.trim(), done: true };
            })();
        } catch (err) {
            const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
            throw new Error(`LlamaCppProvider request failed: ${message}`);
        }
    }

    async embed(parts, options = {}) {
        const model = options.model || this.embeddingModel || this._getNextModel();
        const input = (parts || []).map(part => this._toText(part)).filter(Boolean).join('\n').trim();
        const requestUrl = `${this.baseURL}/embeddings`;

        try {
            const response = await axios.post(requestUrl, { model, input }, {
                headers: this._authHeaders(),
                signal: options.signal,
                timeout: options.timeout || 0
            });

            const embedding = response.data?.data?.[0]?.embedding
                || response.data?.embedding
                || response.data?.embedding?.values
                || [];

            return Array.isArray(embedding) ? embedding : [];
        } catch (err) {
            const message = err.response?.data ? JSON.stringify(err.response.data) : err.message;
            console.error(`[LlamaCppProvider] ❌ Embedding error:`, message);
            return [];
        }
    }
}

module.exports = LlamaCppProvider;