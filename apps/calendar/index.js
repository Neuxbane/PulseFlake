require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const server = new (require('#UnixSocket'))("calendar");

const CALENDAR_DATA_PATH = path.resolve(__dirname, 'calendar.json');
const TOOLS_SOCKET_PATH = path.resolve(__dirname, '../tools/tools.sock');
const AGENT_SOCKET_PATH = path.resolve(__dirname, '../agent/agent.sock');

// --- TIMEZONE DETECTION ---
const getSystemTimezone = () => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {
        return 'UTC';
    }
};

const getTimezoneOffset = () => {
    const now = new Date();
    return -now.getTimezoneOffset();
};

const SYSTEM_TIMEZONE = getSystemTimezone();
const TIMEZONE_OFFSET_MINUTES = getTimezoneOffset();

// --- DATA PERSISTENCE ---
let calendarData = { 
    items: [],
    timezone: SYSTEM_TIMEZONE,
    timezoneOffsetMinutes: TIMEZONE_OFFSET_MINUTES
};

const loadData = () => {
    if (fs.existsSync(CALENDAR_DATA_PATH)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(CALENDAR_DATA_PATH, 'utf8'));
            calendarData = loaded;
            // Update timezone if it changed
            calendarData.timezone = SYSTEM_TIMEZONE;
            calendarData.timezoneOffsetMinutes = TIMEZONE_OFFSET_MINUTES;
        } catch (e) {
            console.error('[calendar] Error reading data:', e);
        }
    }
    return calendarData;
};

const saveData = () => {
    try {
        fs.writeFileSync(CALENDAR_DATA_PATH, JSON.stringify(calendarData, null, 2));
    } catch (e) {
        console.error('[calendar] Error saving data:', e);
    }
};

loadData();

// --- HELPER FUNCTIONS ---
const getEventOccurrences = (event, rangeStart, rangeEnd) => {
    const occurrences = [];
    const baseStart = new Date(event.start);
    const duration = event.duration || 0;
    
    const evnt = {
        year: baseStart.getFullYear(),
        month: baseStart.getMonth() + 1,
        date: baseStart.getDate(),
        day: baseStart.getDay() // 0 (Sun) - 6 (Sat)
    };

    if (!event.repeat) {
        const baseEnd = new Date(baseStart.getTime() + duration * 60000);
        if (baseEnd >= rangeStart && baseStart <= rangeEnd) {
            occurrences.push({ start: baseStart, end: baseEnd });
        }
        return occurrences;
    }
    
    // Recurring event - generate instances within range
    let currentIter = new Date(baseStart);
    // Limit to 1 year/366 days safety
    for (let i = 0; i < 366; i++) {
        const occEnd = new Date(currentIter.getTime() + duration * 60000);
        
        if (currentIter > rangeEnd) break;
        
        const curr = {
            year: currentIter.getFullYear(),
            month: currentIter.getMonth() + 1,
            date: currentIter.getDate(),
            day: currentIter.getDay()
        };

        let shouldInclude = false;
        try {
            // Support backward compatibility for strings like 'daily' etc.
            if (event.repeat === 'daily') {
                shouldInclude = true;
            } else if (event.repeat === 'weekly') {
                shouldInclude = curr.day === evnt.day;
            } else if (event.repeat === 'workdays') {
                shouldInclude = curr.day >= 1 && curr.day <= 5;
            } else if (event.repeat === 'weekend') {
                shouldInclude = curr.day === 0 || curr.day === 6;
            } else if (event.repeat === 'monthly') {
                shouldInclude = curr.date === evnt.date;
            } else if (event.repeat === 'yearly') {
                shouldInclude = curr.month === evnt.month && curr.date === evnt.date;
            } else if (typeof event.repeat === 'string' && event.repeat.includes('=>')) {
                // Execute the function string
                const evalFunc = new Function('curr', 'evnt', `return (${event.repeat})(curr, evnt)`);
                shouldInclude = evalFunc(curr, evnt);
            }
        } catch (e) {
            console.error(`[calendar] Error evaluating repeat function for event ${event.id}:`, e.message);
        }
        
        if (shouldInclude && occEnd >= rangeStart) {
            occurrences.push({ start: new Date(currentIter), end: occEnd });
        }
        
        currentIter.setDate(currentIter.getDate() + 1);
    }
    return occurrences;
};

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
        console.error(`[calendar] Error evaluating rule:`, e.message);
        return false;
    }
    
    return false;
};

