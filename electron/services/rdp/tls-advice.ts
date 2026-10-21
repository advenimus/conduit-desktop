// Plain advice for a failed TLS handshake, from OpenSSL's reason text or a port check. Pure so the renderer can import it.

import type { RdpConnectErrorInfo, RdpNetProbe } from './connect-error.js';

export type TlsProblem =
  | 'old-tls'
  | 'renegotiation'
  | 'weak-crypto'
  | 'client-cert'
  | 'handshake-refused'
  | 'not-tls'
  | 'closed';

// Order matters: an alert text can also contain "handshake failure".
const TLS_PROBLEMS: [RegExp, TlsProblem][] = [
  [/unsupported protocol|protocol version|no protocols available|version too low|wrong ssl version/i, 'old-tls'],
  [/legacy renegotiation|renegotiat/i, 'renegotiation'],
  [/md too weak|key too small|too weak|legacy sigalg|no suitable signature|wrong signature type|insufficient security|dh key/i, 'weak-crypto'],
  [/certificate required|peer did not return a certificate|alert bad certificate/i, 'client-cert'],
  [/handshake failure|no shared cipher|no ciphers available/i, 'handshake-refused'],
  [/wrong version number|http request|packet length too long|record layer failure|bad record type/i, 'not-tls'],
  [/unexpected eof|connection reset|eof while reading/i, 'closed'],
];

export function classifyTlsReason(reason: string): TlsProblem | undefined {
  return TLS_PROBLEMS.find(([re]) => re.test(reason))?.[1];
}

function switchPlace(gateway: boolean): string {
  return gateway
    ? 'Turn on "Allow old TLS" in the gateway\'s settings (Gateway > Advanced)'
    : 'Turn on "Allow old TLS" in this entry\'s Security settings';
}

function problemAdvice(problem: TlsProblem, gateway: boolean): string {
  const fix = switchPlace(gateway);
  switch (problem) {
    case 'old-tls':
      return `The server only offers an old TLS version (1.0 or 1.1). ${fix}, or ask the server's admin to turn on TLS 1.2.`;
    case 'renegotiation':
      return `The server is missing a TLS security update (secure renegotiation). ${fix}, or ask the server's admin to update it.`;
    case 'weak-crypto':
      return `The server's certificate or key is too weak for the default security (for example SHA-1 or a short key). ${fix}, or ask the server's admin to replace the certificate.`;
    case 'client-cert':
      return 'The server asked for a client certificate (for example a smart card). Conduit cannot send one yet.';
    case 'handshake-refused':
      return `The server refused the secure handshake. It may need an old TLS version or cipher. ${fix}. If it still fails, ask the server's admin which TLS settings it needs.`;
    case 'not-tls':
      return 'The server did not answer with TLS. Check the port: it may be a web (HTTP) port, or not a Remote Desktop service.';
    case 'closed':
      return `The server closed the connection during the secure handshake. A firewall, a proxy or the server's TLS settings may be the cause. ${fix} to try again.`;
  }
}

function netAdvice(net: RdpNetProbe, gateway: boolean): string | undefined {
  const fix = switchPlace(gateway);
  switch (net) {
    case 'refused':
      return 'Nothing is listening on that port. Check the port number, and that the service is running.';
    case 'timeout':
      return 'There was no answer on that port. Check the address and port. A firewall or VPN may be blocking it.';
    case 'unreachable':
      return 'This computer has no route to the server. Check your network or VPN. On a Mac, also check that Conduit is allowed in System Settings > Privacy & Security > Local Network.';
    case 'dns':
      return 'The server name could not be found. Check the name, and that DNS or your VPN can reach it.';
    case 'reset':
      return 'The server reset the connection. A firewall or proxy may be cutting it.';
    case 'open':
      return `The port is open, but the secure handshake failed without a reason. Old servers do this. ${fix}. If it still fails, ask the server's admin to check its TLS settings.`;
  }
}

/** One or two sentences on what to try, or undefined when the error has no TLS diagnostics. */
export function rdpTlsAdvice(info: RdpConnectErrorInfo, gateway: boolean): string | undefined {
  if (info.certRejected) return undefined;
  const gatewayHop = gateway && info.phase === 'gateway';
  const problem = info.tls ? classifyTlsReason(info.tls) : undefined;
  if (problem) return problemAdvice(problem, gatewayHop);
  if (info.net) return netAdvice(info.net, gatewayHop);
  return undefined;
}
