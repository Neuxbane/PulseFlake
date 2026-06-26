const GeminiProvider = require('../providers/gemini');
const LlamaCppProvider = require('../providers/llamacpp');

/**
 * Aggregated provider exports for convenient access and IntelliSense.
 * This can be mapped in package.json via subpath imports.
 */
module.exports = {
    GeminiProvider,
    LlamaCppProvider,
};
