"use strict";

// See: https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
// See: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki


import { ExternallyOwnedAccount } from "@ethersproject/abstract-signer";
import { Base58 } from "@ethersproject/basex";
import { arrayify, BytesLike, concat, hexDataSlice, hexZeroPad, hexlify } from "@ethersproject/bytes";
import { toUtf8Bytes, UnicodeNormalizationForm } from "@ethersproject/strings";
import { pbkdf2 } from "@ethersproject/pbkdf2";
import { defineReadOnly } from "@ethersproject/properties";
import { sha256 } from "@ethersproject/sha2";
import { Wordlist, wordlists } from "@ethersproject/wordlists";
import { addressFromPublickey } from "@pokt-network/pocket-js/dist/index"
import { getMasterKeyFromSeed, getPublicKey, derivePath } from "ed25519-hd-key"
import aesjs from "aes-js"
import nacl from "tweetnacl"

import { Logger } from "@ethersproject/logger";
import { version } from "./_version";

import { computeFingerprint } from './utils'

const logger = new Logger(version);

// const N = BigNumber.from("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

// "Bitcoin seed"
// const MasterSecret = toUtf8Bytes("Bitcoin seed");

const HardenedBit = 0x80000000;

// Returns a byte with the MSB bits set
function getUpperMask(bits: number): number {
    return ((1 << bits) - 1) << (8 - bits);
}

// Returns a byte with the LSB bits set
function getLowerMask(bits: number): number {
    return (1 << bits) - 1;
}

// function bytes32(value: BigNumber | Uint8Array): string {
//     return hexZeroPad(hexlify(value), 32);
// }

function base58check(data: Uint8Array): string {
    return Base58.encode(concat([data, hexDataSlice(sha256(sha256(data)), 0, 4)]));
}

function getWordlist(wordlist: string | Wordlist): Wordlist {
    if (wordlist == null) {
        return wordlists["en"];
    }

    if (typeof (wordlist) === "string") {
        const words = wordlists[wordlist];
        if (words == null) {
            logger.throwArgumentError("unknown locale", "wordlist", wordlist);
        }
        return words;
    }

    return wordlist;
}

const _constructorGuard: any = {};

/** Default path for POKT @see https://github.com/satoshilabs/slips/blob/master/slip-0044.md */
export const defaultPath = "m/44'/635'/0'/0";

export interface Mnemonic {
    readonly phrase: string;
    readonly path: string;
    readonly locale: string;
};

export class HDNode implements ExternallyOwnedAccount {
    readonly privateKey: string;
    readonly publicKey: string;

    readonly fingerprint: string;
    readonly parentFingerprint: string;

    readonly address: string;

    readonly mnemonic?: Mnemonic;
    readonly path: string;

    readonly chainCode: string;

    readonly index: number;
    readonly depth: number;

    /**
     *  This constructor should not be called directly.
     *
     *  Please use:
     *   - fromMnemonic
     *   - fromSeed
     */
    constructor(constructorGuard: any, privateKey: string, publicKey: string, parentFingerprint: string, chainCode: string, index: number, depth: number, mnemonicOrPath: Mnemonic | string) {
        logger.checkNew(new.target, HDNode);

        /* istanbul ignore if */
        if (constructorGuard !== _constructorGuard) {
            throw new Error("HDNode constructor cannot be called directly");
        }

        if (privateKey) {
            // const privBytes = aesjs.utils.hex.toBytes(privateKey)
            const privBytes = new Uint8Array(aesjs.utils.hex.toBytes(privateKey))
            const publicKey = nacl.sign.keyPair.fromSecretKey(privBytes).publicKey
            defineReadOnly(this, "privateKey", privateKey);
            defineReadOnly(this, "publicKey", aesjs.utils.hex.fromBytes(publicKey));
        } else {
            defineReadOnly(this, "privateKey", null);
            defineReadOnly(this, "publicKey", publicKey);
        }

        defineReadOnly(this, "parentFingerprint", parentFingerprint);
        defineReadOnly(this, "fingerprint", computeFingerprint(this.publicKey));
        const addr = addressFromPublickey(Buffer.from(this.publicKey, "hex"))
        defineReadOnly(this, "address", addr.toString("hex"));
        defineReadOnly(this, "chainCode", chainCode);

        defineReadOnly(this, "index", index);
        defineReadOnly(this, "depth", depth);

        if (mnemonicOrPath == null) {
            // From a source that does not preserve the path (e.g. extended keys)
            defineReadOnly(this, "mnemonic", null);
            defineReadOnly(this, "path", null);

        } else if (typeof (mnemonicOrPath) === "string") {
            // From a source that does not preserve the mnemonic (e.g. neutered)
            defineReadOnly(this, "mnemonic", null);
            defineReadOnly(this, "path", mnemonicOrPath);

        } else {
            // From a fully qualified source
            defineReadOnly(this, "mnemonic", mnemonicOrPath);
            defineReadOnly(this, "path", mnemonicOrPath.path);
        }
    }

