const socket = io();
let activeService = null;
let servicesData = {};
let calendar = null;

// --- REPEAT RULE HELPERS ---
const dateToObj = (date) => {
    return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        date: date.getDate(),
        day: date.getDay()
    };
};

const evaluateRepeatRule = (rule, curr, evnt) => {
    if (!rule) return false;
    
    try {
        if (rule === 'daily') {
            return true;
        } else if (rule === 'weekly') {
            return curr.day === evnt.day;
        } else if (rule === 'workdays') {
            return curr.day >= 1 && curr.day <= 5;
        } else if (rule === 'weekend') {
            return curr.day === 0 || curr.day === 6;
        } else if (rule === 'monthly') {
            return curr.date === evnt.date;
        } else if (rule === 'yearly') {
            return curr.month === evnt.month && curr.date === evnt.date;
        } else if (typeof rule === 'string' && rule.includes('=>')) {
            const evalFunc = new Function('curr', 'evnt', `return (${rule})(curr, evnt)`);
            return evalFunc(curr, evnt);
        }
    } catch (e) {
        console.error(`[calendar-ui] Error evaluating rule:`, e.message);
        return false;
    }
    
    return false;
};

const expandEventOccurrences = (event, fromDate = null, daysAhead = 730) => {
    const occurrences = [];
    const startDate = new Date(event.start);
    
    if (!fromDate) {
        fromDate = startDate;
    }
    
    const duration = event.duration || 0;
    const isAllDay = duration === 0;
    const evnt = dateToObj(startDate);
    
    // Non-recurring: just return single occurrence
    if (!event.repeat) {
        const endDate = isAllDay
            ? new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 23, 59, 59)
            : new Date(startDate.getTime() + duration * 60000);
        return [{
            ...event,
            allDay: isAllDay,
            occurrenceStart: startDate.toISOString(),
            occurrenceEnd: endDate.toISOString()
        }];
    }
    
    // Recurring: generate instances
    let currentDate = new Date(fromDate);
    const endLimit = new Date(fromDate.getTime() + daysAhead * 86400000);
    
    for (let i = 0; i < daysAhead; i++) {
        if (currentDate > endLimit) break;
        
        const curr = dateToObj(currentDate);
        
        if (evaluateRepeatRule(event.repeat, curr, evnt)) {
            const pad = (n) => String(n).padStart(2, '0');
            const timeStr = event.start.split('T')[1]; // Extract HH:MM:SS
            const occStart = `${pad(currentDate.getFullYear())}-${pad(currentDate.getMonth() + 1)}-${pad(currentDate.getDate())}T${timeStr}`;
            const occStartDate = new Date(occStart);
            const occEndDate = isAllDay
                ? new Date(occStartDate.getFullYear(), occStartDate.getMonth(), occStartDate.getDate(), 23, 59, 59)
                : new Date(occStartDate.getTime() + duration * 60000);
            
            occurrences.push({
                ...event,
                allDay: isAllDay,
                id: `${event.id}_${i}`,
                occurrenceStart: occStartDate.toISOString(),
                occurrenceEnd: occEndDate.toISOString()
            });
        }
        
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    return occurrences;
};

// --- TIMEZONE HELPERS ---

// --- CALENDAR HELPERS ---
function toggleAllDayUI() {
    const isAllDay = document.getElementById('event-all-day').checked;
    const durationInput = document.getElementById('event-duration');
    if (isAllDay) {
        durationInput.value = '0';
        durationInput.disabled = true;
    } else {
        durationInput.disabled = false;
        if (durationInput.value === '0') {
            durationInput.value = '60';
        }
    }
}

function updateRepeatFunction(presetValue) {
    const repeatInput = document.getElementById('event-repeat');
    const presetMap = {
        '': '',
        'daily': '(curr, evnt) => true',
        'weekly': '(curr, evnt) => curr.day == evnt.day',
        'workdays': '(curr, evnt) => curr.day >= 1 && curr.day <= 5',
        'weekend': '(curr, evnt) => curr.day === 0 || curr.day === 6',
        'custom': ''
    };
    
    repeatInput.value = presetMap[presetValue] || '';
    
    // If custom, let the user type their own
    if (presetValue === 'custom') {
        repeatInput.focus();
    }
}

function formatLocalDateTime(date) {
    // Format a Date object as YYYY-MM-DDTHH:MM in the user's LOCAL timezone
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function getLocalTimezoneInfo() {
    const now = new Date();
    const offset = -now.getTimezoneOffset();
    const hours = Math.floor(offset / 60);
    const mins = offset % 60;
    const sign = offset >= 0 ? '+' : '-';
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return { tz, offset, hours: Math.abs(hours), mins: Math.abs(mins), sign };
}

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
    if (activeBtn) {
        activeBtn.classList.remove('text-gray-500', 'hover:bg-gray-800');
        activeBtn.classList.add('bg-pink-600', 'text-white');
    }

    if (pageId === 'calendar') {
        initCalendar();
        onCalendarPageOpened();
    }
}

