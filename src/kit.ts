import { Client as PasskeyClient } from 'passkey-kit-sdk'
import { Client as FactoryClient, networks } from 'passkey-factory-sdk'
import { Address, Networks, StrKey, hash, xdr, Transaction, SorobanRpc, Operation, scValToNative, TransactionBuilder } from '@stellar/stellar-sdk'
import { bufToBigint, bigintToBuf } from 'bigint-conversion'
import base64url from 'base64url'
import { startRegistration, startAuthentication } from "@simplewebauthn/browser"
import { decode } from 'cbor-x/decode'
import { Buffer } from 'buffer'
import { PasskeyBase } from './base'

/* TODO 
    - Clean up these params and the interface as a whole
        Might put wallet activities and maybe factory as well into the root of the class vs buried inside this.wallet and this.factory
        @Later

    - Right now publicKey can mean a Stellar public key or a passkey public key, there should be a noted difference
*/

export class PasskeyKit extends PasskeyBase {
    public keyId: string | undefined
    public sudoKeyId: string | undefined
    public wallet: PasskeyClient | undefined
    public factory: FactoryClient
    public networkPassphrase: Networks
    public rpcUrl: string
    public rpc: SorobanRpc.Server
    public factoryContractId: string = networks.testnet.contractId

    /* TODO 
        - Consider adding the ability to pass in a keyId and maybe even a contractId in order to preconnect to a wallet
            If just a keyId call `connectWallet` in order to get the contractId
            If both keyId and contractId are passed in then we can skip the connectWallet call (though we won't get the sudoKeyId in that case)
            We don't strictly _need_ this as a dev can just call `connectWallet` after class instantiation but it might be a nice convenience
            @Later
    */

    constructor(options: {
        networkPassphrase: Networks,
        rpcUrl: string,
        launchtubeUrl?: string,
        launchtubeJwt?: string,
        /* TODO 
            - Maybe remove this? The factory should likely be baked in a bit more tightly
                On the other hand once we have a standard interface the factory interface only uses the `deploy` method right now inside the interface
                @No
        */
        factoryContractId?: string,
    }) {
        const {
            networkPassphrase,
            rpcUrl,
            launchtubeUrl,
            launchtubeJwt,
            factoryContractId
        } = options

        super({
            launchtubeUrl,
            launchtubeJwt,
        })

        this.networkPassphrase = networkPassphrase
        this.rpcUrl = rpcUrl
        this.rpc = new SorobanRpc.Server(rpcUrl)

        if (factoryContractId)
            this.factoryContractId = factoryContractId

        this.factory = new FactoryClient({
            contractId: this.factoryContractId,
            networkPassphrase,
            rpcUrl
        })
    }

    public async createWallet(name: string, user: string) {
        const { keyId, publicKey } = await this.createKey(name, user)

        const { result, built } = await this.factory.deploy({
            id: keyId,
            pk: publicKey!
        })

        const contractId = result.unwrap() as string

        this.wallet = new PasskeyClient({
            contractId,
            networkPassphrase: this.networkPassphrase,
            rpcUrl: this.rpcUrl
        })

        return {
            keyId,
            contractId,
            xdr: built!.toXDR() as string
        }
    }

    public async createKey(name: string, user: string) {
        const startRegistrationResponse = await startRegistration({
            challenge: base64url("stellaristhebetterblockchain"),
            rp: {
                // id: undefined,
                name,
            },
            user: {
                id: base64url(user),
                name: user,
                displayName: user,
            },
            authenticatorSelection: {
                requireResidentKey: false,
                residentKey: "preferred",
                userVerification: "discouraged",
            },
            pubKeyCredParams: [{ alg: -7, type: "public-key" }],
            attestation: "none",
        });

        if (!this.keyId) {
            this.keyId = startRegistrationResponse.id

            // If there was no keyId we're likely about to deploy a new wallet so we should set the sudoKeyId 
            if (!this.sudoKeyId)
                this.sudoKeyId = startRegistrationResponse.id
        }

        const { publicKeyObject } = this.getPublicKeyObject(startRegistrationResponse.response.attestationObject);

        const publicKey = Buffer.from([
            4, // (0x04 prefix) https://en.bitcoin.it/wiki/Elliptic_Curve_Digital_Signature_Algorithm
            ...publicKeyObject.get('-2')!,
            ...publicKeyObject.get('-3')!
        ])

        return {
            keyId: base64url.toBuffer(startRegistrationResponse.id),
            publicKey
        }
    }

