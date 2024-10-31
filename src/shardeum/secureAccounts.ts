import { AccountMap, AccountType, BaseAccount, InternalTx, InternalTxBase, InternalTXType, ReadableReceipt, TransferFromSecureAccount, WrappedEVMAccount, WrappedStates } from './shardeumTypes'
import { updateEthAccountHash } from './wrappedEVMAccountFunctions'
import { ShardeumFlags } from './shardeumFlags'
import { generateTxId } from '../utils'
import { toShardusAddress } from './evmAddress'

import { ShardusTypes, DevSecurityLevel, Shardus } from '@shardus/core'
import { verifyMultiSigs } from '../setup/helpers'
import { shardusConfig } from '..'
import { _shardusWrappedAccount } from './wrappedEVMAccountFunctions'
import { crypto } from '../setup/helpers'
import { VectorBufferStream } from '@shardus/core'
import { TypeIdentifierEnum } from '../types/enum/TypeIdentifierEnum'

import genesisSecureAccounts from '../config/genesis-secure-accounts.json'
validateSecureAccountConfig(genesisSecureAccounts)

export interface SecureAccount extends BaseAccount {
  id: string
  hash: string
  timestamp: number
  name: string
  nextTransferAmount: bigint
  nextTransferTime: number
  nonce: number
}

export interface SecureAccountConfig {
  Name: string;
  SourceFundsAddress: string;
  RecipientFundsAddress: string;
  SecureAccountAddress: string; // This will be the 32-byte address format
  SourceFundsBalance: string;
}

export function isSecureAccount(obj: unknown): obj is SecureAccount {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'name' in obj &&
    'nextTransferAmount' in obj &&
    'nextTransferTime' in obj
  )
}

export function initializeSecureAccount(
  secureAccountConfig: SecureAccountConfig,
  latestCycles: { start: number }[]
): SecureAccount {
  let cycleStart = 0
  if (latestCycles.length > 0) {
    cycleStart = latestCycles[0].start * 1000
  }

  const secureAccount: SecureAccount = {
    id: secureAccountConfig.SecureAccountAddress, // Use SecureAccountAddress as id
    hash: '',
    timestamp: cycleStart,
    accountType: AccountType.SecureAccount,
    name: secureAccountConfig.Name,
    nextTransferAmount: BigInt(0),
    nextTransferTime: 0,
    nonce: 0
  }

  updateEthAccountHash(secureAccount)

  if (ShardeumFlags.VerboseLogs) console.log('SecureAccount created', secureAccount)

  return secureAccount
}

export function serializeSecureAccount(account: SecureAccount): any {
  return {
    ...account,
    nextTransferAmount: account.nextTransferAmount.toString(),
  };
}

interface SecureAccountData {
  Name: string
  SourceFundsAddress: string
  RecipientFundsAddress: string
  SecureAccountAddress: string
}

export const secureAccountDataMap: Map<string, SecureAccountData> = new Map(
  genesisSecureAccounts.map(account => [account.Name, account])
)

interface CrackedData {
  sourceKeys: string[]
  targetKeys: string[]
}

export function crack(tx: TransferFromSecureAccount): CrackedData {
  return {
    sourceKeys: [
      toShardusAddress(secureAccountDataMap.get(tx.accountName).SourceFundsAddress, AccountType.Account),
      toShardusAddress(secureAccountDataMap.get(tx.accountName).SecureAccountAddress, AccountType.SecureAccount),
    ],
    targetKeys: [
      toShardusAddress(secureAccountDataMap.get(tx.accountName).RecipientFundsAddress, AccountType.Account)
    ]
  }
}

