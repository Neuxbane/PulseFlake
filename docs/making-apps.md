# Developer Guide: Building Apps for OpenPulse💕

OpenPulse is designed to be highly modular. New features should be built as independent "apps" that communicate via Unix Sockets.

## 🏗️ Basic App Structure

A standard OpenPulse app requires:
1.  **A Unique Identifier**: Used to name its socket and as a namespace for its tools.
2.  **Socket Connections**: Connect to `agent` (to send events) and `tools` (to register capabilities).
3.  **Tool Definitions**: JSON schemas describing what the app can do.
4.  **Listeners**: Code that executes when the Agent calls a tool.

## 📝 Template Walkthrough

Use `apps/template/index.js` as your starting point.

```javascript
const server = new (require('#UnixSocket'))("my-app-name");

// 1. Tool Registration
const myTools = [{
    name: 'doSomething',
    description: 'Explain what this tool does clearly for the AI',
    parameters: {
        type: 'object',
        properties: {
            input: { type: 'string' }
        },
        required: ['input']
    }
}];

server.connect(TOOLS_SOCKET, async () => {
    await server.request('tools', 'register', myTools);
});

// 2. Handling Requests
server.listen('*', 'doSomething', async (req, res) => {
    const { input } = req.data;
    // ... logic ...
    res.send({ success: true, result: "Value" });
});

// 3. Emitting Events
server.broadcast('event', { type: 'alert', content: '...' });
```

---

## 💡 Best Practices
*   **Keep it Stateless**: Apps should ideally handle one request and respond. Use local `config.json` if persistence is needed (like `apps/university`).
*   **Clear Descriptions**: The Agent relies entirely on the `description` field in your tool registration to know when to use it.
*   **Error Handling**: Always return a response (even if it's an error) so the Agent doesn't hang.
