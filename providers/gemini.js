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
        this.models = config.models || ["gemini-3.1-flash-lite-preview", "gemma-4-31b-it"];
        this.currentApiKeyIndex = 0;
        this.currentModelIndex = 0;
        this.lastCallTime = 0;
        this.minWaitMs = config.minWaitMs || 5000; // Default 3 seconds
    }

    async _waitForRateLimit() {
        const now = Date.now();
        const elapsed = now - this.lastCallTime;
        if (elapsed < this.minWaitMs) {
            const waitTime = this.minWaitMs - elapsed;
            console.log(`[GeminiProvider] ⏳ Rate limiting: waiting ${waitTime}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.lastCallTime = Date.now();
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
            thinkingConfig,
            responseModalities,
            imageConfig,
            signal 
        } = options;

        const maxRetries = this.apiKeys.length * this.models.length;
        let lastError = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            if (signal?.aborted) throw new Error('canceled');
            
            await this._waitForRateLimit();
            
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
                        systemInstruction: sysInst,
                        thinkingConfig,
                        responseModalities,
                        imageConfig
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
                        let lastPartType = null;

                        for await (const chunk of response) {
                            // print chunck
                            console.log(`[GeminiProvider] Received chunk:`, JSON.stringify(chunk.candidates?.[0]?.content));
                            if (signal?.aborted) break;

                            const parts = [];
                            
                            // Check if this chunk indicates the stream is finishing
                            const isStreamEnding = chunk.candidates?.[0]?.finishReason === 'STOP';
                            
                            // Native extraction as per @google/genai documentation
                            const contentCandidate = chunk.candidates?.[0]?.content;
                            if (contentCandidate && contentCandidate.parts) {
                                for (const part of contentCandidate.parts) {
                                    if (part.text) {
                                        parts.push({ type: 'text', data: { text: part.text }, done: isStreamEnding });
                                    } else if (part.inlineData) {
                                        parts.push({ type: 'image', data: { inlineData: part.inlineData }, done: isStreamEnding });
                                    } else if (part.functionCall) {
                                        parts.push({ type: 'functionCall', data: { functionCall: part.functionCall }, done: isStreamEnding });
                                    }
                                }
                            }

                            if (parts.length > 0) {
                                // console.log(`[GeminiProvider] 🧩 Received ${parts.length} parts in chunk`);
                                for (const part of parts) {
                                    // CRITICAL: We only push to queue. The outer logic handles 
                                    // grouping consecutive parts of the same type into one generator.
                                    currentQueue.push(part);
                                }
                            }
                            
                            // If stream is ending, mark it and wake up any waiting generators
                            if (isStreamEnding) {
                                streamEnded = true;
                                if (parts.length === 0 && resolveNext) {
                                    const res = resolveNext;
                                    resolveNext = null;
                                    res();
                                }
                            } else if (parts.length > 0 && resolveNext) {
                                const res = resolveNext;
                                resolveNext = null;
                                res();
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
                        let hasYielded = false;
                        
                        // While we have parts of the same type, yield them
                        while (true) {
                            if (currentQueue.length === 0) {
                                // Wait for more data
                                await new Promise(r => resolveNext = r);
                            }

                            // If different type next, exit this generator
                            if (currentQueue.length > 0 && currentQueue[0].type !== partType) {
                                break;
                            }

                            // CRITICAL FIX: If we are dealing with function calls, 
                            // we should only handle ONE part per generator to avoid merging
                            // multiple distinct function calls into a single one.
                            if (partType === 'functionCall' && hasYielded) {
                                break;
                            }

                            // If nothing in queue and stream ended, this part is DONE
                            if (currentQueue.length === 0 && streamEnded) {
                                if (hasYielded && Object.keys(accumulated).length > 0) {
                                    // Yield one more time with done: true to signal completion
                                    yield { ...accumulated, done: true };
                                }
                                break;
                            }

                            // If nothing in queue, wait again
                            if (currentQueue.length === 0) {
                                continue;
                            }

                            // Pop next part of this type
                            const currentPart = currentQueue.shift();
                            accumulated = thisProvider.mergeAndConcat(accumulated, currentPart.data);
                            hasYielded = true;

                            // Check if there are more parts of the SAME type coming or stream is over
                            const hasMoreOfSameType = currentQueue.length > 0 && currentQueue[0].type === partType;
                            
                            // If it's a functionCall, we never want to merge it with the next one in the same generator
                            const isFinished = (partType === 'functionCall') || (!hasMoreOfSameType && streamEnded);

                            if (partType === 'text') {
                                yield { text: currentPart.data.text, done: isFinished };
                            } else if (partType === 'image') {
                                yield { inlineData: currentPart.data.inlineData, done: isFinished };
                            } else {
                                yield { functionCall: currentPart.data.functionCall, done: isFinished };
                            }

                            if (isFinished) {
                                yield { result: accumulated, done: true };
                                break;
                            }
                        }
                        
                        return accumulated;
                    })(this);
                }

                console.log(`[GeminiProvider] ✅ Generation sequence complete`);
                return; // Success

            } catch (e) {
                console.error(`[GeminiProvider] ❌ Error on attempt ${attempt + 1}:`, e.message);
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

        await this._waitForRateLimit();

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