    public async connectWallet(id?: string) {
        /* TODO 
            - Support passing in a contractId as well as a keyId
                Maybe not as we wouldn't have a keyId which could have interesting consequences
                Also not sure what the use case would be for this where keyId wouldn't also be possible and better
                @No
        */

        // @ts-ignore 
        // https://github.com/stellar/js-stellar-base/issues/750
        // if (id && StrKey.isValidContract(id)) {

        // } else {

        // }

        const startAuthenticationResponse = id
            ? { id }
            : await startAuthentication({
                challenge: base64url("stellaristhebetterblockchain"),
                // rpId: undefined,
                userVerification: "discouraged",
            });

        if (!this.keyId)
            this.keyId = startAuthenticationResponse.id

        const keyIdBuffer = base64url.toBuffer(startAuthenticationResponse.id)

        // NOTE might not need this for derivation as all signers are stored in the factory and we can use that lookup as both primary and secondary
        let contractId = StrKey.encodeContract(hash(xdr.HashIdPreimage.envelopeTypeContractId(
            new xdr.HashIdPreimageContractId({
                networkId: hash(Buffer.from(this.networkPassphrase, 'utf-8')),
                contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
                    new xdr.ContractIdPreimageFromAddress({
                        address: Address.fromString(this.factoryContractId).toScAddress(),
                        salt: hash(keyIdBuffer),
                    })
                )
            })
        ).toXDR()));

        // attempt passkey id derivation
        try {
            await this.rpc.getContractData(contractId, xdr.ScVal.scvLedgerKeyContractInstance())
        }
        // if that fails look up from the factory mapper
        catch {
            const { val } = await this.rpc.getContractData(this.factoryContractId, xdr.ScVal.scvBytes(keyIdBuffer))
            contractId = scValToNative(val.contractData().val())
        }

        this.wallet = new PasskeyClient({
            contractId,
            networkPassphrase: this.networkPassphrase,
            rpcUrl: this.rpcUrl
        })

        // get and set the sudo signer
        await this.getData()

