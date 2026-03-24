# Murderbot Host Configuration

Systemd unit and NetworkManager configs for the Murderbot bare metal host (CachyOS).

## Network: QEMU Bridge

The k3s VM gets a bridged network interface so it appears as a real host on the LAN. NetworkManager manages all three pieces:

- `br0` — bridge, gets IP via DHCP
- `bridge-slave-enp11s0` — physical NIC enslaved to br0
- `tap0` — TAP device for QEMU, enslaved to br0, owned by uid 1000 (mrw)

These configs live in `/etc/NetworkManager/system-connections/` on Murderbot. NM creates the interfaces on boot — no scripts needed.

## QEMU VM

`murderbot-k8s.service` runs the k3s guest VM. Starts after network is online, restarts on failure.

### Install

```bash
# Network (if recreating from scratch)
sudo cp networkmanager/*.nmconnection /etc/NetworkManager/system-connections/
sudo chmod 600 /etc/NetworkManager/system-connections/*.nmconnection
sudo nmcli connection reload

# QEMU service
sudo cp murderbot-k8s.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now murderbot-k8s
```
