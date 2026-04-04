# OpenPulse💕

**OpenPulse** (formerly **FuckingLonely**) is a decentralized micro-app ecosystem built for AI-driven automation and interaction. It allows multiple independent modules (Discord bots, university scrapers, internet searchers) to communicate seamlessly via a robust Unix Socket-based Inter-Process Communication (IPC) layer.

---

## 📖 The Story of OpenPulse

The project began as a personal endeavor to bridge the gap between AI and daily digital life, evolving through several stages of architectural complexity.

### **The Evolution**

*   **V1: The Beginning (June 2025)**  
    Originally titled **FuckingLonely**, this version focused on creating a unified AI assistant that could monitor Discord and manage basic memories. It was a monolithic structure that set the foundation for context awareness and basic tool use.
    
*   **V2: Refined Core (Late 2025)**  
    The project shifted towards a "Character" based system, introducing more modular modules like `api-monitor.js` and early scraping attempts. It was here that the modular philosophy began to take root.

*   **V3 & V4: The Bus & Apps (Early 2026)**  
    Version 3 introduced the concept of a "Bus" for inter-process communication. By Version 4, the system started splitting into specialized folders for `ai`, `discord`, `internet`, and `system` tasks, moving away from a single script.

*   **V5: The Final Prototype (March 2026)**  
    V5 refined the provider system (supporting various Gemini models) and perfected the scraper logic (like the University portal). It was the most stable version before the current transition to the **OpenPulse** architecture.

*   **OpenPulse💕 (Current)**  
    The latest evolution. A fully decentralized micro-app ecosystem where the Agent and Tools are distinct services, communicating via specialized Unix Sockets for maximum flexibility and performance.

---

## 🏛️ Architecture Overview

The system is designed around a "Manager-Worker" pattern where all apps are equals but fulfill specific roles:

1.  **The Agent (`apps/agent`)**: The central logic engine. It receives events from other apps and uses **Gemini 3.1 Flash (Lite)** to decide which tools to invoke.
2.  **The Tools Registry (`apps/tools`)**: A RAG-powered (Retrieval-Augmented Generation) lookup service. Apps register their "function definitions" here, and the Agent searches for them on-demand.
3.  **The Apps (`apps/*`)**: Specialized modules that either provide input (Events) or perform actions (Tools).

---

## 🚀 Current Apps

| App | Description |
| :--- | :--- |
| **Agent** 🤖 | The brain. Processes incoming events and determines the best course of action using tool-calling. |
| **Discord** 💬 | A bridge between Discord channels/DMs and the Agent. Broadcasts messages as events. |
| **University** 🏛️ | Scraper for the UAJY student portal. Supports login, fetching courses, tasks, and content. |
| **Internet** 🌐 | Provides web search and content retrieval capabilities to the Agent. |
| **Tools** 🔧 | The system registry where all available tool definitions are indexed using vector embeddings. |
| **Template** 📂 | A boilerplate for quickly spinning up new OpenPulse micro-apps. |

---

## 🛠️ Getting Started

### **1. Environment Setup**
Create a `.env` file in the root with your API keys:
```env
GEMINI_API_KEYS=your_key1,your_key2
# (Optional) List providers or model overrides
```

### **2. Running the Ecosystem**
Each app runs in its own process. It is recommended to run them in `screen` or `pm2`.

**Base system:**
```bash
node apps/tools/index.js      # Required first (Registry)
node apps/agent/index.js      # Required second (Brain)
```

**Feature modules:**
```bash
node apps/discord/index.js
node apps/university/index.js
node apps/internet/index.js
```

---

## 🧩 Creating New Apps

To create a new app, refer to the [apps/template/index.js](apps/template/index.js).

1.  **Initialize Socket**: `new UnixSocket('your-app-name')`
2.  **Connect & Register**: Use `server.connect(TOOLS_PATH)` to register your JSON tool definitions.
3.  **Listen**: Use `server.listen('*', 'toolName', callback)` to handle Agent requests.
4.  **Broadcast**: Use `server.broadcast('event', data)` to notify the Agent of something happening.

---

## 📜 Technical Details

*   **Communication**: JSON-delimited line messages over Unix Domain Sockets (`.sock`).
*   **Provider**: Gemini 3.1 Flash (Lite/Preview) for thinking and embedding.
*   **Discovery**: Semantic search (cosine similarity) allows the Agent to find tools even if if doesn't know their exact names.

---

*Made with love (and sockets). 🧠💕*
