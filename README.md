# Conduit

AI-powered remote connection manager with built-in MCP server support.

Manage SSH, RDP, VNC, and web sessions from a single app — with an integrated AI assistant that can interact with your connections in real-time.

## Download

Download the latest version for your platform from the [Releases](https://github.com/advenimus/conduit-desktop/releases/latest) page.

| Platform | File | Notes |
|----------|------|-------|
| **macOS** (Apple Silicon) | `Conduit-x.x.x-arm64.dmg` | Requires macOS 12+ |
| **Windows** (x64) | `Conduit-x.x.x-Setup.exe` | Windows 10+ |
| **Linux** (x64) | `Conduit-x.x.x.AppImage` | Most distros |
| **Linux** (Debian/Ubuntu) | `Conduit-x.x.x_amd64.deb` | `sudo dpkg -i Conduit-*.deb` |

## Installation

### macOS
1. Download the `.dmg` file
2. Open it and drag **Conduit** to Applications
3. On first launch, right-click the app and select **Open** (required for unsigned apps)

### Windows
1. Download the `.exe` installer
2. Run it and follow the setup wizard
3. Conduit will be available from the Start menu

### Linux
**AppImage:**
```bash
chmod +x Conduit-*.AppImage
./Conduit-*.AppImage
```

**Debian/Ubuntu:**
```bash
sudo dpkg -i Conduit-*_amd64.deb
```

## Auto-Update

Conduit includes automatic updates. When a new version is available, you'll be notified within the app and can update with one click.

## License

This project is licensed under the [Elastic License 2.0 (ELv2)](LICENSE).
