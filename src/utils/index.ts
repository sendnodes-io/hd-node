import { ripemd160, sha256 } from "@ethersproject/sha2";
import { hexDataSlice } from "@ethersproject/bytes";

import aesjs from "aes-js"

export function computeFingerprint(publicKey: string): string {
  return hexDataSlice(ripemd160(sha256(aesjs.utils.hex.toBytes(publicKey))), 0, 4)
}

/**
 * Converts a public key to an address synchronously
 * Adapted from the official async implementation found here:
 * https://github.com/pokt-foundation/pocket-js/blob/v2.1.1/packages/utils/src/addr-from-pubkey.ts#L24
 */
export function addressFromPublickey(publicKey: Uint8Array): string {
  return sha256(publicKey).slice(2, 42);
}
