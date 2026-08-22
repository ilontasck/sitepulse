#!/usr/bin/env python3
import ipaddress
import socketserver
import struct
import threading

WEB_PUBLIC_IP = "167.233.20.67"
PRIVATE_TARGET = "198.19.0.1"
BIND_IP = "167.233.141.10"
STATE = {"rebind_a_queries": 0}
LOCK = threading.Lock()


def question(packet):
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


def response(packet):
    try:
        name, qtype, qclass, question_end = question(packet)
    except Exception:
        return b""
    answers = []
    if qclass == 1 and name == "rebind" and qtype == 1:
        with LOCK:
            STATE["rebind_a_queries"] += 1
            address = WEB_PUBLIC_IP if STATE["rebind_a_queries"] == 1 else PRIVATE_TARGET
        answers.append((1, ipaddress.ip_address(address).packed))
    elif qclass == 1 and name == "mixed" and qtype == 1:
        answers.append((1, ipaddress.ip_address(WEB_PUBLIC_IP).packed))
    elif qclass == 1 and name == "mixed" and qtype == 28:
        answers.append((28, ipaddress.ip_address("::1").packed))
    flags = 0x8180 if name in {"rebind", "mixed"} else 0x8183
    encoded = packet[:2] + struct.pack("!HHHHH", flags, 1, len(answers), 0, 0) + packet[12:question_end]
    for answer_type, value in answers:
        encoded += struct.pack("!HHHIH", 0xC00C, answer_type, 1, 0, len(value)) + value
    return encoded


class UdpHandler(socketserver.BaseRequestHandler):
    def handle(self):
        packet, sock = self.request
        encoded = response(packet)
        if encoded:
            sock.sendto(encoded, self.client_address)


class TcpHandler(socketserver.BaseRequestHandler):
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
        encoded = response(packet)
        if encoded:
            self.request.sendall(struct.pack("!H", len(encoded)) + encoded)


udp = socketserver.ThreadingUDPServer((BIND_IP, 53), UdpHandler)
tcp = socketserver.ThreadingTCPServer((BIND_IP, 53), TcpHandler)
threading.Thread(target=udp.serve_forever, daemon=True).start()
tcp.serve_forever()