const generateDateSamples = (dateA, dateB, sampleDays = 36500) => {
    // Use the later date as reference, sample forward
    const refDate = new Date(Math.max(dateA.getTime(), dateB.getTime()));
    const samples = [];
    
    for (let i = 0; i < sampleDays; i++) {
        samples.push(new Date(refDate.getTime() + i * 86400000));
    }
    
    return samples;
};

const checkRulesCanConflict = (eventA, eventB) => {
    // For non-recurring events, simple time range check
    if (!eventA.repeat && !eventB.repeat) {
        const startA = new Date(eventA.start);
        const endA = eventA.duration === 0 
            ? new Date(startA.getFullYear(), startA.getMonth(), startA.getDate(), 23, 59, 59)
            : new Date(startA.getTime() + (eventA.duration || 0) * 60000);
        const startB = new Date(eventB.start);
        const endB = eventB.duration === 0
            ? new Date(startB.getFullYear(), startB.getMonth(), startB.getDate(), 23, 59, 59)
            : new Date(startB.getTime() + (eventB.duration || 0) * 60000);
        return startA < endB && endA > startB;
    }
    
    // At least one is recurring - sample dates to check
    const samples = generateDateSamples(new Date(eventA.start), new Date(eventB.start));
    const evntA = dateToObj(new Date(eventA.start));
    const evntB = dateToObj(new Date(eventB.start));
    const startDateA = new Date(eventA.start);
    const startDateB = new Date(eventB.start);
    
    for (const sampleDate of samples) {
        const curr = dateToObj(sampleDate);
        
        // For non-recurring events, only match on their start date
        const matchesA = eventA.repeat 
            ? evaluateRepeatRule(eventA.repeat, curr, evntA)
            : (sampleDate.toDateString() === startDateA.toDateString());
        const matchesB = eventB.repeat 
            ? evaluateRepeatRule(eventB.repeat, curr, evntB)
            : (sampleDate.toDateString() === startDateB.toDateString());
        
        if (matchesA && matchesB) {
            // Both rules match on this date - check if times overlap
            const startA = new Date(sampleDate);
            const startTimeA = eventA.start.split('T')[1];
            const [hoursA, minutesA, secondsA = '00'] = startTimeA.split(':');
            startA.setHours(parseInt(hoursA), parseInt(minutesA), parseInt(secondsA));
            const endA = eventA.duration === 0
                ? new Date(startA.getFullYear(), startA.getMonth(), startA.getDate(), 23, 59, 59)
                : new Date(startA.getTime() + (eventA.duration || 0) * 60000);
            
            const startB = new Date(sampleDate);
            const startTimeB = eventB.start.split('T')[1];
            const [hoursB, minutesB, secondsB = '00'] = startTimeB.split(':');
            startB.setHours(parseInt(hoursB), parseInt(minutesB), parseInt(secondsB));
            const endB = eventB.duration === 0
                ? new Date(startB.getFullYear(), startB.getMonth(), startB.getDate(), 23, 59, 59)
                : new Date(startB.getTime() + (eventB.duration || 0) * 60000);
            
            if (startA < endB && endA > startB) {
                return true; // Conflict found
            }
        }
    }
    
    return false; // No conflict found in samples
};

const checkConflicts = (newEvent, excludeId = null) => {
    const conflicts = [];
    
    calendarData.items.forEach(existingEvent => {
        if (existingEvent.id === excludeId) return;
        
        // Check if either event is non-parallelable
        if (newEvent.parallelable === false || existingEvent.parallelable === false) {
            // Use optimized rule checking
            if (checkRulesCanConflict(newEvent, existingEvent)) {
                // If rules can conflict, add to conflicts for detailed info
                // For non-recurring, include exact times
                if (!newEvent.repeat && !existingEvent.repeat) {
                    const existingStart = new Date(existingEvent.start);
                    const existingDuration = existingEvent.duration || 0;
                    const existingEnd = new Date(existingStart.getTime() + existingDuration * 60000);
                    
                    conflicts.push({
                        eventId: existingEvent.id,
                        eventTitle: existingEvent.title,
                        existingStart: existingEvent.start,
                        existingEnd: existingEnd.toISOString(),
                        isExistingImportant: existingEvent.important !== false,
                        isExistingParallelable: existingEvent.parallelable !== false
                    });
                } else {
                    // For recurring, indicate conflict is possible
                    conflicts.push({
                        eventId: existingEvent.id,
                        eventTitle: existingEvent.title,
                        existingStart: existingEvent.start,
                        existingEnd: new Date(new Date(existingEvent.start).getTime() + (existingEvent.duration || 0) * 60000).toISOString(),
                        isExistingImportant: existingEvent.important !== false,
                        isExistingParallelable: existingEvent.parallelable !== false
                    });
                }
            }
        }
    });
    
    return conflicts;
};