    get extendedKey(): string {
        // We only support the mainnet values for now, but if anyone needs
        // testnet values, let me know. I believe current sentiment is that
        // we should always use mainnet, and use BIP-44 to derive the network
        //   - Mainnet: public=0x0488B21E, private=0x0488ADE4
        //   - Testnet: public=0x043587CF, private=0x04358394

        if (this.depth >= 256) { throw new Error("Depth too large!"); }

        return base58check(concat([
            ((this.privateKey != null) ? "0x0488ADE4" : "0x0488B21E"),
            hexlify(this.depth),
            this.parentFingerprint,
            hexZeroPad(hexlify(this.index), 4),
            this.chainCode,
            ((this.privateKey != null) ? concat(["0x00", this.privateKey]) : this.publicKey),
        ]));
    }

    neuter(): HDNode {
        return new HDNode(_constructorGuard, null, this.publicKey, this.parentFingerprint, this.chainCode, this.index, this.depth, this.path);
    }

    derivePath(path: string): HDNode {
        if (!this.privateKey) { throw new Error("cannot derive child of neutered node"); }
        let isIndex = false;
        try {
            const pIndex = Number(path)
            isIndex = pIndex > -1
        } catch (e) {
            isIndex = false
        }
        path += "'";
        if (isIndex && this.path) {
            path = this.path + "/" + path
        }
        // console.log('path', path)
        const pSplit = path.split("/")
        const index = Number(pSplit[pSplit.length - 1].replace("'", ""))
        const I = aesjs.utils.hex.toBytes(this.privateKey)
        const seed = I.slice(0, 32)
        let key: Buffer, chainCode: Buffer
        try {
            const { key: k, chainCode: c } = derivePath(path, aesjs.utils.hex.fromBytes(seed), HardenedBit);
            key = k;
            chainCode = c;
        } catch (e) {
            console.log('error', e, path)
        }

        const pubKey = getPublicKey(key, false);
        const ki = Buffer.concat([key, pubKey]);

        let mnemonicOrPath: Mnemonic | string = path;
        const srcMnemonic = this.mnemonic;
        if (srcMnemonic) {
            mnemonicOrPath = Object.freeze({
                phrase: srcMnemonic.phrase,
                path: path,
                locale: (srcMnemonic.locale || "en")
            });
        }

        const _newHDNode = new HDNode(_constructorGuard, aesjs.utils.hex.fromBytes(ki), null, this.fingerprint, aesjs.utils.hex.fromBytes(chainCode), index, this.depth + 1, mnemonicOrPath);
        // console.log("_newHDNode", _newHDNode)
        return _newHDNode

    }

    static _fromSeed(seed: BytesLike, mnemonic: Mnemonic): HDNode {
        const seedArray: Uint8Array = arrayify(seed);
        if (seedArray.length < 16 || seedArray.length > 64) { throw new Error("invalid seed"); }

        // use aesjs hex since it doesn't prefix with 0x
        const hex = aesjs.utils.hex.fromBytes(seedArray)
        if (seedArray.length !== hex.length / 2) { throw new Error('Invalid hex length') }

        // const I: Uint8Array = arrayify(computeHmac(SupportedAlgorithm.sha512, MasterSecret, seedArray));
        // const keyPair = nacl.sign.keyPair.fromSeed(I.slice(0, 32))

        // expects the raw hex (without the 0x prefix)
        const mKey = getMasterKeyFromSeed(hex)
        const pubKey = getPublicKey(mKey.key, false)
        const privKey = Buffer.concat([mKey.key, pubKey])

        // console.log("bKey", aesjs.utils.hex.fromBytes(mKey.key), aesjs.utils.hex.fromBytes(pubKey))
        // console.log("privKey", aesjs.utils.hex.fromBytes(privKey))
        return new HDNode(_constructorGuard, aesjs.utils.hex.fromBytes(privKey), null, "0x00000000", aesjs.utils.hex.fromBytes(mKey.chainCode), 0, 0, mnemonic);
    }

    static fromMnemonic(mnemonic: string, password?: string, wordlist?: string | Wordlist): HDNode {

        // If a locale name was passed in, find the associated wordlist
        wordlist = getWordlist(wordlist);

        // Normalize the case and spacing in the mnemonic (throws if the mnemonic is invalid)
        mnemonic = entropyToMnemonic(mnemonicToEntropy(mnemonic, wordlist), wordlist);

        return HDNode._fromSeed(mnemonicToSeed(mnemonic, password), {
            phrase: mnemonic,
            path: "m",
            locale: wordlist.locale
        });
    }

    static fromSeed(seed: BytesLike): HDNode {
        return HDNode._fromSeed(seed, null);
    }

