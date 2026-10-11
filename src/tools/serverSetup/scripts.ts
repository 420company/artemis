/**
 * tools/serverSetup/scripts.ts — the shell scripts server_setup runs on a
 * server over SSH (`bash -s`, as root or through `sudo -n`). Each prints
 * `ARTEMIS_STEP <step> ok` when it finished; anything secret it receives
 * (a WireGuard private key) is written to a 0600 file and never printed.
 *
 * Debian/Ubuntu (apt) first, with dnf/yum fallbacks for RHEL-like systems.
 */

const PRELUDE = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
pm() {
  if command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v yum >/dev/null 2>&1; then echo yum
  else echo none; fi
}
install_pkgs() {
  case "$(pm)" in
    apt) apt-get update -y -qq >/dev/null && apt-get install -y -qq "$@" >/dev/null ;;
    dnf) dnf install -y -q "$@" >/dev/null ;;
    yum) yum install -y -q "$@" >/dev/null ;;
    *) echo "no supported package manager" >&2; return 1 ;;
  esac
}
`;

/** Shell-quotes one value for a script line. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function probeScript(): string {
  return `set -e
. /etc/os-release 2>/dev/null || true
echo "os=\${PRETTY_NAME:-$(uname -s)}"
echo "kernel=$(uname -r)"
echo "arch=$(uname -m)"
echo "virt=$(systemd-detect-virt 2>/dev/null || echo unknown)"
echo "ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
echo "ARTEMIS_STEP probe ok"
`;
}

/** Updates, a firewall that keeps SSH open, automatic security updates, key-only SSH. */
export function hardenScript(options: { sshPort: number; extraPorts?: string[] }): string {
  const allow = [`${options.sshPort}/tcp`, ...(options.extraPorts ?? [])];
  return `${PRELUDE}
case "$(pm)" in
  apt)
    apt-get update -y -qq >/dev/null
    apt-get -y -qq -o Dpkg::Options::=--force-confold upgrade >/dev/null
    apt-get install -y -qq ufw unattended-upgrades fail2ban >/dev/null
    echo 'APT::Periodic::Update-Package-Lists "1";' > /etc/apt/apt.conf.d/20auto-upgrades
    echo 'APT::Periodic::Unattended-Upgrade "1";' >> /etc/apt/apt.conf.d/20auto-upgrades
    ;;
  dnf|yum)
    "$(pm)" -y -q upgrade >/dev/null || true
    install_pkgs firewalld fail2ban dnf-automatic >/dev/null 2>&1 || true
    ;;
esac
echo "updates=done"
if command -v ufw >/dev/null 2>&1; then
${allow.map((p) => `  ufw allow ${shq(p)} >/dev/null`).join('\n')}
  ufw default deny incoming >/dev/null
  ufw --force enable >/dev/null
  echo "firewall=ufw"
elif command -v firewall-cmd >/dev/null 2>&1; then
  systemctl enable --now firewalld >/dev/null 2>&1 || true
${allow.map((p) => `  firewall-cmd --permanent --add-port=${shq(p)} >/dev/null`).join('\n')}
  firewall-cmd --reload >/dev/null
  echo "firewall=firewalld"
fi
systemctl enable --now fail2ban >/dev/null 2>&1 || true
# Key-only SSH, but only when a key is installed (never lock the owner out).
if [ -s "$HOME/.ssh/authorized_keys" ] || [ -s /root/.ssh/authorized_keys ]; then
  mkdir -p /etc/ssh/sshd_config.d
  printf 'PasswordAuthentication no\\nKbdInteractiveAuthentication no\\nPermitRootLogin prohibit-password\\n' > /etc/ssh/sshd_config.d/60-agent-hardening.conf
  if ! grep -qi '^Include /etc/ssh/sshd_config.d' /etc/ssh/sshd_config; then sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config; fi
  sshd -t && (systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true)
  echo "ssh=key-only"