const checkAndNotifyReminders = async () => {
    const now = new Date();
    let remindersToSend = [];
    
    calendarData.items.forEach(event => {
        const eventStart = new Date(event.start);
        const eventDuration = event.duration || 0;
        const eventEnd = new Date(eventStart.getTime() + eventDuration * 60000);
        
        // --- 1. Reminders ---
        // Only check future events that haven't started yet
        if (eventStart > now) {
            const reminds = event.reminds || [];
            
            reminds.forEach(reminderSeconds => {
                const reminderTime = new Date(eventStart.getTime() - reminderSeconds * 1000);
                
                // If reminder time is within the last 60 seconds, send it
                if (reminderTime <= now && reminderTime > new Date(now.getTime() - 60000)) {
                    remindersToSend.push({
                        eventName: 'calendar_reminder',
                        eventId: event.id,
                        eventTitle: event.title,
                        eventStart: event.start,
                        reminderIn: reminderSeconds,
                        description: event.description
                    });
                }
            });
        }

        // --- 2. Event Start ---
        // If event just started in the last 60 seconds
        if (eventStart <= now && eventStart > new Date(now.getTime() - 60000)) {
            remindersToSend.push({
                eventName: 'calendar_event_start',
                eventId: event.id,
                eventTitle: event.title,
                eventStart: event.start,
                eventEnd: eventEnd.toISOString(),
                description: event.description
            });
        }

        // --- 3. Event End ---
        // If event just ended in the last 60 seconds
        if (eventEnd <= now && eventEnd > new Date(now.getTime() - 60000)) {
            remindersToSend.push({
                eventName: 'calendar_event_end',
                eventId: event.id,
                eventTitle: event.title,
                eventStart: event.start,
                eventEnd: eventEnd.toISOString(),
                description: event.description
            });
        }
    });
    
    // Send notifications to agent if any
    if (remindersToSend.length > 0) {
        try {
            if (fs.existsSync(AGENT_SOCKET_PATH)) {
                await server.connect(AGENT_SOCKET_PATH);
                remindersToSend.forEach(notification => {
                    server.broadcast('event', notification);
                });
                console.log(`[calendar] Sent ${remindersToSend.length} notification(s) to agent`);
            }
        } catch (e) {
            console.error('[calendar] Failed to send notifications to agent:', e.message);
        }
    }
};

// --- TIMEZONE NORMALIZATION ---
const normalizeISODateWithTimezone = (isoString) => {
    if (!isoString) return isoString;
    
    // Check if it already has timezone info (Z or ±HH:MM at the end)
    const hasTimezone = /Z$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(isoString);
    
    if (hasTimezone) {
        return isoString; // Already has timezone, return as-is
    }
    
    // No timezone info - append the system timezone offset
    const offsetMinutes = TIMEZONE_OFFSET_MINUTES;
    const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
    const offsetMins = Math.abs(offsetMinutes) % 60;
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const offsetStr = `${sign}${String(offsetHours).padStart(2, '0')}:${String(offsetMins).padStart(2, '0')}`;
    
    return `${isoString}${offsetStr}`;
};

