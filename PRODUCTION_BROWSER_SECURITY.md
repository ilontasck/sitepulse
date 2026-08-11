# Production Browser Security

This document defines the required deployment boundary for SitePulse rendered audits. Application-level URL validation is defense in depth; it is not a replacement for network isolation because Chromium performs its own DNS resolution and networking.

## Worker Boundary

Run Chromium audits in a dedicated, unprivileged worker process or sandbox separate from the public HTTP process. Use a fresh temporary browser profile per audit, no host filesystem mounts, no host network mode, no cloud credentials, no browser login state, and no access to the application database or environment secrets.

Recommended beta limits per worker:

- 1 concurrent Chromium audit by default.
- 1-2 vCPU maximum.
- 2 GiB RAM maximum per active audit worker for the current Chromium build. Local sampling reached about 1.5 GiB aggregate RSS across the Chromium process tree.
- A small PID/process limit sufficient for Chromium, enforced by the runtime.
- 45-second application timeout and a 60-second hard process/runtime deadline.
- Kill the complete Chromium process tree after success, timeout, crash, or client cancellation.

## Outbound Network Policy

Allow only:

- DNS through a controlled resolver.
- TCP ports 80 and 443 to globally routable public destinations.

Deny all other outbound ports and protocols. Deny access to the host, loopback, local network, orchestration control plane, cloud metadata, internal DNS, and link-local services.

At minimum block these IPv4 destinations:

- `0.0.0.0/8`
- `10.0.0.0/8`
- `100.64.0.0/10`
- `127.0.0.0/8`
- `169.254.0.0/16`, including `169.254.169.254`
- `172.16.0.0/12`
- `192.0.0.0/24`
- `192.0.2.0/24`
- `192.88.99.0/24`
- `192.168.0.0/16`
- `198.18.0.0/15`
- `198.51.100.0/24`
- `203.0.113.0/24`
- multicast and reserved space `224.0.0.0/4`

At minimum block these IPv6 destinations:

- unspecified and loopback: `::/128`, `::1/128`
- IPv4-mapped private/reserved destinations
- unique local: `fc00::/7`
- link-local: `fe80::/10`
- multicast: `ff00::/8`
- documentation: `2001:db8::/32`
- 6to4: `2002::/16`
- NAT64 prefixes when they could translate to private/reserved IPv4

Also block internal and metadata hostnames such as `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.home`, `*.home.arpa`, and `metadata.google.internal`. Hostname blocking alone is insufficient.

## DNS And Redirects

- Resolve through a worker-controlled resolver that cannot return or route to blocked ranges.
- Apply firewall policy to the actual connection destination, not only to the preflight DNS answer.
- Recheck every redirect and browser subresource.
- Treat answers changing between validation and connection as untrusted DNS rebinding; the network layer must still reject the final private address.
- Do not copy the public application's DNS search domains into the worker.

## Browser Behavior

SitePulse currently validates the initial URL, final URL, HTTP requests, redirects, subresources, and WebSockets. It starts a fresh Chrome profile, disables background networking features, and blocks service-worker registration through an initialization script.

Production isolation must still assume that Chromium, service workers, browser internals, extensions, protocol handlers, or future browser behavior can bypass application hooks. Enforce the outbound policy outside Chromium.

## Telemetry And Incident Signals

Alert on sustained increases in:

- rendered timeouts or crashes;
- concurrency rejections;
- application-level network blocks;
- audit duration or memory usage;
- worker termination by memory/CPU limits.

Never place target HTML, request headers, cookies, tokens, page screenshots, environment contents, or full URLs with query strings in telemetry logs.