function initCalendar() {
    const calendarEl = document.getElementById('calendar');
    if (calendar) return; // Already initialized

    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'dayGridMonth',
        themeSystem: 'standard',
        headerToolbar: {
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridYear,dayGridMonth,timeGridWeek,timeGridThreeDay,listWeek'
        },
        views: {
            dayGridYear: {
                buttonText: 'Year'
            },
            timeGridThreeDay: {
                type: 'timeGrid',
                duration: { days: 3 },
                buttonText: '3 Day'
            },
            listWeek: {
                buttonText: 'Timeline/List'
            }
        },
        height: '100%',
        events: [],
        eventClick: function(info) {
            openEditModal(info.event);
        },
        nowIndicator: true,
        slotLabelInterval: '00:30:00',
        slotLabelFormat: {
            meridiem: 'short',
            hour: 'numeric',
            minute: '2-digit'
        },
        scrollTime: '09:00:00'
    });
    calendar.render();
    
    // Start fetching events every 5 seconds for real-time updates
    fetchAndUpdateEvents();
    setInterval(fetchAndUpdateEvents, 5000);
    
    // Start updating the now indicator in real-time
    updateNowIndicatorPosition();
    setInterval(updateNowIndicatorPosition, 60000); // Update every minute
}

function updateNowIndicatorPosition() {
    // FullCalendar's built-in nowIndicator should handle this
    // But we can force a refresh by triggering slotLabelDidMount or similar
    if (calendar) {
        const view = calendar.view;
        if (view && view.type && view.type.includes('timeGrid')) {
            // Force re-render of now indicator
            calendar.unselect();
        }
    }
}

function fetchAndUpdateEvents() {
    fetch('/api/calendar/events')
        .then(res => res.json())
        .then(events => {
            updateCalendarEvents(events);
        })
        .catch(err => {
            console.error('Error fetching calendar events:', err);
        });
}


function onCalendarPageOpened() {
    if (calendar) {
        calendar.updateSize();
        fetch('/api/calendar/events')
            .then(res => res.json())
            .then(events => {
                socket.emit('calendar_events', events); // Still use socket internally to trigger the calendar_events listener or just call the logic
                // But it's better to just update the events directly here or trigger the event handler
                // Let's manually trigger the update logic
                updateCalendarEvents(events);
            });
    }
    
    // Update timezone display
    const tzInfo = getLocalTimezoneInfo();
    const tzDisplay = document.getElementById('tz-display');
    if (tzDisplay) {
        tzDisplay.textContent = `[ ${tzInfo.tz} (UTC${tzInfo.sign}${String(tzInfo.hours).padStart(2, '0')}:${String(tzInfo.mins).padStart(2, '0')}) ]`;
    }
}

function updateCalendarEvents(events) {
    if (calendar) {
        calendar.removeAllEvents();
        let formattedEvents = [];
        
        // Iterate through each event and expand using repeat rule
        events.forEach(ev => {
            const occurrences = expandEventOccurrences(ev);
            
            occurrences.forEach(occ => {
                const base = {
                    id: occ.id,
                    title: occ.title,
                    start: occ.occurrenceStart,
                    allDay: occ.allDay || false,
                    description: occ.description,
                    extendedProps: { ...ev }
                };
                
                if (occ.occurrenceEnd) {
                    base.end = occ.occurrenceEnd;
                }
                
                formattedEvents.push(base);
            });
        });

        calendar.addEventSource(formattedEvents);
    }
}

// Calendar UI Handlers
let editingEventId = null;

function openCreateModal() {
    editingEventId = null;
    document.getElementById('modal-event').classList.remove('hidden');
    document.getElementById('event-title').value = '';
    document.getElementById('event-start').value = formatLocalDateTime(new Date());
    document.getElementById('event-duration').value = '60';
    document.getElementById('event-all-day').checked = false;
    document.getElementById('event-duration').disabled = false;
    document.getElementById('event-repeat').value = '';
    document.getElementById('event-repeat-preset').value = '';
    document.getElementById('event-desc').value = '';
    document.getElementById('event-tags').value = '';
    document.getElementById('event-parallelable').checked = false;
    document.getElementById('event-important').checked = true;
    document.getElementById('event-reminds').value = '';
    document.getElementById('btn-save-event').innerText = 'SAVE EVENT';
    if (document.getElementById('btn-delete-event')) {
        document.getElementById('btn-delete-event').classList.add('hidden');
    }
}

