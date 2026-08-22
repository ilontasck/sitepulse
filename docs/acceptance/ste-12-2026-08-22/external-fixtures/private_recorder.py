#!/usr/bin/env python3
import http.server
import threading

REACHED = set()
LOCK = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        return

    def respond(self, status, body):
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/private/"):
            scenario = path.removeprefix("/private/")
            with LOCK:
                REACHED.add(scenario)
            return self.respond(200, "reached")
        if path.startswith("/assert/") and path.endswith("/not-reached"):
            scenario = path.removeprefix("/assert/").removesuffix("/not-reached")
            with LOCK:
                reached = scenario in REACHED
            return self.respond(409 if reached else 200, "reached" if reached else "not reached")
        return self.respond(404, "not found")


def run(address):
    server = http.server.ThreadingHTTPServer(address, Handler)
    server.serve_forever()


threading.Thread(target=run, args=(("198.19.0.1", 80),), daemon=True).start()
run(("127.0.0.1", 18080))
