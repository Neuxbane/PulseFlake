const { GeminiProvider, LlamaCppProvider } = require('#Providers');

const splitList = (value, fallback = []) => {
    if (Array.isArray(value)) {
        return value.map(item => String(item).trim()).filter(Boolean);
    }

    if (typeof value === 'string') {
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }

    return fallback;
};

const createProvider = (options = {}) => {
    const geminiApiKeys = splitList(options.apiKeys, splitList(process.env.GEMINI_API_KEYS, []));
    const providerName = String(
        options.provider
        || process.env.LLM_PROVIDER
        || (process.env.LLAMACPP_BASE_URL || geminiApiKeys.length === 0 ? 'llamacpp' : 'gemini')
    ).toLowerCase();

    if (providerName === 'llamacpp') {
        return new LlamaCppProvider({
            baseURL: options.baseURL || process.env.LLAMACPP_BASE_URL || 'http://127.0.0.1:12124/v1',
            models: splitList(
                options.llamaModels,
                splitList(process.env.LLAMACPP_MODELS, [process.env.LLAMACPP_MODEL || 'local-model'])
            ),
            embeddingModel: options.embeddingModel || process.env.LLAMACPP_EMBEDDING_MODEL,
            apiKey: options.apiKey || process.env.LLAMACPP_API_KEY || process.env.OPENAI_API_KEY,
            temperature: typeof options.temperature === 'number' ? options.temperature : undefined
        });
    }

    return new GeminiProvider({
        apiKeys: geminiApiKeys,
        models: splitList(options.models, splitList(process.env.GEMINI_MODELS, ['gemma-4-26b-a4b-it']))
    });
};

module.exports = createProvider;