// --- TOOL DEFINITIONS ---
const calendarTools = [
    {
        name: 'createEvent',
        description: 'Create a new calendar event. If the ISO start date has no timezone, the system timezone is automatically applied. Repeat is an optional cron-like string or "weekend", "workdays", "daily", "weekly".',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Event title' },
                description: { type: 'string', description: 'Markdown description' },
                start: { type: 'string', description: 'ISO start date (timezone automatically applied if omitted)' },
                duration: { type: 'number', description: 'Duration in minutes (optional)' },
                repeat: { type: 'string', description: 'Repeat rule: "daily", "weekly", "workdays", "weekend", "monthly", "yearly", or a function string like "(curr, evnt) => curr.day == evnt.day"' },
                parallelable: { type: 'boolean', description: 'If false, no other events can overlap with this one (default: true)' },
                important: { type: 'boolean', description: 'If true, important event (default: true)' },
                reminds: { type: 'array', items: { type: 'number' }, description: 'Array of seconds before event to send reminders (e.g., [60, 3600] for 1 min and 1 hour)' },
                attachments: { 
                    type: 'array', 
                    items: {
                        type: 'object',
                        properties: {
                            type: { type: 'string', enum: ['url', 'image', 'file'] },
                            value: { type: 'string' }
                        }
                    }
                },
                tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['title']
        }
    },
    {
        name: 'listEvents',
        description: 'List all raw unprocessed calendar events data.',
        parameters: { type: 'object', properties: {} }
    },
    {
        name: 'updateEvent',
        description: 'Update an existing event by its ID.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                updates: { type: 'object' }
            },
            required: ['id', 'updates']
        }
    },
    {
        name: 'deleteEvent',
        description: 'Delete an event by ID.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string' }
            },
            required: ['id']
        }
    },
    {
        name: 'timeline',
        description: 'Get upcoming timeline of events (excludes past events that have already occurred).',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: 'Maximum number of events to return (optional, default 50)' }
            }
        }
    },
    {
        name: 'getUpcomingReminders',
        description: 'Get upcoming events that have reminders set, useful for the agent to know what to notify about.',
        parameters: {
            type: 'object',
            properties: {
                hoursAhead: { type: 'number', description: 'Look ahead this many hours (default 24)' }
            }
        }
    }
];

// --- LOGIC ---
server.listen('*', 'createEvent', (req, res) => {
    const eventData = {
        ...req.data,
        parallelable: req.data.parallelable !== false ? true : false,
        important: req.data.important !== false ? true : false,
        reminds: req.data.reminds || []
    };
    
    // Normalize timezone in start date if not present
    if (eventData.start) {
        eventData.start = normalizeISODateWithTimezone(eventData.start);
    }
    
    // Check for conflicts if event is non-parallelable
    const conflicts = checkConflicts(eventData);
    
    if (conflicts.length > 0) {
        // If new event is non-parallelable: ALWAYS block any overlap
        if (eventData.parallelable === false) {
            return res.send({
                success: false,
                error: 'Conflict detected',
                conflicts: conflicts
            });
        }
        
        // New event is parallelable: check if it can parallel with conflicting events
        // Important non-parallelable events allow parallelable events if new event is not important
        const blockedConflicts = conflicts.filter(c => {
            const existingEvent = calendarData.items.find(e => e.id === c.eventId);
            if (!existingEvent || existingEvent.parallelable !== false) {
                return false; // Not a non-parallelable conflict, can parallel
            }
            
            // Non-parallelable event found:
            // - If existing is not important: allow parallel (lower priority event)
            // - If existing is important and new is not important: allow parallel (important event can be paralleled by non-important)
            // - If existing is important and new is important: block (two important events can't overlap)
            if (c.isExistingImportant && eventData.important) {
                return true; // Block: both important
            }
            
            return false; // Allow: either existing is not important, or new is not important
        });
        
        if (blockedConflicts.length > 0) {
            return res.send({
                success: false,
                error: 'Conflict with important event(s)',
                conflicts: blockedConflicts
            });
        }
    }
    
    const event = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        ...eventData,
        createdAt: new Date().toISOString()
    };
    
    calendarData.items.push(event);
    saveData();
    res.send({ success: true, event });
});

server.listen('*', 'listEvents', (req, res) => {
    res.send(calendarData.items);
});

