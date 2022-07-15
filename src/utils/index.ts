import { ripemd160, sha256 } from "@ethersproject/sha2";
import { hexDataSlice } from "@ethersproject/bytes";

import aesjs from "aes-js"

export function computeFingerprint(publicKey: string): string {
  return hexDataSlice(ripemd160(sha256(aesjs.utils.hex.toBytes(publicKey))), 0, 4)
}
