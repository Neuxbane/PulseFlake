const socket = io();
let activeService = null;
let servicesData = {};
let calendar = null;
let calendarData = { items: [] }; // Store raw calendar data for duplication

let currentDynamicApp = null;

// Dynamically load scripts sequentially
async function loadScripts(urls) {
    for (const url of urls) {
        if (document.querySelector(`script[src="${url}"]`)) {
            continue;
        }
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }
}

// Dynamically load stylesheets
async function loadStylesheets(urls) {
    for (const url of urls) {
        if (document.querySelector(`link[href="${url}"]`)) {
            continue;
        }
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        document.head.appendChild(link);
    }
}

// Request and render a dynamic app
async function loadDynamicApp(appName) {
    if (currentDynamicApp === appName) {
        if (window.PulseFlakeApps && window.PulseFlakeApps[appName]) {
            window.PulseFlakeApps[appName].init();
        }
        return;
    }

    if (currentDynamicApp && window.PulseFlakeApps && window.PulseFlakeApps[currentDynamicApp]) {
        try {
            window.PulseFlakeApps[currentDynamicApp].destroy();
        } catch (e) {
            console.error(`Error destroying app ${currentDynamicApp}:`, e);
        }
    }

    document.querySelectorAll('.dynamic-app-resource').forEach(el => el.remove());

    const container = document.getElementById('page-dynamic-app');
    container.innerHTML = `<div class="flex-1 flex items-center justify-center text-pink-500 font-bold uppercase tracking-widest animate-pulse">Loading ${appName}...</div>`;

    socket.emit('execute_tool', { socketPath: appName, toolName: 'render', arguments: {} }, async (response) => {
        if (!response || !response.success) {
            container.innerHTML = `<div class="flex-1 flex flex-col items-center justify-center text-red-500 font-bold">
                <span class="uppercase tracking-widest mb-2">Failed to load ${appName}</span>
                <span class="text-xs text-gray-500 font-mono">${response?.error || 'No response from app'}</span>
            </div>`;
            return;
        }

        const { html, js, css, scripts = [], stylesheets = [] } = response;

        try {
            await loadStylesheets(stylesheets);
            await loadScripts(scripts);

            container.innerHTML = html;

            if (css) {
                const styleEl = document.createElement('style');
                styleEl.className = 'dynamic-app-resource';
                styleEl.textContent = css;
                document.head.appendChild(styleEl);
            }

            if (js) {
                const scriptEl = document.createElement('script');
                scriptEl.className = 'dynamic-app-resource';
                scriptEl.textContent = js;
                document.body.appendChild(scriptEl);
            }

            currentDynamicApp = appName;
            if (window.PulseFlakeApps && window.PulseFlakeApps[appName]) {
                window.PulseFlakeApps[appName].init();
            } else {
                console.warn(`App ${appName} loaded but did not register under window.PulseFlakeApps.${appName}`);
            }
        } catch (err) {
            console.error(`Error initializing dynamic app ${appName}:`, err);
            container.innerHTML = `<div class="flex-1 flex flex-col items-center justify-center text-red-500 font-bold">
                <span class="uppercase tracking-widest mb-2">Error running ${appName}</span>
                <span class="text-xs text-gray-500 font-mono">${err.message}</span>
            </div>`;
        }
    });
}

function updateDynamicAppsNav() {
    const nav = document.getElementById('dynamic-apps-nav');
    if (!nav) return;
    
    const appsWithRender = [];
    Object.entries(servicesData).forEach(([appPath, tools]) => {
        const appName = appPath.split('/').pop().replace('.sock', '');
        const hasRender = tools.some(t => t.name === 'render');
        if (hasRender && !appsWithRender.includes(appName)) {
            appsWithRender.push(appName);
        }
    });

    nav.innerHTML = '';
    appsWithRender.forEach(appName => {
        const btn = document.createElement('button');
        btn.id = `nav-${appName}`;
        btn.onclick = () => showPage(appName);
        btn.className = "p-3 rounded-xl transition-all duration-300 text-gray-500 hover:bg-gray-800 hover:text-gray-300";
        btn.title = appName.charAt(0).toUpperCase() + appName.slice(1);
        
        let iconHtml = `
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
            </svg>
        `;
        if (appName.toLowerCase() === 'calendar') {
            iconHtml = `
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
            `;
        }

        btn.innerHTML = iconHtml;
        nav.appendChild(btn);
    });

    const activePage = document.querySelector('main:not(.hidden)')?.id?.replace('page-', '');
    if (activePage && appsWithRender.includes(activePage)) {
        const btn = document.getElementById(`nav-${activePage}`);
        if (btn) {
            btn.className = "p-3 rounded-xl transition-all duration-300 bg-pink-600 text-white";
        }
    }
}

