# Linux installer

`install.sh` is a convenience wrapper around the Linux artifacts published on the [GitHub releases page](https://github.com/yzhelezko/FerrisScope/releases). It picks the best format for the host and installs it.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/yzhelezko/FerrisScope/main/packaging/linux/install.sh | bash
```

What it does:

| Distro family               | Detected via   | Installs                                              |
|-----------------------------|----------------|-------------------------------------------------------|
| Debian / Ubuntu / Mint /…   | `apt-get`      | `.deb` via `sudo apt-get install ./ferrisscope.deb`   |
| Fedora / RHEL / Rocky /…    | `dnf`          | `.rpm` via `sudo dnf install ./ferrisscope.rpm`       |
| openSUSE                    | `zypper`       | `.rpm` via `sudo zypper install`                      |
| Anything else (Arch, NixOS,…)| —             | `.AppImage` into `~/.local/share/FerrisScope/`        |

For the AppImage path the installer also drops:

- a launcher symlink at `~/.local/bin/ferrisscope`
- a `~/.local/share/applications/FerrisScope.desktop` entry so the app appears in your menu
- the icon at `~/.local/share/icons/hicolor/256x256/apps/FerrisScope.png` (extracted from the AppImage)

The installer never runs as root; it shells out to `sudo` only for the apt / dnf / zypper invocation.

## Pin a specific version

```bash
curl -fsSL https://.../install.sh | FERRISSCOPE_VERSION=v0.1.0 bash
```

## Force a format

```bash
# Force AppImage even on apt/dnf systems
curl -fsSL https://.../install.sh | bash -s -- --appimage

# Force .deb / .rpm
curl -fsSL https://.../install.sh | bash -s -- --deb
curl -fsSL https://.../install.sh | bash -s -- --rpm
```

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/yzhelezko/FerrisScope/main/packaging/linux/install.sh | bash -s -- --uninstall
```

Per-user state is **preserved** so a reinstall keeps your kubeconfig sources, prefs, pinned port-forwards, table views, and fleet cache. To wipe it manually:

```bash
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/ferrisscope"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/ferrisscope"
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/ferrisscope"
```

## Why no systemd unit / udev rules?

FerrisScope is a desktop GUI, not a background daemon. It runs in your normal user session, talks to your `~/.kube/config`, and exits when you close the window. There's nothing to enable on boot.
