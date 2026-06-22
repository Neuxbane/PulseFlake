(function() {
    let calendar = null;
    let calendarData = { items: [] }; // Store raw calendar data for duplication
    let editingEventId = null;
    let fetchInterval = null;
    let nowIndicatorInterval = null;

    // Time helper log function
    const log = (source, msg) => {
        if (window.appendLog) {
            window.appendLog(source, msg);
        } else {
            console.log(`[${source}] ${msg}`);
        }
    };

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
        
        if (presetValue === 'custom') {
            repeatInput.focus();
        }
    }

    function formatLocalDateTime(date) {
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

    function initCalendar() {
        const calendarEl = document.getElementById('calendar');
        if (!calendarEl || calendar) return; 

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
            editable: true,
            eventDurationEditable: true,
            eventResizableFromStart: true,
            selectable: true,
            selectConstraint: 'businessHours',
            eventClick: function(info) {
                if (info.jsEvent.ctrlKey || info.jsEvent.metaKey) {
                    duplicateEvent(info.event);
                    return;
                }
                openEditModal(info.event);
            },
            select: function(info) {
                openCreateModalForSlot(info.start, info.end);
            },
            eventDrop: function(info) {
                saveEventChanges(info.event, {
                    start: info.event.start
                });
            },
            eventResize: function(info) {
                const duration = Math.round((info.event.end - info.event.start) / 60000);
                saveEventChanges(info.event, {
                    duration: duration
                });
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
        
        fetchAndUpdateEvents();
        fetchInterval = setInterval(fetchAndUpdateEvents, 5000);
        
        updateNowIndicatorPosition();
        nowIndicatorInterval = setInterval(updateNowIndicatorPosition, 60000); 
    }

    function updateNowIndicatorPosition() {
        if (calendar) {
            const view = calendar.view;
            if (view && view.type && view.type.includes('timeGrid')) {
                calendar.unselect();
            }
        }
    }

    function fetchAndUpdateEvents() {
        fetch('/api/calendar/events')
            .then(res => res.json())
            .then(events => {
                calendarData.items = events; 
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
                    if (window.socket) {
                        window.socket.emit('calendar_events', events);
                    }
                    updateCalendarEvents(events);
                });
        }
        
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
            
            const getSeededColor = (seed) => {
                let hash = 0;
                for (let i = 0; i < seed.length; i++) {
                    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
                }
                const h = Math.abs(hash % 360);
                const s = 70 + (Math.abs(hash % 20)); 
                const l = 75 + (Math.abs(hash % 10));
                return `hsl(${h}, ${s}%, ${l}%)`;
            };

            events.forEach(ev => {
                const occurrences = expandEventOccurrences(ev);
                const sortedTags = (ev.tags || []).slice().sort().join(',');
                const eventColor = sortedTags ? getSeededColor(sortedTags) : '#ec4899'; 
                
                occurrences.forEach(occ => {
                    const base = {
                        id: occ.id,
                        title: occ.title,
                        start: occ.occurrenceStart,
                        allDay: occ.allDay || false,
                        description: occ.description,
                        backgroundColor: eventColor,
                        borderColor: eventColor,
                        textColor: '#111827', 
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
        const eventId = event.id;
        const originalId = eventId.includes('_') ? eventId.split('_')[0] : eventId;
        editingEventId = originalId;
        
        document.getElementById('modal-event').classList.remove('hidden');
        document.getElementById('event-title').value = event.title || '';
        
        if (data.start) {
            const timeStr = data.start.split('+')[0].split('Z')[0];
            document.getElementById('event-start').value = timeStr;
        }
        
        document.getElementById('event-duration').value = data.duration || '60';
        const isAllDay = data.duration === 0;
        document.getElementById('event-all-day').checked = isAllDay;
        document.getElementById('event-duration').disabled = isAllDay;
        document.getElementById('event-repeat').value = data.repeat || '';
        
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

        fetch('/api/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                socketPath: 'calendar', 
                toolName: 'deleteEvent', 
                arguments: { id: editingEventId } 
            })
        })
        .then(res => res.json())
        .then(res => {
            if (res.success) {
                closeEventModal();
                onCalendarPageOpened(); 
                log('Calendar', `Deleted event: ${editingEventId}`);
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

        fetch('/api/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                socketPath: 'calendar', 
                toolName: toolName, 
                arguments: toolArgs 
            })
        })
        .then(res => res.json())
        .then(res => {
            if (res.success) {
                closeEventModal();
                onCalendarPageOpened(); 
                log('Calendar', `${editingEventId ? 'Updated' : 'Created'} event: ${title}`);
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

    function duplicateEvent(event) {
        const data = event.extendedProps;
        const eventId = event.id;
        const originalId = eventId.includes('_') ? eventId.split('_')[0] : eventId;
        
        const originalEvent = calendarData?.items?.find(e => e.id === originalId);
        if (!originalEvent) {
            alert('Could not find original event data');
            return;
        }

        const newStartDate = new Date(event.start);
        newStartDate.setDate(newStartDate.getDate() + 7); 
        
        const duplicatedEvent = {
            title: originalEvent.title,
            start: formatLocalDateTime(newStartDate),
            duration: originalEvent.duration || 60,
            repeat: originalEvent.repeat || '',
            description: originalEvent.description || '',
            tags: originalEvent.tags || [],
            parallelable: originalEvent.parallelable !== false,
            important: originalEvent.important !== false,
            reminds: originalEvent.reminds || []
        };

        fetch('/api/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                socketPath: 'calendar', 
                toolName: 'createEvent', 
                arguments: duplicatedEvent
            })
        })
        .then(res => res.json())
        .then(res => {
            if (res.success) {
                onCalendarPageOpened();
                log('Calendar', `Duplicated event: ${originalEvent.title}`);
            } else {
                alert('Error duplicating event: ' + (res.error || 'Unknown error'));
            }
        })
        .catch(err => alert('Network error: ' + err.message));
    }

    function openCreateModalForSlot(startDate, endDate) {
        editingEventId = null;
        document.getElementById('modal-event').classList.remove('hidden');
        document.getElementById('event-title').value = '';
        document.getElementById('event-title').focus();
        
        document.getElementById('event-start').value = formatLocalDateTime(startDate);
        
        const durationMs = endDate - startDate;
        const durationMins = Math.round(durationMs / 60000);
        document.getElementById('event-duration').value = durationMins || 60;
        
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

    function saveEventChanges(event, updates) {
        const eventId = event.id;
        const originalId = eventId.includes('_') ? eventId.split('_')[0] : eventId;
        
        const updateData = {};
        if (updates.start) {
            const startDate = new Date(updates.start);
            updateData.start = formatLocalDateTime(startDate);
        }
        if (updates.duration) {
            updateData.duration = updates.duration;
        }

        fetch('/api/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                socketPath: 'calendar', 
                toolName: 'updateEvent', 
                arguments: { id: originalId, updates: updateData }
            })
        })
        .then(res => res.json())
        .then(res => {
            if (!res.success) {
                onCalendarPageOpened();
                log('Calendar', `Error updating event: ${res.error || 'Unknown error'}`);
            } else {
                log('Calendar', `Updated event: ${event.title}`);
            }
        })
        .catch(err => {
            onCalendarPageOpened();
            log('Calendar', `Network error updating event: ${err.message}`);
        });
    }

    const onSocketCalendarEvents = (events) => {
        updateCalendarEvents(events);
    };

    // Register inside PulseFlakeApps registry
    window.PulseFlakeApps = window.PulseFlakeApps || {};
    window.PulseFlakeApps['calendar'] = {
        init: function() {
            initCalendar();
            onCalendarPageOpened();
            
            if (window.socket) {
                window.socket.on('calendar_events', onSocketCalendarEvents);
            }
        },
        destroy: function() {
            if (calendar) {
                calendar.destroy();
                calendar = null;
            }
            if (window.socket) {
                window.socket.off('calendar_events', onSocketCalendarEvents);
            }
            if (fetchInterval) {
                clearInterval(fetchInterval);
                fetchInterval = null;
            }
            if (nowIndicatorInterval) {
                clearInterval(nowIndicatorInterval);
                nowIndicatorInterval = null;
            }
        },
        // Expose functions called by HTML inline event handlers
        openCreateModal,
        closeEventModal,
        onCalendarPageOpened,
        toggleAllDayUI,
        updateRepeatFunction,
        deleteCurrentEvent,
        commitEvent
    };
})();
