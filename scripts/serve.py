#!/usr/bin/env python3
"""Dev static server that disables caching, so edits always show up on reload
(Safari in particular caches aggressively and ignored our query-string busting)."""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


with Server(("127.0.0.1", PORT), NoCacheHandler) as httpd:
    print(f"serving (no-cache) on http://localhost:{PORT}")
    httpd.serve_forever()