export function validateTransferFromSecureAccount(tx: TransferFromSecureAccount, shardus: Shardus): { success: boolean; reason: string } {
  if (tx.txType !== InternalTXType.TransferFromSecureAccount) {
    return { success: false, reason: 'Invalid transaction type' }
  }

  if (typeof tx.amount !== 'string' || !/^\d+$/.test(tx.amount)) {
    return { success: false, reason: 'Invalid amount format' }
  }

  if (typeof tx.accountName !== 'string' || tx.accountName.trim() === '') {
    return { success: false, reason: 'Invalid account name' }
  }

  if (typeof tx.nonce !== 'number' || tx.nonce < 0) {
    return { success: false, reason: 'Invalid nonce' }
  }

  console.log('tx.accountName:', tx.accountName);
  console.log('genesisSecureAccounts:', genesisSecureAccounts);
  const secureAccountData = secureAccountDataMap.get(tx.accountName)
  if (!secureAccountData) {
    return { success: false, reason: 'Secure account not found' }
  }

  // Verify signatures
  if (!tx.sign || tx.sign.length === 0) {
    return { success: false, reason: 'Missing signatures' }
  }

  const txData = {
    txType: tx.txType,
    amount: tx.amount,
    accountName: tx.accountName,
    nonce: tx.nonce
  }

  const allowedPublicKeys = shardus.getMultisigPublicKeys()
  const requiredSigs = Math.max(1, shardusConfig.debug.minMultiSigRequiredForGlobalTxs || 1)
  console.log('requiredSigs:', requiredSigs);
  console.log('allowedPublicKeys:', allowedPublicKeys);
  console.log('tx.sign:', tx.sign);
  console.log('txData:', txData);
  const isSignatureValid = verifyMultiSigs(
    txData,
    tx.sign,
    allowedPublicKeys,
    requiredSigs,
    DevSecurityLevel.High
  )

  if (!isSignatureValid) {
    return { success: false, reason: 'Invalid signatures' }
  }

  return { success: true, reason: '' }
}

export function verify(
  tx: TransferFromSecureAccount,
  wrappedStates: WrappedStates,
  shardus: Shardus
): { success: boolean; reason: string } {
  const commonValidation = validateTransferFromSecureAccount(tx, shardus)
  if (!commonValidation.success) {
    return { success: false, reason: commonValidation.reason }
  }

  const secureAccountConfig = secureAccountDataMap.get(tx.accountName)
  // this may be wrong, and its possible that I need to make wrappedStates give me this account as a wrapped evm account?
  // not sure but this is probably fine
  const secureAccount = wrappedStates[secureAccountConfig.SecureAccountAddress] as unknown as SecureAccount

  if (!secureAccount || secureAccount.accountType !== AccountType.SecureAccount) {
    return { success: false, reason: 'Secure account not found or invalid' }
  }

  const sourceFundsAccount = wrappedStates[secureAccountConfig.SourceFundsAddress] as unknown as WrappedEVMAccount
  const recipientFundsAccount = wrappedStates[secureAccountConfig.RecipientFundsAddress] as unknown as WrappedEVMAccount

  if (!sourceFundsAccount || !recipientFundsAccount) {
    return { success: false, reason: 'Source or recipient account not found' }
  }

  const transferAmount = BigInt(tx.amount)
  const sourceBalance = BigInt(sourceFundsAccount.account.balance)

  if (sourceBalance < transferAmount) {
    return { success: false, reason: 'Insufficient balance in source account' }
  }

  if (tx.nonce !== Number(secureAccount.nonce)) {
    return { success: false, reason: 'Invalid nonce' }
  }

  const currentTime = Date.now()
  if (currentTime < secureAccount.nextTransferTime) {
    return { success: false, reason: 'Transfer not allowed yet, time restriction' }
  }

  if (transferAmount > secureAccount.nextTransferAmount) {
    return { success: false, reason: 'Transfer amount exceeds allowed limit' }
  }

  return { success: true, reason: 'Valid transaction' }
}

