/**
 * SeaDrop v1 — the canonical deployment address is the same on every chain OpenSea
 * supports it on (deterministic deployment).
 */
export const SEADROP_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5' as const;

/**
 * Only the pieces the bot needs.
 *
 * mintPublic is the one that can be pre-signed: its arguments are all known ahead of
 * the stage opening. mintAllowList and mintSigned take a Merkle proof or a server
 * signature that is issued per-wallet, so those stages must go through the API path.
 */
export const seaDropAbi = [
  {
    type: 'function',
    name: 'mintPublic',
    stateMutability: 'payable',
    inputs: [
      { name: 'nftContract', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'minterIfNotPayer', type: 'address' },
      { name: 'quantity', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'mintAllowList',
    stateMutability: 'payable',
    inputs: [
      { name: 'nftContract', type: 'address' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'minterIfNotPayer', type: 'address' },
      { name: 'quantity', type: 'uint256' },
      {
        name: 'mintParams',
        type: 'tuple',
        components: [
          { name: 'mintPrice', type: 'uint256' },
          { name: 'maxTotalMintableByWallet', type: 'uint256' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'dropStageIndex', type: 'uint256' },
          { name: 'maxTokenSupplyForStage', type: 'uint256' },
          { name: 'feeBps', type: 'uint256' },
          { name: 'restrictFeeRecipients', type: 'bool' },
        ],
      },
      { name: 'proof', type: 'bytes32[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getPublicDrop',
    stateMutability: 'view',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'mintPrice', type: 'uint80' },
          { name: 'startTime', type: 'uint48' },
          { name: 'endTime', type: 'uint48' },
          { name: 'maxTotalMintableByWallet', type: 'uint16' },
          { name: 'feeBps', type: 'uint16' },
          { name: 'restrictFeeRecipients', type: 'bool' },
        ],
      },
    ],
  },
  // Declared so viem decodes reverts by name instead of raw selector bytes. That is
  // what lets a pre-flight eth_call distinguish "this calldata is wrong" from "this
  // calldata is correct but the stage has not opened yet" — the difference between
  // refusing to arm and arming safely ahead of a race.
  {
    type: 'error',
    name: 'NotActive',
    inputs: [
      { name: 'currentTimestamp', type: 'uint256' },
      { name: 'startTimestamp', type: 'uint256' },
      { name: 'endTimestamp', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'IncorrectPayment',
    inputs: [
      { name: 'got', type: 'uint256' },
      { name: 'want', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'FeeRecipientNotAllowed', inputs: [] },
  { type: 'error', name: 'MintQuantityCannotBeZero', inputs: [] },
  {
    type: 'error',
    name: 'MintQuantityExceedsMaxMintedPerWallet',
    inputs: [
      { name: 'total', type: 'uint256' },
      { name: 'allowed', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'MintQuantityExceedsMaxSupply',
    inputs: [
      { name: 'total', type: 'uint256' },
      { name: 'maxSupply', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'MintQuantityExceedsMaxTokenSupplyForStage',
    inputs: [
      { name: 'total', type: 'uint256' },
      { name: 'maxTokenSupplyForStage', type: 'uint256' },
    ],
  },
  {
    // The fee recipient mintPublic must be given. NOT the creator payout address —
    // SeaDrop reverts FeeRecipientNotAllowed for that, which is how locally-encoded
    // calldata was found to be wrong before it ever reached a race.
    type: 'function',
    name: 'getAllowedFeeRecipients',
    stateMutability: 'view',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'getCreatorPayoutAddress',
    stateMutability: 'view',
    inputs: [{ name: 'nftContract', type: 'address' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

/** Minimal ERC-721 supply surface used for the supply guard. */
export const erc721SupplyAbi = [
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'maxSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
