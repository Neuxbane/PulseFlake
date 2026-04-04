# Developer Guide: Building Apps for OpenPulse💕

OpenPulse is designed to be highly modular. New features should be built as independent "apps" that communicate via Unix Sockets.

## 🏗️ Basic App Structure

An OpenPulse app is a standalone Node.js process. It communicates with other apps using the `UnixSocket` utility found in `utils/UnixSocket.js`.

### **Understanding UnixSocket**
The `UnixSocket` class provides the high-level API for our IPC (Inter-Process Communication):

*   **`constructor(identifier)`**: Creates a socket named `identifier.sock`.
*   **`server.connect(targetSocketPath, callback)`**: Connects to another app. It features an **automatic retry mechanism**, making it safe to start apps in any order. The `callback` is triggered on every successful (re)connection.
*   **`server.listen(fromIdentifier, programCode, callback)`**: Registers a handler for specific requests.
    *   `fromIdentifier`: Use `'*'` to accept requests from any app.
    *   `programCode`: Use the tool name (e.g., `'ping'`).
*   **`server.request(targetIdentifier, programCode, data)`**: Sends a request to a target app and returns a **Promise** that resolves with the response.
*   **`server.broadcast(programCode, data)`**: Sends a message to *all* currently connected sockets.

---

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