function openEditModal(event) {
    const data = event.extendedProps;
    // For recurring events, the ID has a suffix like _0, _1, etc.
    // Extract the original event ID by removing the suffix
    const eventId = event.id;
    const originalId = eventId.includes('_') ? eventId.split('_')[0] : eventId;
    editingEventId = originalId;
    
    document.getElementById('modal-event').classList.remove('hidden');
    document.getElementById('event-title').value = event.title || '';
    
    // The stored format is YYYY-MM-DDTHH:MM:SS (local time)
    // datetime-local input expects the same format
    if (data.start) {
        // Extract just the date-time part without timezone
        const timeStr = data.start.split('+')[0].split('Z')[0];
        document.getElementById('event-start').value = timeStr;
    }
    
    document.getElementById('event-duration').value = data.duration || '60';
    const isAllDay = data.duration === 0;
    document.getElementById('event-all-day').checked = isAllDay;
    document.getElementById('event-duration').disabled = isAllDay;
    document.getElementById('event-repeat').value = data.repeat || '';
    
    // Sync preset dropdown
    const repeatVal = data.repeat || '';
    const presetSelect = document.getElementById('event-repeat-preset');
    if (['daily', 'weekly', 'workdays', 'weekend', 'monthly', 'yearly', ''].includes(repeatVal)) {
        presetSelect.value = repeatVal;
    } else if (repeatVal.includes('=>')) {
        presetSelect.value = 'custom';
    } else {
        presetSelect.value = '';
    }

    document.getElementById('event-desc').value = data.description || '';
    document.getElementById('event-tags').value = (data.tags || []).join(', ');
    document.getElementById('event-parallelable').checked = data.parallelable !== false ? true : false;
    document.getElementById('event-important').checked = data.important !== false ? true : false;
    document.getElementById('event-reminds').value = (data.reminds || []).map(r => Math.floor(r / 60)).join(', ');
    document.getElementById('btn-save-event').innerText = 'UPDATE EVENT';
    if (document.getElementById('btn-delete-event')) {
        document.getElementById('btn-delete-event').classList.remove('hidden');
    }
}

function deleteCurrentEvent() {
    if (!editingEventId) return;
    if (!confirm('Are you sure you want to delete this event?')) return;

    const calendarPath = Object.keys(servicesData).find(p => p.includes('calendar')) || '/root/experiment/FuckingLonely/apps/calendar/calendar.sock';

    fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            socketPath: calendarPath, 
            toolName: 'deleteEvent', 
            arguments: { id: editingEventId } 
        })
    })
    .then(res => res.json())
    .then(res => {
        if (res.success) {
            closeEventModal();
            onCalendarPageOpened(); // Refresh via HTTP
            appendLog('Calendar', `Deleted event: ${editingEventId}`);
        } else {
            alert('Error: ' + (res.error || 'Failed to delete event'));
        }
    })
    .catch(err => alert('Network error: ' + err.message));
}

function closeEventModal() {
    document.getElementById('modal-event').classList.add('hidden');
    editingEventId = null;
}

function commitEvent() {
    const title = document.getElementById('event-title').value;
    const startInput = document.getElementById('event-start').value;
    // datetime-local format: YYYY-MM-DDTHH:MM
    // Append :00 to make it YYYY-MM-DDTHH:MM:SS (local time, no timezone)
    const start = startInput ? startInput + ':00' : '';
    const isAllDay = document.getElementById('event-all-day').checked;
    const duration = isAllDay ? 0 : (parseInt(document.getElementById('event-duration').value) || 60);
    const repeat = document.getElementById('event-repeat').value;
    const desc = document.getElementById('event-desc').value;
    const tags = document.getElementById('event-tags').value.split(',').map(t => t.trim()).filter(t => t);
    const parallelable = document.getElementById('event-parallelable').checked;
    const important = document.getElementById('event-important').checked;
    const remindsInput = document.getElementById('event-reminds').value;
    const reminds = remindsInput 
        ? remindsInput.split(',').map(r => parseInt(r.trim()) * 60).filter(r => !isNaN(r))
        : [];

    if (!title) return alert('Title is required');

    const evData = {
        title,
        start,
        duration,
        repeat,
        description: desc,
        tags,
        parallelable,
        important,
        reminds
    };

    const toolName = editingEventId ? 'updateEvent' : 'createEvent';
    const toolArgs = editingEventId ? { id: editingEventId, updates: evData } : evData;

    const calendarPath = Object.keys(servicesData).find(p => p.includes('calendar')) || '/root/experiment/FuckingLonely/apps/calendar/calendar.sock';
    
    fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            socketPath: calendarPath, 
            toolName: toolName, 
            arguments: toolArgs 
        })
    })
    .then(res => res.json())
    .then(res => {
        if (res.success) {
            closeEventModal();
            onCalendarPageOpened(); // Refresh via HTTP
            appendLog('Calendar', `${editingEventId ? 'Updated' : 'Created'} event: ${title}`);
        } else {
            let errorMsg = res.error || 'Failed to save event';
            if (res.conflicts && res.conflicts.length > 0) {
                errorMsg += '\n\nConflicts with:';
                res.conflicts.forEach(c => {
                    errorMsg += `\n- ${c.eventTitle} (important: ${c.isExistingImportant}, parallelable: ${c.isExistingParallelable})`;
                });
            }
            alert('Error: ' + errorMsg);
        }
    })
    .catch(err => alert('Network error: ' + err.message));
}

socket.on('calendar_events', (events) => {
    updateCalendarEvents(events);
});

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
