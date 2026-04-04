/**
 * @typedef {Object} TextPart
 * @property {string} text
 */

/**
 * @typedef {Object} ImageData
 * @property {string} data - Base64 encoded image data
 * @property {string} mimeType - MIME type (e.g., 'image/png', 'image/jpeg')
 */

/**
 * @typedef {Object} ImagePart
 * @property {ImageData} inlineData
 */

/**
 * @typedef {Object} FunctionArgs
 * @property {string} [key] - Dynamic argument key-value pairs
 */

/**
 * @typedef {Object} FunctionCallInfo
 * @property {string} name - Function name to call
 * @property {FunctionArgs} args - Function arguments
 */

/**
 * @typedef {Object} FunctionCallPart
 * @property {FunctionCallInfo} functionCall
 */

/**
 * @typedef {Object} FunctionResponseData
 * @property {string} [key] - Dynamic response key-value pairs
 */

/**
 * @typedef {Object} FunctionResponseInfo
 * @property {string} name - Function name
 * @property {FunctionResponseData} response - Function response
 */

/**
 * @typedef {Object} FunctionResponsePart
 * @property {FunctionResponseInfo} functionResponse
 */

/**
 * @typedef {Object} ExecutableCode
 * @property {string} code - The code to execute
 * @property {string} language - The language of the code (e.g., 'python')
 */

/**
 * @typedef {Object} ExecutableCodePart
 * @property {ExecutableCode} executableCode
 */

/**
 * @typedef {Object} CodeExecutionResult
 * @property {string} output - The output of the executed code
 * @property {string} outcome - The result outcome ('OK', 'FAILED')
 */

/**
 * @typedef {Object} CodeExecutionResultPart
 * @property {CodeExecutionResult} codeExecutionResult
 */

/**
 * @typedef {TextPart|ImagePart|FunctionCallPart|FunctionResponsePart|ExecutableCodePart|CodeExecutionResultPart} MessagePart
 */

/**
 * @typedef {Object} Message
 * @property {'user'|'model'} role - Message sender role
 * @property {MessagePart[]} parts - Array of content parts
 */

/**
 * @typedef {Object} TextDelta
 * @property {string} text - Incremental text chunk
 * @property {false} done - Indicates this is a partial chunk (not final)
 */

/**
 * @typedef {Object} ImageDataDelta
 * @property {string} data - Incremental base64 image data
 * @property {string} [mimeType] - MIME type (sent once on first delta)
 */

/**
 * @typedef {Object} ImageDelta
 * @property {ImageDataDelta} inlineData
 * @property {false} done - Indicates this is a partial chunk
 */

/**
 * @typedef {Object} FunctionCallInfoDelta
 * @property {string} [name] - Partial function name
 * @property {Object} [args] - Partial function arguments
 */

/**
 * @typedef {Object} FunctionCallDelta
 * @property {FunctionCallInfoDelta} functionCall
 * @property {false} done - Indicates this is a partial chunk
 */

/**
 * @typedef {Object} FunctionResponseInfoDelta
 * @property {string} [name] - Function name
 * @property {Object} [response] - Partial response data
 */

/**
 * @typedef {Object} FunctionResponseDelta
 * @property {FunctionResponseInfoDelta} functionResponse
 * @property {false} done - Indicates this is a partial chunk
 */

/**
 * @typedef {Object} PartComplete
 * @property {MessagePart} result - The completed, assembled part
 * @property {true} done - Indicates this part is complete, move to next part
 */

/**
 * @typedef {TextDelta|ImageDelta|FunctionCallDelta|FunctionResponseDelta|PartComplete} StreamChunk
 */

/**
 * @typedef {Object} GenerateOptions
 * @property {string} [key] - Dynamic option key-value pairs
 */

class BaseProvider {
    constructor(config = {}) {
        this.config = config;
    }

    /**
     * Helper to merge and concatenate two delta objects.
     * Useful for accumulating partial stream chunks into a complete part.
     * 
     * @param {Object} obj1 - Existing accumulated part/delta
     * @param {Object} obj2 - New delta to merge
     * @returns {Object} Merged object
     */
    mergeAndConcat(obj1, obj2) {
        const result = { ...obj1 };
        for (const [key, value] of Object.entries(obj2)) {
            if (result.hasOwnProperty(key)) {
                if (typeof result[key] === 'string' && typeof value === 'string') {
                    result[key] += value;
                } else if (Array.isArray(result[key]) && Array.isArray(value)) {
                    result[key] = [...result[key], ...value];
                } else if (typeof result[key] === 'object' && result[key] !== null && typeof value === 'object' && value !== null) {
                    result[key] = this.mergeAndConcat(result[key], value);
                } else {
                    result[key] = value;
                }
            } else {
                result[key] = value;
            }
        }
        return result;
    }

    /**
     * Generate text based on chat history using a nested iterator pattern.
     * 
     * The generator yields an AsyncGenerator (iterator) for each part of the response.
     * This allows a clean "2-loop" pattern for consumers.
     * 
     * Each inner generator yields StreamChunk objects:
     * - Chunks with { done: false } represent delta updates.
     * - Each part sequence ends with exactly one { result: MessagePart, done: true }.
     * 
     * @param {Message[]} contents - Chat history with message parts
     * @param {GenerateOptions} options - Generation options
     * @returns {AsyncGenerator<AsyncGenerator<StreamChunk, void, unknown>, void, unknown>}
     *   - Outer loop yields a generator for each part (text, image, tool, etc.)
     *   - Inner loop yields deltas { ..., done: false }
     *   - Inner loop yields { result: MessagePart, done: true } when the part is fully assembled
     * 
     * @example
     * // Implementation in subclass:
     * async *generate(contents, options = {}) {
     *   yield (async function*() {
     *     yield { text: "Hello", done: false };
     *     yield { text: " world", done: false };
     *     yield { result: { text: "Hello world" }, done: true }; // Final result
     *   })();
     * }
     * 
     * // Consumer pattern (2-loop) - No manual merging needed:
     * for await (const partStream of provider.generate(history)) {
     *   for await (const chunk of partStream) {
     *     if (chunk.done) {
     *       console.log("Full Part Received:", chunk.result);
     *     } else {
     *       // Process delta based on type
     *       if (chunk.text) process.stdout.write(chunk.text);
     *     }
     *   }
     * }
     */
    async *generate(contents, options = {}) {
        throw new Error("Method 'generate' must be implemented by subclass");
    }

    /**
     * Generate a single embedding vector for multimodal content parts.
     * 
     * This method represents the content (which may consist of multiple parts like 
     * text and images) in a single unified embedding space.
     * 
     * @param {MessagePart[]} parts - Array of content parts to embed together
     * @param {Object} [options] - Embedding options
     * @returns {Promise<number[]>} A single embedding vector representing the combined parts
     * @throws {Error} Method must be implemented by subclass
     * 
     * @example
     * // Embedding text and an image into one vector
     * const vector = await provider.embed([
     *   { text: "A dog playing in the park" },
     *   { inlineData: { data: "...", mimeType: "image/jpeg" } }
     * ]);
     */
    async embed(parts, options = {}) {
        throw new Error("Method 'embed' must be implemented by subclass");
    }
}

module.exports = BaseProvider;