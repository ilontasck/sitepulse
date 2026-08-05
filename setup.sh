#!/usr/bin/env sh
set -eu

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=5

info() {
  printf '%s\n' "$1"
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

info "Preparing SitePulse..."

command_exists node || fail "Node.js is not installed. Install Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ first."

NODE_VERSION="$(node -p "process.versions.node")"
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
NODE_MINOR="$(node -p "Number(process.versions.node.split('.')[1])")"

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  fail "Node.js ${NODE_VERSION} is installed, but SitePulse requires ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+."
fi

info "Node.js ${NODE_VERSION} detected."

if ! command_exists pnpm; then
  if command_exists corepack; then
    info "pnpm was not found. Enabling Corepack..."
    corepack enable
  else
    fail "pnpm is not installed and Corepack is unavailable. Install pnpm, then rerun this script."
  fi
fi

command_exists pnpm || fail "pnpm is still unavailable after Corepack setup."

mkdir -p data

if [ ! -f .env ]; then
  cp .env.example .env
  info "Created .env from .env.example."
else
  info ".env already exists; leaving it unchanged."
fi

info "Installing dependencies..."
pnpm install --frozen-lockfile

info "Installing Playwright Chromium..."
pnpm exec playwright install chromium

info "Running unit tests..."
pnpm test

info "SitePulse is ready. Start it with: pnpm start"
