# Developer Guide: Adding AI Providers

OpenPulse uses a provider-based system to remain model-agnostic. All providers should extend the `BaseProvider` class.

## 🏛️ Understanding BaseProvider

All AI logic in OpenPulse flows through the `BaseProvider` found in `utils/BaseProvider.js`. It defines a common interface that ensures the Agent can swap between Google Gemini, OpenAI, or local models without code changes.

### **Core Interface Methods**

1.  **`async *generate(messages, options)`**:
    *   **Purpose**: Processes conversation history and returns responses.
    *   **Input**: `messages` array and an `options` object (including `systemInstruction`, `tools`, and `thinkingConfig`).
    *   **Output**: Must be an **Async Generator** that yields chunks. Chunks should follow the format `{ text, done }`.
    *   **Tool Calling**: When the model decides to use a tool, the chunk must yield a `functionCall` part.

2.  **`async embed(inputs)`**:
    *   **Purpose**: Converts text into vector embeddings.
    *   **Input**: An array of strings or objects.
    *   **Output**: An array of floats (the vector).
    *   **Usage**: Crucial for the `tools` registry to perform semantic searches.

### **Standard Logic Flow**
A provider should handle **retries** and **API key rotation** internally (as seen in `providers/gemini.js`) to provide a resilient interface to the Agent.

---

## � How to Use a Provider

Consumers (like the `agent` or `tools` apps) don't need to know the specifics of the provider. They interact with it via the standardized `generate` and `embed` methods.

### **Example: Integrating into an App**
```javascript
const { GeminiProvider } = require('#Providers');

// 1. Initialize with your keys and models
const provider = new GeminiProvider({ 
    apiKeys: ['API_KEY_1', 'API_KEY_2'], 
    models: ['gemini-2.0-flash-thinking-preview'] 
});

// 2. Using Generate (Streaming)
const stream = provider.generate(messages, { 
    systemInstruction: "You are helpful.",
    thinkingConfig: { include_thoughts: true }
});

for await (const chunkGenerator of stream) {
    for await (const part of chunkGenerator) {
        if (part.text) process.stdout.write(part.text);
        if (part.done) console.log("\n--- Generation Finished ---");
    }
}

// 3. Using Embed (for RAG/Search)
const vector = await provider.embed([{ text: "The quick brown fox" }]);
console.log("Vector size:", vector.length); // e.g., 768 or 1536
```

---

## �🛠️ Implementing a Provider
