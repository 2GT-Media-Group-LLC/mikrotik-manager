import nacl from 'tweetnacl';

export interface WgKeyPair {
  privateKey: string;
  publicKey: string;
}

/** A fresh WireGuard key pair, generated in the browser and never sent anywhere
 * but into the peer this call is for — nacl.box uses the same Curve25519 as
 * WireGuard, so the raw key bytes are valid WireGuard keys as-is. */
export function generateWgKeyPair(): WgKeyPair {
  const { publicKey, secretKey } = nacl.box.keyPair();
  return { privateKey: toBase64(secretKey), publicKey: toBase64(publicKey) };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