    static fromExtendedKey(extendedKey: string): HDNode {
        const bytes = Base58.decode(extendedKey);

        if (bytes.length !== 82 || base58check(bytes.slice(0, 78)) !== extendedKey) {
            logger.throwArgumentError("invalid extended key", "extendedKey", "[REDACTED]");
        }

        const depth = bytes[4];
        const parentFingerprint = hexlify(bytes.slice(5, 9));
        const index = parseInt(hexlify(bytes.slice(9, 13)).substring(2), 16);
        const chainCode = hexlify(bytes.slice(13, 45));
        const key = bytes.slice(45, 78); // 110 ?

        switch (hexlify(bytes.slice(0, 4))) {
            // Public Key
            case "0x0488b21e": case "0x043587cf":
                return new HDNode(_constructorGuard, null, hexlify(key), parentFingerprint, chainCode, index, depth, null);

            // Private Key
            case "0x0488ade4": case "0x04358394 ":
                if (key[0] !== 0) { break; }
                return new HDNode(_constructorGuard, hexlify(key.slice(1)), null, parentFingerprint, chainCode, index, depth, null);
        }

        return logger.throwArgumentError("invalid extended key", "extendedKey", "[REDACTED]");
    }
}

export function mnemonicToSeed(mnemonic: string, password?: string): string {
    if (!password) { password = ""; }

    const salt = toUtf8Bytes("mnemonic" + password, UnicodeNormalizationForm.NFKD);

    return pbkdf2(toUtf8Bytes(mnemonic, UnicodeNormalizationForm.NFKD), salt, 2048, 64, "sha512");
}

export function mnemonicToEntropy(mnemonic: string, wordlist?: string | Wordlist): string {
    wordlist = getWordlist(wordlist);

    logger.checkNormalize();

    const words = wordlist.split(mnemonic);
    if ((words.length % 3) !== 0) { throw new Error("invalid mnemonic"); }

    const entropy = arrayify(new Uint8Array(Math.ceil(11 * words.length / 8)));

    let offset = 0;
    for (let i = 0; i < words.length; i++) {
        let index = wordlist.getWordIndex(words[i].normalize("NFKD"));
        if (index === -1) { throw new Error("invalid mnemonic"); }

        for (let bit = 0; bit < 11; bit++) {
            if (index & (1 << (10 - bit))) {
                entropy[offset >> 3] |= (1 << (7 - (offset % 8)));
            }
            offset++;
        }
    }

    const entropyBits = 32 * words.length / 3;

    const checksumBits = words.length / 3;
    const checksumMask = getUpperMask(checksumBits);

    const checksum = arrayify(sha256(entropy.slice(0, entropyBits / 8)))[0] & checksumMask;

    if (checksum !== (entropy[entropy.length - 1] & checksumMask)) {
        throw new Error("invalid checksum");
    }

    return hexlify(entropy.slice(0, entropyBits / 8));
}

export function entropyToMnemonic(entropy: BytesLike, wordlist?: string | Wordlist): string {
    wordlist = getWordlist(wordlist);

    entropy = arrayify(entropy);

    if ((entropy.length % 4) !== 0 || entropy.length < 16 || entropy.length > 32) {
        throw new Error("invalid entropy");
    }

    const indices: Array<number> = [0];

    let remainingBits = 11;
    for (let i = 0; i < entropy.length; i++) {

        // Consume the whole byte (with still more to go)
        if (remainingBits > 8) {
            indices[indices.length - 1] <<= 8;
            indices[indices.length - 1] |= entropy[i];

            remainingBits -= 8;

            // This byte will complete an 11-bit index
        } else {
            indices[indices.length - 1] <<= remainingBits;
            indices[indices.length - 1] |= entropy[i] >> (8 - remainingBits);

            // Start the next word
            indices.push(entropy[i] & getLowerMask(8 - remainingBits));

            remainingBits += 3;
        }
    }

    // Compute the checksum bits
    const checksumBits = entropy.length / 4;
    const checksum = arrayify(sha256(entropy))[0] & getUpperMask(checksumBits);

    // Shift the checksum into the word indices
    indices[indices.length - 1] <<= checksumBits;
    indices[indices.length - 1] |= (checksum >> (8 - checksumBits));

    return wordlist.join(indices.map((index) => (<Wordlist>wordlist).getWord(index)));
}

export function isValidMnemonic(mnemonic: string, wordlist?: Wordlist): boolean {
    try {
        mnemonicToEntropy(mnemonic, wordlist);
        return true;
    } catch (error) { }
    return false;
}

export function getAccountPath(index: number): string {
    if (typeof (index) !== "number" || index < 0 || index >= HardenedBit || index % 1) {
        logger.throwArgumentError("invalid account index", "index", index);
    }
    return `m/44'/635'/${index}'/0/0`;
}

export * from './utils'