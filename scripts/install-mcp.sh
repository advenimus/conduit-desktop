#!/bin/bash

# Conduit MCP Server Installation Script for Claude Code
# Usage: ./install-mcp.sh [path-to-conduit-mcp-dir]
#
# Detects both development and packaged app locations:
#   Development: ./mcp/dist/index.js
#   macOS app:   /Applications/Conduit.app/Contents/Resources/mcp/dist/index.js
#   Windows app: %LOCALAPPDATA%/Programs/Conduit/resources/mcp/dist/index.js
#   Linux app:   /opt/Conduit/resources/mcp/dist/index.js

set -e

CONDUIT_MCP_ENTRY=""

# Check explicit argument first
if [ -n "$1" ]; then
    if [ -f "$1/dist/index.js" ]; then
        CONDUIT_MCP_ENTRY="$(cd "$1/dist" && pwd)/index.js"
    elif [ -f "$1" ]; then
        CONDUIT_MCP_ENTRY="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
    fi
fi

# Check development location (relative to script or cwd)
if [ -z "$CONDUIT_MCP_ENTRY" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

    if [ -f "$PROJECT_ROOT/mcp/dist/index.js" ]; then
        CONDUIT_MCP_ENTRY="$PROJECT_ROOT/mcp/dist/index.js"
    elif [ -f "./mcp/dist/index.js" ]; then
        CONDUIT_MCP_ENTRY="$(cd ./mcp/dist && pwd)/index.js"
    fi
fi

# Check packaged app locations
if [ -z "$CONDUIT_MCP_ENTRY" ]; then
    # macOS
    if [ -f "/Applications/Conduit.app/Contents/Resources/mcp/dist/index.js" ]; then
        CONDUIT_MCP_ENTRY="/Applications/Conduit.app/Contents/Resources/mcp/dist/index.js"
    # Linux
    elif [ -f "/opt/Conduit/resources/mcp/dist/index.js" ]; then
        CONDUIT_MCP_ENTRY="/opt/Conduit/resources/mcp/dist/index.js"
    fi
fi

# Windows check (when running in Git Bash / WSL)
if [ -z "$CONDUIT_MCP_ENTRY" ] && [ -n "$LOCALAPPDATA" ]; then
    WIN_PATH="$LOCALAPPDATA/Programs/Conduit/resources/mcp/dist/index.js"
    if [ -f "$WIN_PATH" ]; then
        CONDUIT_MCP_ENTRY="$WIN_PATH"
    fi
fi

if [ -z "$CONDUIT_MCP_ENTRY" ]; then
    echo "Error: conduit-mcp dist/index.js not found"
    echo ""
    echo "Searched locations:"
    echo "  Development: ./mcp/dist/index.js"
    echo "  macOS app:   /Applications/Conduit.app/Contents/Resources/mcp/dist/index.js"
    echo "  Linux app:   /opt/Conduit/resources/mcp/dist/index.js"
    echo ""
    echo "Please either:"
    echo "  1. Build it: cd mcp && npm install && npm run build"
    echo "  2. Install the Conduit app"
    echo "  3. Specify the path: $0 /path/to/mcp"
    exit 1
fi

echo "Installing Conduit MCP server to Claude Code..."
echo "Entry: node $CONDUIT_MCP_ENTRY"
echo ""

# Check if claude CLI is available
if ! command -v claude &> /dev/null; then
    echo "Warning: 'claude' CLI not found in PATH"
    echo ""
    echo "Manual configuration:"
    echo "Add the following to your Claude Code MCP config:"
    echo ""
    echo "  Name: conduit"
    echo "  Command: node $CONDUIT_MCP_ENTRY"
    echo ""
    exit 0
fi

# Add to Claude Code
claude config add mcp conduit --command "node $CONDUIT_MCP_ENTRY"

echo ""
echo "Conduit MCP server added to Claude Code!"
echo ""
echo "Available tools:"
echo "  Terminal:"
echo "    - terminal_execute: Execute commands in a terminal session"
echo "    - terminal_read_pane: Read terminal buffer content"
echo "    - terminal_send_keys: Send keyboard input (supports Ctrl+C, etc.)"
echo "    - local_shell_create: Create a local shell session"
echo ""
echo "  Credentials:"
echo "    - credential_list: List stored credentials (metadata only)"
echo "    - credential_create: Store a new credential"
echo "    - credential_read: Retrieve credential (requires user approval)"
echo "    - credential_delete: Delete a credential"
echo ""
echo "  Connections:"
echo "    - connection_list: List active connections"
echo "    - connection_open: Open SSH/RDP/VNC connection"
echo "    - connection_close: Close a connection"
echo ""
echo "  RDP:"
echo "    - rdp_screenshot, rdp_click, rdp_type, rdp_send_key"
echo "    - rdp_mouse_move, rdp_mouse_drag, rdp_get_dimensions"
echo ""
echo "  VNC:"
echo "    - vnc_screenshot, vnc_click, vnc_type, vnc_send_key"
echo "    - vnc_mouse_move, vnc_get_dimensions"
echo ""
echo "  Web:"
echo "    - website_screenshot, website_read_content, website_navigate"
echo ""
echo "Example usage:"
echo "  claude \"Create a local shell and run 'ls -la'\""
echo "  claude \"List all stored credentials\""
echo "  claude \"Open an SSH connection to myserver.com\""
