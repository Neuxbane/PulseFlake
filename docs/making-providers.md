# Developer Guide: Adding AI Providers

OpenPulse uses a provider-based system to remain model-agnostic. All providers should extend the `BaseProvider` class.

## 🛠️ Implementing a Provider

1.  **Create File**: Add your provider in `providers/your-provider.js`.
2.  **Extend Base**: 
    ```javascript
    const BaseProvider = require('../utils/BaseProvider');

    class MyNewProvider extends BaseProvider {
        async generate(messages, options) {
            // Must return an async generator (stream)
            // or a chunked response containing { text, done }
        }

        async embed(inputs) {
            // Must return an array of vectors (floats)
        }
    }
    ```
3.  **Register**: Update `utils/Providers.js` to include your new class.

## 🤖 Current Providers
*   **GeminiProvider**: The primary provider using Google's Generative AI SDK.

## ✅ Requirements
*   **Streaming**: The `generate` method should support streaming chunks for a better "live" feel in Discord.
*   **Context Management**: Ensure system instructions are properly injected into the model's platform-specific format.