server.listen('*', 'updateEvent', (req, res) => {
    const { id, updates } = req.data;
    const index = calendarData.items.findIndex(i => i.id === id);
    
    if (index > -1) {
        const existingEvent = calendarData.items[index];
        const updatedEvent = { ...existingEvent, ...updates };
        
        // Normalize timezone in start date if being updated
        if (updates.start) {
            updatedEvent.start = normalizeISODateWithTimezone(updates.start);
        }
        
        // Ensure proper boolean defaults
        updatedEvent.parallelable = updatedEvent.parallelable !== false ? true : false;
        updatedEvent.important = updatedEvent.important !== false ? true : false;
        updatedEvent.reminds = updatedEvent.reminds || [];
        
        // Check for conflicts, excluding the current event being updated
        const conflicts = checkConflicts(updatedEvent, id);
        
        // Apply the same conflict resolution logic as createEvent
        if (conflicts.length > 0) {
            // If updated event is non-parallelable: ALWAYS block any overlap
            if (updatedEvent.parallelable === false) {
                return res.send({
                    success: false,
                    error: 'Conflict detected',
                    conflicts: conflicts
                });
            }
            
            // Updated event is parallelable: check if it can parallel with conflicting events
            const blockedConflicts = conflicts.filter(c => {
                const conflictingEvent = calendarData.items.find(e => e.id === c.eventId);
                if (!conflictingEvent || conflictingEvent.parallelable !== false) {
                    return false;
                }
                
                if (c.isExistingImportant && updatedEvent.important) {
                    return true; // Block: both important
                }
                
                return false; // Allow
            });
            
            if (blockedConflicts.length > 0) {
                return res.send({
                    success: false,
                    error: 'Conflict with important event(s)',
                    conflicts: blockedConflicts
                });
            }
        }
        
        calendarData.items[index] = updatedEvent;
        saveData();
        res.send({ success: true, event: updatedEvent });
    } else {
        res.send({ success: false, error: 'Event not found' });
    }
});

server.listen('*', 'deleteEvent', (req, res) => {
    const { id } = req.data;
    const initialLen = calendarData.items.length;
    const deletedEvent = calendarData.items.find(i => i.id === id);
    calendarData.items = calendarData.items.filter(i => i.id !== id);
    if (calendarData.items.length < initialLen) {
        saveData();
        res.send({ success: true });
    } else {
        res.send({ success: false, error: 'Event not found' });
    }
});

server.listen('*', 'timeline', (req, res) => {
    const now = new Date();
    const limit = req.data?.limit || 50;
    let timelineEvents = [];
    
    calendarData.items.forEach(ev => {
        const startTime = ev.start || '';
        
        if (!ev.repeat) {
            // Single event - check if it's in the future or currently happening
            const eventStart = new Date(startTime);
            const eventDuration = ev.duration || 0;
            const eventEnd = new Date(eventStart.getTime() + eventDuration * 60000);
            
            // Include if event hasn't ended yet
            if (eventEnd >= now) {
                timelineEvents.push({
                    ...ev,
                    occurrenceStart: startTime,
                    occurrenceEnd: eventEnd.toISOString()
                });
            }
        } else {
            // Recurring event - generate instances from now onwards
            const startDate = new Date(startTime);
            const endLimit = new Date(now.getTime() + 12 * 7 * 24 * 60 * 60 * 1000); // 12 weeks from now
            
            let currentDate = new Date(startDate);
            
            for (let i = 0; i < 84; i++) {
                if (currentDate > endLimit || timelineEvents.length >= limit) break;
                
                const shouldInclude = 
                    (ev.repeat === 'daily') ||
                    (ev.repeat === 'weekly' && currentDate.getDay() === startDate.getDay()) ||
                    (ev.repeat === 'workdays' && currentDate.getDay() >= 1 && currentDate.getDay() <= 5) ||
                    (ev.repeat === 'weekend' && (currentDate.getDay() === 0 || currentDate.getDay() === 6)) ||
                    (ev.repeat === 'monthly' && currentDate.getDate() === startDate.getDate()) ||
                    (ev.repeat === 'yearly' && currentDate.getMonth() === startDate.getMonth() && currentDate.getDate() === startDate.getDate());
                
                if (shouldInclude) {
                    const pad = (n) => String(n).padStart(2, '0');
                    const timeStr = startTime.split('T')[1];
                    const curr = {
                        year: currentDate.getFullYear(),
                        month: currentDate.getMonth() + 1,
                        date: currentDate.getDate(),
                        day: currentDate.getDay()
                    };
                    const evnt = {
                        year: startDate.getFullYear(),
                        month: startDate.getMonth() + 1,
                        date: startDate.getDate(),
                        day: startDate.getDay()
                    };

                    let isMatch = false;
                    try {
                        if (ev.repeat === 'daily') isMatch = true;
                        else if (ev.repeat === 'weekly' && curr.day === evnt.day) isMatch = true;
                        else if (ev.repeat === 'workdays' && curr.day >= 1 && curr.day <= 5) isMatch = true;
                        else if (ev.repeat === 'weekend' && (curr.day === 0 || curr.day === 6)) isMatch = true;
                        else if (ev.repeat === 'monthly' && curr.date === evnt.date) isMatch = true;
                        else if (ev.repeat === 'yearly' && curr.month === evnt.month && curr.date === evnt.date) isMatch = true;
                        else if (typeof ev.repeat === 'string' && ev.repeat.includes('=>')) {
                            const evalFunc = new Function('curr', 'evnt', `return (${ev.repeat})(curr, evnt)`);
                            isMatch = evalFunc(curr, evnt);
                        }
                    } catch (e) {
                        console.error(`[calendar] Timeline eval error for ${ev.id}:`, e.message);
                    }

                    if (isMatch) {
                        const occStart = new Date(`${pad(currentDate.getFullYear())}-${pad(currentDate.getMonth() + 1)}-${pad(currentDate.getDate())}T${timeStr}`);
                        const occEnd = new Date(occStart.getTime() + (ev.duration || 0) * 60000);
                        
                        // Only include if occurrence hasn't ended
                        if (occEnd >= now) {
                            timelineEvents.push({
                                ...ev,
                                id: `${ev.id}_${i}`,
                                occurrenceStart: occStart.toISOString(),
                                occurrenceEnd: occEnd.toISOString()
                            });
                        }
                    }
                }
                
                currentDate.setDate(currentDate.getDate() + 1);
            }
        }
    });
    
    // Sort by occurrence start time
    timelineEvents.sort((a, b) => new Date(a.occurrenceStart) - new Date(b.occurrenceStart));
    
    res.send(timelineEvents.slice(0, limit));
});

