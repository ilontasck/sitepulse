#!/usr/bin/env python3
import http.server
import ipaddress
import socket
import socketserver
import ssl
import struct
import threading
import time

PUBLIC_IP = "167.233.20.67"
PRIVATE_TARGET = "198.19.0.1"
STATE = {"udp443": False, "rebind_a_queries": 0, "slow_html_requests": 0}
LOCK = threading.Lock()


def dns_question(packet):
    offset = 12
    labels = []
    while packet[offset]:
        length = packet[offset]
        offset += 1
        labels.append(packet[offset:offset + length].decode("ascii"))
        offset += length
    offset += 1
    qtype, qclass = struct.unpack("!HH", packet[offset:offset + 4])
    return ".".join(labels).lower(), qtype, qclass, offset + 4


def dns_response(packet):
    try:
        name, qtype, qclass, question_end = dns_question(packet)
    except Exception:
        return b""
    answers = []
    if qclass == 1 and name == "rebind.invalid" and qtype == 1:
        with LOCK:
            STATE["rebind_a_queries"] += 1
            address = PUBLIC_IP if STATE["rebind_a_queries"] == 1 else PRIVATE_TARGET
        answers.append((1, ipaddress.ip_address(address).packed))
    elif qclass == 1 and name == "mixed.invalid" and qtype == 1:
        answers.append((1, ipaddress.ip_address(PUBLIC_IP).packed))
    elif qclass == 1 and name == "mixed.invalid" and qtype == 28:
        answers.append((28, ipaddress.ip_address("::1").packed))
    flags = 0x8180 if name in {"rebind.invalid", "mixed.invalid"} else 0x8183
    response = packet[:2] + struct.pack("!HHHHH", flags, 1, len(answers), 0, 0) + packet[12:question_end]
    for answer_type, value in answers:
        response += struct.pack("!HHHIH", 0xC00C, answer_type, 1, 0, len(value)) + value
    return response


class DnsUdpHandler(socketserver.BaseRequestHandler):
    def handle(self):
        packet, sock = self.request
        response = dns_response(packet)
        if response:
            sock.sendto(response, self.client_address)


class DnsTcpHandler(socketserver.BaseRequestHandler):
    def handle(self):
        size_bytes = self.request.recv(2)
        if len(size_bytes) != 2:
            return
        size = struct.unpack("!H", size_bytes)[0]
        packet = b""
        while len(packet) < size:
            chunk = self.request.recv(size - len(packet))
            if not chunk:
                return
            packet += chunk
        response = dns_response(packet)
        if response:
            self.request.sendall(struct.pack("!H", len(response)) + response)


class FixtureHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        return

    def send_body(self, status, body, content_type="text/html; charset=utf-8", headers=None):
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/public":
            return self.send_body(200, "<!doctype html><title>STE-12 public fixture</title><main>public fixture ok</main>")
        if path == "/redirect-private":
            return self.send_body(302, "redirect", headers={"Location": f"http://{PRIVATE_TARGET}/private/redirect"})
        if path == "/private-subresource":
            return self.send_body(200, f'<!doctype html><title>private subresource</title><img src="http://{PRIVATE_TARGET}/private/private-subresource">')
        if path == "/private-websocket":
            return self.send_body(200, f'''<!doctype html><title>private websocket</title><script>
              const ws = new WebSocket("ws://{PRIVATE_TARGET}/private/private-websocket");
              ws.onerror = () => document.body.dataset.websocket = "blocked";
            </script>''')
        if path == "/dns-rebind":
            with LOCK:
                STATE["rebind_a_queries"] = 0
            return self.send_body(200, '<!doctype html><title>dns rebind</title><img src="http://rebind/private/dns-rebind">')
        if path == "/mixed-a-aaaa":
            return self.send_body(200, '<!doctype html><title>mixed dns</title><img src="http://mixed/private/mixed-a-private-aaaa">')
        if path == "/slow-rendered":
            return self.send_body(200, '<!doctype html><title>slow rendered</title><img src="/slow-resource">')
        if path == "/slow-resource":
            time.sleep(30)
            return self.send_body(200, "slow", "text/plain")
        if path == "/slow-html":
            with LOCK:
                STATE["slow_html_requests"] += 1
                slow_first_attempt = STATE["slow_html_requests"] == 1
            if slow_first_attempt:
                time.sleep(30)
            return self.send_body(200, "<!doctype html><title>slow html</title>")
        if path == "/assert/udp443/not-reached":
            with LOCK:
                reached = STATE["udp443"]
            return self.send_body(409 if reached else 200, "reached" if reached else "not reached", "text/plain")
        if path.startswith("/private/"):
            return self.send_body(409, "unexpected public fixture reach", "text/plain")
        return self.send_body(404, "not found", "text/plain")


class ReusableUdpServer(socketserver.ThreadingUDPServer):
    allow_reuse_address = True


class ReusableTcpServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


def run_udp_443():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((PUBLIC_IP, 443))
    while True:
        sock.recvfrom(65535)
        with LOCK:
            STATE["udp443"] = True


def serve():
    servers = [
        ReusableUdpServer((PUBLIC_IP, 53), DnsUdpHandler),
        ReusableTcpServer((PUBLIC_IP, 53), DnsTcpHandler),
        http.server.ThreadingHTTPServer((PUBLIC_IP, 80), FixtureHandler),
    ]
    https = http.server.ThreadingHTTPServer((PUBLIC_IP, 443), FixtureHandler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(
        "/etc/letsencrypt/live/167.233.20.67/fullchain.pem",
        "/etc/letsencrypt/live/167.233.20.67/privkey.pem",
    )
    https.socket = context.wrap_socket(https.socket, server_side=True)
    servers.append(https)
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=run_udp_443, daemon=True).start()
    threading.Event().wait()


if __name__ == "__main__":
    serve()