// Navigation
function showPage(pageId) {
    document.querySelectorAll('main').forEach(p => p.classList.add('hidden'));
    
    document.querySelectorAll('nav button').forEach(b => {
        b.classList.remove('bg-pink-600', 'text-white');
        b.classList.add('text-gray-500', 'hover:bg-gray-800');
    });

    const isBuiltIn = ['chat', 'services'].includes(pageId);
    
    if (isBuiltIn) {
        if (currentDynamicApp && window.PulseFlakeApps && window.PulseFlakeApps[currentDynamicApp]) {
            try {
                window.PulseFlakeApps[currentDynamicApp].destroy();
            } catch (e) {
                console.error(`Error destroying app ${currentDynamicApp}:`, e);
            }
            currentDynamicApp = null;
        }
        
        document.getElementById(`page-${pageId}`).classList.remove('hidden');
        
        const activeBtn = document.getElementById(`nav-${pageId}`);
        if (activeBtn) {
            activeBtn.classList.remove('text-gray-500', 'hover:bg-gray-800');
            activeBtn.classList.add('bg-pink-600', 'text-white');
        }
    } else {
        document.getElementById('page-dynamic-app').classList.remove('hidden');
        
        const activeBtn = document.getElementById(`nav-${pageId}`);
        if (activeBtn) {
            activeBtn.classList.remove('text-gray-500', 'hover:bg-gray-800');
            activeBtn.classList.add('bg-pink-600', 'text-white');
        }

        loadDynamicApp(pageId);
    }
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
    updateDynamicAppsNav();
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
    
    // Parse links and fetch metadata
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = text.match(urlRegex);

    inner.innerHTML = `
        <p class="font-bold text-[10px] uppercase tracking-widest mb-1 ${type === 'user' ? 'text-pink-200' : 'text-pink-500'}">${sender}</p>
        <div class="prose prose-invert prose-pink max-w-none text-sm leading-relaxed">${marked.parse(text)}</div>
        <div class="metadata-container mt-3 space-y-2"></div>
    `;
    
    if (urls) {
        const metadataContainer = inner.querySelector('.metadata-container');
        urls.forEach(url => {
            fetch(`/api/metadata?url=${encodeURIComponent(url)}`)
                .then(res => res.json())
                .then(metadata => {
                    const preview = document.createElement('a');
                    preview.href = metadata.url;
                    preview.target = "_blank";
                    preview.className = "block bg-black/40 border border-gray-700/50 rounded-xl overflow-hidden hover:border-pink-500/50 transition-all group";
                    preview.innerHTML = `
                        ${metadata.image ? `<img src="${metadata.image}" class="w-full h-32 object-cover border-b border-gray-700/50" />` : ''}
                        <div class="p-3">
                            <h4 class="text-[11px] font-bold text-pink-400 truncate group-hover:text-pink-300 transition-colors">${metadata.title}</h4>
                            ${metadata.description ? `<p class="text-[10px] text-gray-500 line-clamp-2 mt-1">${metadata.description}</p>` : ''}
                            <span class="text-[9px] text-gray-600 font-mono mt-2 block truncate">${new URL(metadata.url).hostname}</span>
                        </div>
                    `;
                    metadataContainer.appendChild(preview);
                });
        });
    }

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

    // Store existing input values and results to persist them across re-renders
    const savedStates = {};
    container.querySelectorAll('[data-tool-id]').forEach(card => {
        const toolId = card.getAttribute('data-tool-id');
        const inputs = {};
        card.querySelectorAll('.tool-inputs input').forEach(input => {
            inputs[input.dataset.name] = input.value;
        });
        const resultBox = card.querySelector('.tool-result');
        savedStates[toolId] = {
            inputs,
            resultHtml: resultBox.innerHTML,
            resultHidden: resultBox.classList.contains('hidden')
        };
    });

    container.innerHTML = '';

    if (tools.length === 0) {
        container.innerHTML = '<div class="text-gray-600 italic">No tools registered for this service.</div>';
        return;
    }

    tools.forEach(tool => {
        const toolId = `${socketPath}-${tool.name}`;
        const savedState = savedStates[toolId] || { inputs: {}, resultHtml: '', resultHidden: true };
        const card = document.createElement('div');
        card.setAttribute('data-tool-id', toolId);
        card.className = "bg-gray-900 border border-gray-800 rounded-2xl p-6 hover:border-pink-900/50 transition-all shadow-lg";
        
        let fieldsHtml = '';
        if (tool.parameters && tool.parameters.properties) {
            Object.entries(tool.parameters.properties).forEach(([name, schema]) => {
                const savedValue = savedState.inputs[name] || '';
                fieldsHtml += `
                    <div class="space-y-1">
                        <label class="text-[10px] uppercase tracking-wider text-gray-500 font-bold">${name}${tool.parameters.required?.includes(name) ? '*' : ''}</label>
                        <input type="${schema.type === 'number' ? 'number' : 'text'}" 
                               data-name="${name}" 
                               data-type="${schema.type}"
                               value="${savedValue}"
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
            <div class="mt-4 ${savedState.resultHidden ? 'hidden' : ''} tool-result p-3 bg-black rounded-lg border border-gray-800 font-mono text-[10px] overflow-x-auto">${savedState.resultHtml}</div>
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
