/**
 * Validation of the PlantUML server URL.
 *
 * Lives in `shared/` — free of the `vscode` module — so the rule that decides
 * whether diagram text may leave the machine can be unit-tested directly rather
 * than only through the editor.
 */

/** Outcome of validating a configured server URL. */
export type ServerUrlCheck = { readonly url: URL } | { readonly error: string };

/**
 * Decides whether a server URL is acceptable.
 *
 * Rendering through a server means sending the diagram's *content* to it. For a
 * corporate architecture diagram that is a real disclosure, so anything that is
 * not plainly on this machine requires an explicit opt-in.
 */
export function validateServerUrl(rawUrl: string, allowRemote: boolean): ServerUrlCheck {
  if (rawUrl.length === 0) {
    return { error: 'No server URL is configured. Set plantuml.render.serverUrl.' };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: `"${rawUrl}" is not a valid URL.` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `Unsupported protocol "${url.protocol}"; use http or https.` };
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return {
      error: 'Remove the credentials from plantuml.render.serverUrl; they would be sent in clear.',
    };
  }

  if (!allowRemote && !isLoopbackHost(url.hostname)) {
    return {
      error:
        `Refusing to send diagram text to "${url.host}" because it is not on this machine. ` +
        'Point plantuml.render.serverUrl at a local server, or enable ' +
        'plantuml.render.allowRemoteServer if you intend to use a remote one.',
    };
  }

  return { url };
}

/**
 * True for hosts that cannot leave the machine.
 *
 * Covers the whole `127.0.0.0/8` block rather than just `127.0.0.1`, and both
 * spellings of the IPv6 loopback, with or without brackets.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (ipv4 === null) {
    return false;
  }
  const octets = ipv4.slice(1).map((part) => Number.parseInt(part, 10));
  return octets.every((part) => part >= 0 && part <= 255) && octets[0] === 127;
}
