const { GoogleGenAI } = require('@google/genai');
const BaseProvider = require('#BaseProvider');

class GeminiProvider extends BaseProvider {
    /**
     * @param {Object} config
     * @param {string[]} config.apiKeys - list of API keys for rotation
     * @param {string[]} [config.models] - list of models to rotate through
     */
    constructor(config = {}) {
        super(config);
        this.apiKeys = config.apiKeys || [];
        this.models = config.models || ["gemini-3.1-flash-lite-preview"];
        this.currentApiKeyIndex = 0;
        this.currentModelIndex = 0;
    }

    _getNextTarget() {
        if (this.apiKeys.length === 0) {
            throw new Error("No API keys provided for GeminiProvider");
        }
        const apiKey = this.apiKeys[this.currentApiKeyIndex];
        const model = this.models[this.currentModelIndex];
        
        this.currentModelIndex++;
        if (this.currentModelIndex >= this.models.length) {
            this.currentModelIndex = 0;
            this.currentApiKeyIndex = (this.currentApiKeyIndex + 1) % this.apiKeys.length;
        }

        return { apiKey, model };
    }

    /**
     * Implements the 2-loop nested generator pattern with smart part splitting.
     */
    async *generate(contents, options = {}) {
        const { 
            systemInstruction, 
            tools, 
            toolConfig, 
            safetySettings, 
            generationConfig,
            signal 
        } = options;

        const maxRetries = this.apiKeys.length * this.models.length;
        let lastError = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            if (signal?.aborted) throw new Error('canceled');
            
            const { apiKey, model: targetModel } = this._getNextTarget();
            console.log(`[GeminiProvider] 🚀 Attempt ${attempt + 1} using model: ${targetModel}`);
            const ai = new GoogleGenAI({ apiKey });

            try {
                // Properly format contents for Gemini SDK
                const formattedContents = contents.map(c => ({
                    role: c.role === 'assistant' ? 'model' : c.role,
                    parts: c.parts.map(p => {
                        if (typeof p === 'string') return { text: p };
                        if (p.text) return { text: p.text };
                        if (p.inlineData) return { inlineData: p.inlineData };
                        if (p.functionCall) {
                            // Ensure args are a plain object, not stringified JSON
                            let args = p.functionCall.args;
                            if (typeof args === 'string') {
                                try { args = JSON.parse(args); } catch(e) {}
                            }
                            return { functionCall: { name: p.functionCall.name, args } };
                        }
                        if (p.functionResponse) return { functionResponse: p.functionResponse };
                        return p;
                    })
                }));

                // Ensure systemInstruction parts are formatted correctly
                let sysInst = undefined;
                if (systemInstruction) {
                    const parts = Array.isArray(systemInstruction) 
                        ? systemInstruction.map(p => typeof p === 'string' ? { text: p } : p)
                        : [{ text: systemInstruction }];
                    sysInst = { role: 'system', parts };
                }

                console.log(`[GeminiProvider] 📤 Sending request with ${formattedContents.length} items in history`);
                
                // Construct config following the latest @google/genai (v0.7.0) pattern
                // Tools should be inside functionDeclarations for this version's schema
                const response = await ai.models.generateContentStream({
                    model: targetModel,
                    contents: formattedContents,
                    config: {
                        tools: tools && tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
                        toolConfig,
                        safetySettings,
                        generationConfig,
                        systemInstruction: sysInst
                    }
                });

                let currentQueue = [];
                let resolveNext = null;
                let streamEnded = false;
                let processingError = null;

                // This handles the bridging between Gemini's single stream 
                // and our multi-generator contract.
                const processStream = async () => {
                    try {
                        console.log(`[GeminiProvider] 📥 Starting to process stream chunks...`);
                        for await (const chunk of response) {
                            if (signal?.aborted) break;

                            const parts = [];
                            
                            // Native extraction as per @google/genai documentation
                            if (chunk.text && typeof chunk.text === 'function') {
                                try {
                                    const textValue = chunk.text();
                                    if (textValue) parts.push({ type: 'text', data: { text: textValue }, done: false });
                                } catch (e) {
                                    // chunk.text() throws if no text is present (e.g. just function calls)
                                }
                            } else if (chunk.text && typeof chunk.text === 'string') {
                                parts.push({ type: 'text', data: { text: chunk.text }, done: false });
                            }
                            
                            if (chunk.functionCalls) {
                                for (const call of chunk.functionCalls) {
                                    parts.push({ type: 'functionCall', data: { functionCall: call }, done: false });
                                }
                            }

                            if (parts.length > 0) {
                                console.log(`[GeminiProvider] 🧩 Received ${parts.length} parts in chunk`);
                                for (const part of parts) {
                                    currentQueue.push(part);
                                }
                                if (resolveNext) {
                                    const res = resolveNext;
                                    resolveNext = null;
                                    res();
                                }
                            }
                        }
                    } catch (e) {
                        console.error(`[GeminiProvider] ❌ Stream processing error:`, e.message);
                        processingError = e;
                    } finally {
                        console.log(`[GeminiProvider] 🏁 Stream ended`);
                        streamEnded = true;
                        if (resolveNext) resolveNext();
                    }
                };

                // Start processing the stream in the background
                processStream();

                while (!streamEnded || currentQueue.length > 0) {
                    if (currentQueue.length === 0) {
                        // Wait for more data or end of stream
                        await new Promise(r => resolveNext = r);
                        if (streamEnded && currentQueue.length === 0) break;
                    }

                    if (processingError) {
                        console.error(`[GeminiProvider] 🛑 Breaking yield loop due to processing error`);
                        throw processingError;
                    }

                    const firstPart = currentQueue[0];
                    const partType = firstPart.type;
                    console.log(`[GeminiProvider] 📤 Yielding generator for part type: ${partType}`);

                    // Yield a generator for this specific type of part
                    yield (async function* (thisProvider) {
                        let accumulated = {};
                        // While we have parts of the same type, yield them
                        while (currentQueue.length > 0 && currentQueue[0].type === partType) {
                            const part = currentQueue[0];
                            accumulated = thisProvider.mergeAndConcat(accumulated, part.data);
                            
                            // Check if there are more parts of the SAME type immediately available
                            // If NOT, we yield with done: true to signal the end of this conceptual chunk
                            currentQueue.shift();
                            const isLastOfCurrentType = currentQueue.length === 0 || currentQueue[0].type !== partType;
                            
                            yield { ...part.data, done: isLastOfCurrentType };
                        }
                        
                        return accumulated;
                    })(this);
                }

                console.log(`[GeminiProvider] ✅ Generation sequence complete`);
                return; // Success

            } catch (e) {
                lastError = e;
                const isRetryable = e.message.includes('429') || 
                                  e.message.includes('RESOURCE_EXHAUSTED') || 
                                  e.message.includes('500') ||
                                  e.message.includes('503');
                
                if (!isRetryable || attempt === maxRetries - 1) break;
                await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
            }
        }

        throw lastError;
    }

    /**
     * Multimodal embedding (unified vector)
     */
    async embed(parts, options = {}) {
        const { model: targetModel = "gemini-embedding-2-preview" } = options;

        const { apiKey } = this._getNextTarget();
        const ai = new GoogleGenAI({ apiKey });

        try {

            const response = await ai.models.embedContent({
                model: targetModel,
                contents: { parts }
            });

            // Handle the embeddings response format
            // The API returns { embeddings: [{ values: [...] }, ...] }
            if (response && response.embeddings && response.embeddings[0]) {
                return response.embeddings[0].values;
            } else if (response && response.embedding && response.embedding.values) {
                return response.embedding.values;
            } else {
                // Fallback for tool embedding - non-critical
                console.warn('[GEMINI] Embedding response structure unexpected, returning empty vector');
                return [];
            }
        } catch (e) {
            console.error(`[GeminiProvider] ❌ Embedding error:`, e.message);
        }
        
        // For tool embeddings, failing gracefully is acceptable
        console.warn('[GEMINI] Embedding failed, tool still registered');
        return [];
    }
}

module.exports = GeminiProvider;
