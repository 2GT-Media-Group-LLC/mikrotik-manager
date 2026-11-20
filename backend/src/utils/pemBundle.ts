import * as crypto from 'crypto';

/**
 * An uploaded HTTPS certificate is a leaf, optionally followed by its chain,
 * and the whole field is written into nginx's certificate file. Only the first
 * block used to be parsed (GHSA-28hr-v457-cc6g), so anything after it went in
 * unchecked: a malformed block, a stray private key, or text that stops nginx
 * reloading. Now every block must be a certificate that parses, nothing else
 * may be in the field, and what is written is rebuilt from the parsed blocks.
 */
export interface PemBlock { label: string; pem: string }

const OUTSIDE = 'There is text outside the PEM blocks';

/**
 * Every PEM block, or an error naming what else was found. Read with indexOf
 * rather than one regex with a back-reference, which backtracked: quadratic on
 * a field of BEGIN lines with no END (CodeQL js/polynomial-redos).
 */
export function pemBlocks(text: string): PemBlock[] {
  const blocks: PemBlock[] = [];
  let pos = 0;
  for (;;) {
    const begin = text.indexOf('-----BEGIN ', pos);
    if (begin < 0) { if (text.slice(pos).trim() !== '') throw new Error(OUTSIDE); break; }
    if (text.slice(pos, begin).trim() !== '') throw new Error(OUTSIDE);
    const labelEnd = text.indexOf('-----', begin + 11);
    const label = labelEnd < 0 ? '' : text.slice(begin + 11, labelEnd);
    const afterHeader = labelEnd + 5;
    const newline = text.startsWith('\r\n', afterHeader) ? 2 : text.startsWith('\n', afterHeader) ? 1 : 0;
    if (!/^[A-Z0-9 ]+$/.test(label) || !newline) throw new Error(OUTSIDE);
    const endMarker = `-----END ${label}-----`;
    const end = text.indexOf(endMarker, afterHeader + newline);
    if (end < 0) throw new Error(OUTSIDE);
    pos = end + endMarker.length;
    blocks.push({ label, pem: text.slice(begin, pos).replace(/\r\n/g, '\n') });
  }
  return blocks;
}

/** The certificate field: leaf first, then any chain, all real certificates. */
export function parseCertificateBundle(text: string): { pem: string; certs: crypto.X509Certificate[] } {
  const blocks = pemBlocks(text);
  if (blocks.length === 0) throw new Error('No certificate found');
  const certs = blocks.map((b, i) => {
    if (b.label !== 'CERTIFICATE') throw new Error(`Block ${i + 1} is a ${b.label.toLowerCase()}, not a certificate`);
    try {
      return new crypto.X509Certificate(b.pem);
    } catch {
      throw new Error(`Block ${i + 1} isn't a valid certificate`);
    }
  });
  return { pem: blocks.map((b) => b.pem).join('\n') + '\n', certs };
}

/** The private key field: exactly one private key and nothing else. */
export function parsePrivateKey(text: string): { pem: string; key: crypto.KeyObject } {
  const blocks = pemBlocks(text);
  if (blocks.length !== 1) throw new Error(blocks.length === 0 ? 'No private key found' : 'Paste only the private key, one block');
  if (!/PRIVATE KEY$/.test(blocks[0].label)) throw new Error(`That is a ${blocks[0].label.toLowerCase()}, not a private key`);
  try {
    return { pem: blocks[0].pem + '\n', key: crypto.createPrivateKey(blocks[0].pem) };
  } catch {
    throw new Error("The private key couldn't be read (an encrypted key needs its passphrase removed first)");
  }
}
