const socket = io();
let activeService = null;
let servicesData = {};

// Navigation
function showPage(pageId) {
    document.querySelectorAll('main').forEach(p => p.classList.add('hidden'));
    document.getElementById(`page-${pageId}`).classList.remove('hidden');
    
    // Update Nav UI
    document.querySelectorAll('nav button').forEach(b => {
        b.classList.remove('bg-pink-600', 'text-white');
        b.classList.add('text-gray-500', 'hover:bg-gray-800');
    });
    const activeBtn = document.getElementById(`nav-${pageId}`);
    activeBtn.classList.remove('text-gray-500', 'hover:bg-gray-800');
    activeBtn.classList.add('bg-pink-600', 'text-white');
}

// Socket Events
socket.on('connect', () => {
    appendLog('System', 'Connected to ecosystem bus');
});

socket.on('services_update', (services) => {
    const list = document.getElementById('service-list');
    list.innerHTML = '';
    
    services.forEach(s => {
        const btn = document.createElement('button');
        btn.className = `w-full text-left px-4 py-3 rounded-xl transition-all flex flex-col gap-1 border border-transparent ${activeService === s ? 'bg-pink-900/20 border-pink-900/50 text-pink-500' : 'text-gray-500 hover:bg-gray-800'}`;
        btn.onclick = () => selectService(s);
        btn.innerHTML = `
            <span class="text-[10px] font-bold uppercase tracking-widest">${s.split('/').pop()}</span>
            <span class="text-[8px] font-mono opacity-50 truncate">${s}</span>
        `;
        list.appendChild(btn);
    });
});

socket.on('tools_dump', (data) => {
    servicesData = data;
    if (activeService) renderTools(activeService);
});

socket.on('chat_history', (history) => {
    const box = document.getElementById('chat-box');
    // Clear everything except the welcome message (which is the first child now)
    while (box.children.length > 1) {
        box.removeChild(box.lastChild);
    }
    
    if (Array.isArray(history)) {
        history.forEach(item => {
            const sender = item.role === 'user' ? 'You' : 'Agent';
            const type = item.role === 'user' ? 'user' : 'agent';
            const text = item.content;
            if (text) appendMessage(sender, text, type);
        });
    }
});

socket.on('agent_push', (data) => {
    appendMessage('Agent', data.message || JSON.stringify(data), 'agent');
});

socket.on('terminal_output', (data) => {
    appendLog(data.service || 'Terminal', data.output);
});

// Chat Logic
function sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    appendMessage('You', text, 'user');
    
    // Feedback: Add a temporary 'Requesting...' message
    const box = document.getElementById('chat-box');
    const loadingDiv = document.createElement('div');
    loadingDiv.id = 'chat-loading-feedback';
    loadingDiv.className = 'flex justify-start w-full animate-pulse';
    loadingDiv.innerHTML = `
        <div class="bg-gray-800/30 border border-gray-700/20 p-3 rounded-2xl text-[10px] text-gray-500 font-bold uppercase tracking-widest">
            Requesting...
        </div>
    `;
    box.appendChild(loadingDiv);
    box.scrollTop = box.scrollHeight;

    socket.emit('agent_chat', { prompt: text });
    input.value = '';
}

document.getElementById('chat-input')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