export async function apply(
  tx: TransferFromSecureAccount,
  txId: string,
  wrappedStates: WrappedStates,
  shardus: Shardus,
  applyResponse: ShardusTypes.ApplyResponse
): Promise<void> {
  const secureAccountConfig = secureAccountDataMap.get(tx.accountName)
  const sourceEOA = wrappedStates[secureAccountConfig.SourceFundsAddress];
  const destEOA = wrappedStates[secureAccountConfig.RecipientFundsAddress];
  const secureAccount = wrappedStates[secureAccountConfig.SecureAccountAddress];
  const sourceEOAData = sourceEOA.data as WrappedEVMAccount;
  const destEOAData = destEOA.data as WrappedEVMAccount;
  const secureAccountData = secureAccount.data as SecureAccount; 
  if (!sourceEOA || !destEOA || !secureAccount) {
    throw new Error('One or more required accounts not found');
  }

  const amount = BigInt(tx.amount);

  if (BigInt(sourceEOAData.account.balance) < amount) {
    throw new Error('Insufficient balance in source account');
  }

  sourceEOAData.balance = Number(BigInt(sourceEOAData.account.balance) - amount)
  destEOAData.balance = Number(BigInt(destEOAData.account.balance) + amount)

  secureAccountData.nonce += 1;
  
  updateEthAccountHash(sourceEOAData);
  updateEthAccountHash(destEOAData);
  updateEthAccountHash(secureAccountData);

  const wrappedSourceEOA = _shardusWrappedAccount(sourceEOAData);
  const wrappedDestEOA = _shardusWrappedAccount(destEOAData);
  const wrappedSecureAccount = _shardusWrappedAccount(secureAccountData);

  shardus.applyResponseAddChangedAccount(
    applyResponse,
    secureAccountConfig.SourceFundsAddress,
    wrappedSourceEOA as ShardusTypes.WrappedResponse,
    txId,
    applyResponse.txTimestamp
  );
  shardus.applyResponseAddChangedAccount(
    applyResponse,
    secureAccountConfig.RecipientFundsAddress,
    wrappedDestEOA as ShardusTypes.WrappedResponse,
    txId,
    applyResponse.txTimestamp
  );
  shardus.applyResponseAddChangedAccount(
    applyResponse,
    secureAccountConfig.SecureAccountAddress,
    wrappedSecureAccount as ShardusTypes.WrappedResponse,
    txId,
    applyResponse.txTimestamp
  );

  // Create the receipt data
  const readableReceipt: ReadableReceipt = {
    status: 1, 
    transactionHash: txId,
    transactionIndex: '0x0',
    blockHash: '', 
    blockNumber: '0x0',
    from: secureAccountConfig.SourceFundsAddress,
    to: secureAccountConfig.RecipientFundsAddress,
    contractAddress: null,
    cumulativeGasUsed: '0x0',
    gasUsed: '0x0',
    logs: [],
    logsBloom: '0x',
    type: '0x0',
    // Additional fields for TransferFromSecureAccount
    value: tx.amount,
    nonce: `0x${tx.nonce.toString(16)}`, 
    gasRefund: '0x0',
    data: '', 
  };

  const wrappedReceiptAccount: WrappedEVMAccount = {
    timestamp: applyResponse.txTimestamp,
    ethAddress: txId, // Using txId as ethAddress for the receipt
    hash: '',
    readableReceipt,
    amountSpent: '0x0',
    txId: txId,
    accountType: AccountType.SecureAccount,
    txFrom: secureAccountConfig.SourceFundsAddress,
  };

  console.log('Getting receiptShardusAccount from wrappedReceiptAccount:', JSON.stringify(wrappedReceiptAccount, null, 2));
  const receiptShardusAccount = _shardusWrappedAccount(wrappedReceiptAccount);
  
  console.log('SENDING RECEIPT TO ARCHIVER', JSON.stringify(receiptShardusAccount, null, 2));
  shardus.applyResponseAddReceiptData(
    applyResponse,
    receiptShardusAccount,
    crypto.hashObj(receiptShardusAccount)
  );
}

export function isTransferFromSecureAccount(tx: InternalTxBase): tx is TransferFromSecureAccount {
  return tx.internalTXType === InternalTXType.TransferFromSecureAccount
}

export function deserializeSecureAccount(stream: VectorBufferStream, root = false): SecureAccount {
  try {
    if (root) {
      const typeId = stream.readUInt16()
      if (typeId !== TypeIdentifierEnum.cSecureAccount) {
        throw new Error(`Invalid type identifier: ${typeId}`)
      }
    }

    return {
      id: stream.readString(),
      hash: stream.readString(),
      timestamp: Number(stream.readBigUInt64()),
      accountType: AccountType.SecureAccount,
      name: stream.readString(),
      nextTransferAmount: stream.readBigUInt64(),
      nextTransferTime: Number(stream.readBigUInt64()),
      nonce: stream.readUInt32()
    }
  } catch (e) {
    if (e instanceof RangeError) {
      throw new Error('Unexpected end of buffer')
    }
    throw e
  }
}

function validateSecureAccountConfig(config: SecureAccountConfig[]): void {
  const seenAddresses = new Set<string>()
  
  for (const account of config) {
    if (account.SourceFundsAddress === account.RecipientFundsAddress) {
      throw new Error(`Invalid secure account config for ${account.Name}: Source and recipient addresses must be different`)
    }
    
    if (seenAddresses.has(account.SourceFundsAddress)) {
      throw new Error(`Duplicate source address found: ${account.SourceFundsAddress}`)
    }
    if (seenAddresses.has(account.RecipientFundsAddress)) {
      throw new Error(`Duplicate recipient address found: ${account.RecipientFundsAddress}`)
    }
    
    seenAddresses.add(account.SourceFundsAddress)
    seenAddresses.add(account.RecipientFundsAddress)
  }
}