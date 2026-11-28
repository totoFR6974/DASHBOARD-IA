// Adresses IPv4 de cet ordinateur sur les réseaux locaux (accès à distance, recherche des hubs). Sans Electron.
import { networkInterfaces } from 'node:os';

/** Cartes réseau virtuelles (machines virtuelles, WSL, Docker…) : un téléphone n'y est jamais. */
const VIRTUAL_IFACE = /vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|loopback|npcap|utun|bridge\d|vmnet/i;

/**
 * Adresses IPv4 de ce PC sur un réseau local, les plus probables d'abord : vraies cartes avant les cartes virtuelles,
 * puis 192.168, 10, 172.16-31, et le reste (ex. 100.x d'un VPN maillé).
 */
export function localAddresses(ifaces = networkInterfaces()): string[] {
  const out: { ip: string; virtual: boolean }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ ip: a.address, virtual: VIRTUAL_IFACE.test(name) });
    }
  }
  const rank = (x: { ip: string; virtual: boolean }) =>
    (x.virtual ? 10 : 0) + (x.ip.startsWith('192.168.') ? 0 : x.ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(x.ip) ? 2 : 3);
  return [...new Set(out.sort((a, b) => rank(a) - rank(b)).map((x) => x.ip))];
}

/**
 * Adresse du réseau local, d'un VPN maillé ou de ce PC : 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x,
 * 100.64-127.x (Tailscale & co), ::1, fc00::/7, fe80::/10 (formes IPv4 « ::ffff:a.b.c.d » comprises).
 */
export function isPrivateAddress(raw: string): boolean {
  const ip = String(raw ?? '').replace(/^::ffff:/i, '');
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}