        return {
            keyId: keyIdBuffer,
            contractId
        }
    }

    /* TODO 
        - Is there anything to be done with using the TS bindings `signAuthEntries` logic? Likely not but worth exploring 
            Perhaps not but maybe the js-sdk's `authorizeEntry` or `authorizeInvocation`
            https://stellar.github.io/js-stellar-sdk/global.html#authorizeInvocation
    */
    public async sign(
        txn: Transaction | string,
        options?: {
            keyId?: 'any' | 'sudo' | string | Uint8Array
            ledgersToLive?: number
        }
    ) {
        // Default mirrors DEFAULT_TIMEOUT (currently 5 minutes) https://github.com/stellar/js-stellar-sdk/blob/master/src/contract/utils.ts#L7
        let { keyId, ledgersToLive = 60 } = options || {}

        // Hack to ensure we don't stack fees when simulating and assembling multiple times
        txn = TransactionBuilder.cloneFrom(new Transaction(
            typeof txn === 'string'
                ? txn
                : txn.toXDR(),
            this.networkPassphrase
        ), { fee: '0' }).build()

        // NOTE hard coded to sign only Soroban transactions and only and always the first auth
        /* TODO !!!
            - Switch to support signing multiple and specific auth entries
                Possibly pass in auth entry vs the entire txn
                    Probably a bad idea as it would add complexity to the user side to reassemble the signed entries
                I think we can probably look at the list of auth entries and assume which ones we want to sign
        */
        const op = txn.operations[0] as Operation.InvokeHostFunction
        const auth = op.auth![0]
        const lastLedger = await this.rpc.getLatestLedger().then(({ sequence }) => sequence)
        const authHash = hash(
            xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
                new xdr.HashIdPreimageSorobanAuthorization({
                    networkId: hash(Buffer.from(this.networkPassphrase, 'utf-8')),
                    nonce: auth.credentials().address().nonce(),
                    signatureExpirationLedger: lastLedger + ledgersToLive,
                    invocation: auth.rootInvocation()
                })
            ).toXDR()
        )

        const authenticationResponse = await startAuthentication(
            keyId === 'any'
                || (keyId === 'sudo' && !this.sudoKeyId)
                || (!keyId && !this.keyId)
                ? {
                    challenge: base64url(authHash),
                    // rpId: undefined,
                    userVerification: "discouraged",
                }
                : {
                    challenge: base64url(authHash),
                    // rpId: undefined,
                    allowCredentials: [
                        {
                            id: keyId === 'sudo'
                                ? this.sudoKeyId!
                                : keyId instanceof Uint8Array
                                    ? base64url(keyId)
                                    : keyId || this.keyId!,
                            type: "public-key",
                        },
                    ],
                    userVerification: "discouraged",
                }
        );

        // set sudo if this is a sudo request
        if (keyId === 'sudo')
            this.sudoKeyId = authenticationResponse.id

        // reset this.keyId to be the most recently used passkey
        this.keyId = authenticationResponse.id

        const signatureRaw = base64url.toBuffer(authenticationResponse.response.signature);
        const signature = this.convertEcdsaSignatureAsnToCompact(signatureRaw);
        const creds = auth.credentials().address();

        creds.signatureExpirationLedger(lastLedger + ledgersToLive)
        creds.signature(xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('authenticator_data'),
                val: xdr.ScVal.scvBytes(base64url.toBuffer(authenticationResponse.response.authenticatorData)),
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('client_data_json'),
                val: xdr.ScVal.scvBytes(base64url.toBuffer(authenticationResponse.response.clientDataJSON)),
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('id'),
                val: xdr.ScVal.scvBytes(base64url.toBuffer(authenticationResponse.id)),
            }),
            new xdr.ScMapEntry({
                key: xdr.ScVal.scvSymbol('signature'),
                val: xdr.ScVal.scvBytes(signature),
            }),
        ]))

        const sim = await this.rpc.simulateTransaction(txn)

        if (
            SorobanRpc.Api.isSimulationError(sim)
            || SorobanRpc.Api.isSimulationRestore(sim) // TODO handle state archival
        ) throw sim

        return SorobanRpc.assembleTransaction(txn, sim).build().toXDR()
    }

    public async getData() {
        const data: Map<string, any> = new Map()

        const { val } = await this.rpc.getContractData(
            this.wallet!.options.contractId,
            xdr.ScVal.scvLedgerKeyContractInstance(),
        );

        val.contractData()
            .val()
            .instance()
            .storage()
            ?.forEach((entry) => {
                data.set(
                    scValToNative(entry.key()),
                    scValToNative(entry.val()),
                );
            });

        this.sudoKeyId = base64url(data.get('sudo_sig'))

        return data
    }

    /* TODO 
        - Add a getKeyInfo action to get info about a specific passkey
            Specifically looking for name, type, etc. data so a user could grok what signer mapped to what passkey
            @Later
    */

    private getPublicKeyObject(attestationObject: string) {
        const { authData } = decode(base64url.toBuffer(attestationObject));
        const authDataUint8Array = new Uint8Array(authData);
        const authDataView = new DataView(authDataUint8Array.buffer, 0, authDataUint8Array.length);

        let offset = 0;

        // RP ID Hash (32 bytes)
        const rpIdHash = authData.slice(offset, offset + 32);
        offset += 32;

        // Flags (1 byte)
        const flags = authDataView.getUint8(offset);
        offset += 1;

        // Sign Count (4 bytes, big endian)
        const signCount = authDataView.getUint32(offset, false);
        offset += 4;

        // Attested Credential Data, if present
        if (flags & 0x40) { // Checking the AT flag
            // AAGUID (16 bytes)
            const aaguid = authData.slice(offset, offset + 16);
            offset += 16;

            // Credential ID Length (2 bytes, big endian)
            const credIdLength = authDataView.getUint16(offset, false);
            offset += 2;

            // Credential ID (variable length)
            const credentialId = authData.slice(offset, offset + credIdLength);
            offset += credIdLength;

            // Credential Public Key - (77 bytes...I hope)
            const credentialPublicKey = authData.slice(offset, offset + 77);
            offset += 77;

            // Any leftover bytes. I found some when using a YubiKey
            const theRest = authData.slice(offset);

            // Decode the credential public key to COSE
            const publicKeyObject = new Map<string, any>(Object.entries(decode(credentialPublicKey)));

            return {
                rpIdHash,
                flags,
                signCount,
                aaguid,
                credIdLength,
                credentialId,
                credentialPublicKey,
                theRest,
                publicKeyObject
            };
        }

        throw new Error("Attested credential data not present in the flags.");
    }

    private convertEcdsaSignatureAsnToCompact(sig: Buffer) {
        // Define the order of the curve secp256k1
        // https://github.com/RustCrypto/elliptic-curves/blob/master/p256/src/lib.rs#L72
        const q = Buffer.from('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551', 'hex')

        // ASN Sequence
        let offset = 0;
        if (sig[offset] != 0x30) {
            throw "signature is not a sequence";
        }
        offset += 1;

        // ASN Sequence Byte Length
        offset += 1;

        // ASN Integer (R)
        if (sig[offset] != 0x02) {
            throw "first element in sequence is not an integer";
        }
        offset += 1;

        // ASN Integer (R) Byte Length
        const rLen = sig[offset];
        offset += 1;

        // ASN Integer (R) Byte Value
        if (rLen >= 33) {
            if (rLen != 33 || sig[offset] != 0x00) {
                throw "can only handle larger than 32 byte R's that are len 33 and lead with zero";
            }
            offset += 1;
        }
        const r = sig.slice(offset, offset + 32);
        offset += 32;

        // ASN Integer (S)
        if (sig[offset] != 0x02) {
            throw "second element in sequence is not an integer";
        }
        offset += 1;

        // ASN Integer (S) Byte Length
        const sLen = sig[offset];
        offset += 1;

        // ASN Integer (S) Byte Value
        if (sLen >= 33) {
            if (sLen != 33 || sig[offset] != 0x00) {
                throw "can only handle larger than 32 byte R's that are len 33 and lead with zero";
            }
            offset += 1;
        }

        const s = sig.slice(offset, offset + 32);

        offset += 32;

        let signature64: Buffer

        // Force low S range
        // https://github.com/stellar/stellar-protocol/discussions/1435#discussioncomment-8809175
        // https://discord.com/channels/897514728459468821/1233048618571927693
        if (bufToBigint(s) > ((bufToBigint(q) - BigInt(1)) / BigInt(2))) {
            signature64 = Buffer.from([...r, ...Buffer.from(bigintToBuf(bufToBigint(q) - bufToBigint(s), true) as ArrayBuffer)]);
        } else {
            signature64 = Buffer.from([...r, ...s]);
        }

        return signature64;
    }
}