function appendMessage(sender, text, type) {
    // Remove the 'Requesting...' feedback if it exists when a message is appended
    const loadingFeedback = document.getElementById('chat-loading-feedback');
    if (loadingFeedback) loadingFeedback.remove();

    const box = document.getElementById('chat-box');
    const div = document.createElement('div');
    div.className = `flex ${type === 'user' ? 'justify-end' : 'justify-start'} w-full animate-in fade-in slide-in-from-bottom-2`;
    
    const inner = document.createElement('div');
    inner.className = `${type === 'user' ? 'bg-pink-600 text-white' : 'bg-gray-800/50 border border-gray-700/30'} p-4 rounded-2xl max-w-[85%] text-sm shadow-xl`;
    
    inner.innerHTML = `
        <p class="font-bold text-[10px] uppercase tracking-widest mb-1 ${type === 'user' ? 'text-pink-200' : 'text-pink-500'}">${sender}</p>
        <div class="whitespace-pre-wrap">${text}</div>
    `;
    
    div.appendChild(inner);
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

// Tool Explorer Logic
function selectService(socketPath) {
    activeService = socketPath;
    document.getElementById('selected-service-name').innerText = socketPath.split('/').pop();
    
    // Refresh tools for this specifically
    socket.emit('get_tools', { socketPath });
    
    // Re-render nav UI
    socket.emit('request_services_update'); 
}

function renderTools(socketPath) {
    const container = document.getElementById('tool-explorer');
    const tools = servicesData[socketPath] || [];
    container.innerHTML = '';

    if (tools.length === 0) {
        container.innerHTML = '<div class="text-gray-600 italic">No tools registered for this service.</div>';
        return;
    }

    tools.forEach(tool => {
        const card = document.createElement('div');
        card.className = "bg-gray-900 border border-gray-800 rounded-2xl p-6 hover:border-pink-900/50 transition-all shadow-lg";
        
        let fieldsHtml = '';
        if (tool.parameters && tool.parameters.properties) {
            Object.entries(tool.parameters.properties).forEach(([name, schema]) => {
                fieldsHtml += `
                    <div class="space-y-1">
                        <label class="text-[10px] uppercase tracking-wider text-gray-500 font-bold">${name}${tool.parameters.required?.includes(name) ? '*' : ''}</label>
                        <input type="${schema.type === 'number' ? 'number' : 'text'}" 
                               data-name="${name}" 
                               data-type="${schema.type}"
                               placeholder="${schema.description || ''}" 
                               class="w-full bg-black border border-gray-800 rounded-lg px-3 py-2 text-xs focus:border-pink-600 outline-none transition-all">
                    </div>
                `;
            });
        }

        card.innerHTML = `
            <div class="flex items-start justify-between mb-4">
                <div>
                    <h3 class="text-pink-500 font-bold text-lg">${tool.name}</h3>
                    <p class="text-xs text-gray-400 mt-1">${tool.description || 'No description provided.'}</p>
                </div>
                <button onclick="triggerTool(this, '${socketPath}', '${tool.name}')" class="px-4 py-2 bg-pink-600 hover:bg-pink-500 text-white text-xs font-bold rounded-xl transition-all active:scale-95 shadow-lg">EXECUTE</button>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 tool-inputs">
                ${fieldsHtml}
            </div>
            <div class="mt-4 hidden tool-result p-3 bg-black rounded-lg border border-gray-800 font-mono text-[10px] overflow-x-auto"></div>
        `;
        container.appendChild(card);
    });
}

async function triggerTool(btn, socketPath, toolName) {
    const card = btn.closest('div').parentElement;
    const inputs = card.querySelectorAll('.tool-inputs input');
    const resultBox = card.querySelector('.tool-result');
    const args = {};

    inputs.forEach(input => {
        let val = input.value;
        if (input.dataset.type === 'number') val = parseFloat(val);
        if (val !== "" && val !== undefined) {
            args[input.dataset.name] = val;
        }
    });

    btn.disabled = true;
    btn.innerText = 'RUNNING...';
    resultBox.classList.remove('hidden');
    resultBox.innerHTML = '<span class="text-blue-400">Executing...</span>';

    socket.emit('execute_tool', { socketPath, toolName, arguments: args }, (response) => {
        btn.disabled = false;
        btn.innerText = 'EXECUTE';
        
        const isError = response?.error || response?.status === 'error';
        const colorClass = isError ? 'text-red-400' : 'text-green-400';
        const formattedResponse = JSON.stringify(response, null, 2);
        
        resultBox.innerHTML = `<pre class="${colorClass}">${formattedResponse}</pre>`;
        appendLog(toolName, isError ? 'Execution failed' : 'Executed successfully');
    });
}

function appendLog(source, msg) {
    const list = document.getElementById('ecosystem-logs');
    if (!list) return;
    
    const entry = document.createElement('div');
    entry.className = "text-[10px] py-1 border-b border-gray-900/50 flex gap-2 animate-in fade-in";
    
    const isError = msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail');
    const colorClass = isError ? 'text-red-500' : 'text-green-500';

    entry.innerHTML = `
        <span class="text-gray-600 font-mono flex-shrink-0">[${new Date().toLocaleTimeString('en-US', { hour12: false })}]</span>
        <span class="text-pink-600 font-bold uppercase tracking-tighter truncate w-16">${source}</span>
        <span class="text-gray-400 break-all ${colorClass}">${msg}</span>
    `;
    
    list.prepend(entry);
    
    // Keep only last 100 logs to prevent memory issues
    while (list.children.length > 100) {
        list.removeChild(list.lastChild);
    }
}

// Initial update
socket.emit('request_services_update');
