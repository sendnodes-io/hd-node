import { ripemd160, sha256 } from "@ethersproject/sha2";
import { hexDataSlice } from "@ethersproject/bytes";

import aesjs from "aes-js"

export function computeFingerprint(publicKey: string): string {
  return hexDataSlice(ripemd160(sha256(aesjs.utils.hex.toBytes(publicKey))), 0, 4)
}

/**
 * @description Calculates the address from a given public key
 * @param {Buffer} publicKey - Public key from which we're going to calculate the address for
 * @returns {Buffer} - Address buffer.
 */
export function addressFromPublickey(publicKey: string): string {
  return hexDataSlice(sha256(aesjs.utils.hex.toBytes(publicKey)), 0, 20);
}