server.listen('*', 'getUpcomingReminders', (req, res) => {
    const now = new Date();
    const hoursAhead = req.data?.hoursAhead || 24;
    const endTime = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
    let upcomingReminders = [];
    
    calendarData.items.forEach(ev => {
        if (!ev.reminds || ev.reminds.length === 0) return;
        
        const startTime = ev.start || '';
        const eventStart = new Date(startTime);
        
        // Only check future events
        if (eventStart > now && eventStart <= endTime) {
            ev.reminds.forEach(reminderSeconds => {
                const reminderTime = new Date(eventStart.getTime() - reminderSeconds * 1000);
                
                upcomingReminders.push({
                    eventId: ev.id,
                    eventTitle: ev.title,
                    eventStart: ev.start,
                    reminderInSeconds: reminderSeconds,
                    reminderTime: reminderTime.toISOString(),
                    description: ev.description,
                    minutesUntilReminder: Math.floor((reminderTime - now) / 60000)
                });
            });
        }
    });
    
    // Sort by reminder time
    upcomingReminders.sort((a, b) => new Date(a.reminderTime) - new Date(b.reminderTime));
    
    res.send(upcomingReminders);
});

// --- CONNECT ---
server.connect(TOOLS_SOCKET_PATH, async () => {
    console.log('[calendar] Connected to Tools; registering capabilities...');
    console.log(`[calendar] System timezone: ${SYSTEM_TIMEZONE} (UTC${TIMEZONE_OFFSET_MINUTES >= 0 ? '+' : ''}${Math.floor(TIMEZONE_OFFSET_MINUTES / 60)}:${String(TIMEZONE_OFFSET_MINUTES % 60).padStart(2, '0')})`);
    try {
        await server.request('tools', 'register', calendarTools);
        console.log('[calendar] Calendar tools registered.');
    } catch (err) {
        console.error('[calendar] Tool registration failed:', err.message);
    }
});

// Connect to Agent for notifications
server.connect(AGENT_SOCKET_PATH, async () => {
    console.log('[calendar] Connected to Agent for notifications');
});

// Start periodic reminder checking (every 30 seconds)
setInterval(async () => {
    try {
        await checkAndNotifyReminders();
    } catch (e) {
        console.error('[calendar] Error in reminder check interval:', e.message);
    }
}, 30000);

// Check reminders immediately on startup
checkAndNotifyReminders().catch(e => console.error('[calendar] Initial reminder check failed:', e.message));

server.start();