fi
echo "ARTEMIS_STEP harden ok"
`;
}

export interface WireGuardServerSpec {
  /** The server's interface private key (written to a 0600 file, never printed). */
  privateKey: string;
  listenPort: number;
  /** e.g. 10.66.66.1/24 */
  address: string;
  peers: Array<{ publicKey: string; address: string }>;
}

/** Installs WireGuard, writes wg0.conf, enables forwarding and NAT, opens the port, starts it. */
export function wireguardScript(spec: WireGuardServerSpec): string {
  const peers = spec.peers.map((p) => `\n[Peer]\nPublicKey = ${p.publicKey}\nAllowedIPs = ${p.address}`).join('\n');
  return `${PRELUDE}
command -v wg >/dev/null 2>&1 || install_pkgs wireguard-tools iptables || install_pkgs wireguard iptables
command -v wg-quick >/dev/null 2>&1 || install_pkgs wireguard
WAN=$(ip -4 route show default | awk '{print $5; exit}')
[ -n "$WAN" ] || { echo "no default route" >&2; exit 1; }
printf 'net.ipv4.ip_forward=1\\nnet.ipv6.conf.all.forwarding=1\\n' > /etc/sysctl.d/99-agent-wireguard.conf
sysctl -q -p /etc/sysctl.d/99-agent-wireguard.conf >/dev/null || true
umask 077
mkdir -p /etc/wireguard
KEY=$(cat <<'KEY_EOF'
${spec.privateKey}
KEY_EOF
)
cat > /etc/wireguard/wg0.conf <<CONF_EOF
[Interface]
Address = ${spec.address}
ListenPort = ${spec.listenPort}
PrivateKey = $KEY
PostUp = iptables -t nat -A POSTROUTING -o $WAN -j MASQUERADE; iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o $WAN -j MASQUERADE; iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -j ACCEPT
${peers}
CONF_EOF
unset KEY
chmod 600 /etc/wireguard/wg0.conf
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then
  ufw allow ${spec.listenPort}/udp >/dev/null
  ufw route allow in on wg0 out on "$WAN" >/dev/null 2>&1 || true
  sed -i 's/^DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw 2>/dev/null || true
  ufw reload >/dev/null || true
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=${spec.listenPort}/udp >/dev/null && firewall-cmd --permanent --add-masquerade >/dev/null && firewall-cmd --reload >/dev/null
fi
systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
systemctl restart wg-quick@wg0
wg show wg0 listening-port >/dev/null
echo "listening=$(wg show wg0 listening-port)"
echo "ARTEMIS_STEP wireguard ok"
`;
}

/** Checks the VPN on the server; adds a temporary peer for a tunnel test when one is given. */
export function wireguardCheckScript(options: { listenPort: number; testPeer?: { publicKey: string; address: string } }): string {
  const add = options.testPeer ? `wg set wg0 peer ${shq(options.testPeer.publicKey)} allowed-ips ${shq(options.testPeer.address)}\necho "test_peer=added"` : '';
  return `set -euo pipefail
systemctl is-active --quiet wg-quick@wg0 && echo "service=active" || { echo "service=inactive"; exit 1; }
port=$(wg show wg0 listening-port)
[ "$port" = "${options.listenPort}" ] && echo "listening=$port" || { echo "listening=$port (expected ${options.listenPort})"; exit 1; }
echo "peers=$(wg show wg0 peers | wc -l)"
echo "forwarding=$(sysctl -n net.ipv4.ip_forward)"
${add}
echo "ARTEMIS_STEP check ok"
`;
}

export function removePeerScript(publicKey: string): string {
  return `wg set wg0 peer ${shq(publicKey)} remove && echo "ARTEMIS_STEP cleanup ok"\n`;
}

/** Appends a public key to root's (or the user's) authorized_keys, once. */
export function installKeyScript(publicKey: string): string {
  return `set -e
umask 077
mkdir -p "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
grep -qxF ${shq(publicKey)} "$HOME/.ssh/authorized_keys" || echo ${shq(publicKey)} >> "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
echo "ARTEMIS_STEP install_key ok"
`;
}
