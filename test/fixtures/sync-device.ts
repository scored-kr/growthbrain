// Bundle the same crypto, capture and lookup functions used by the product in both test browsers.
export { deriveAccountKeys, createSnapshotKeys, unlockSnapshotKeys, sealSnapshot, openSnapshot } from '../../sync/account-envelope.ts';
export { captureTurn, emptyMemory, lookupContext } from '../../src/memory.ts';
import type { MemoryState } from '../../src/memory.ts';

// Parser for the fixture written by device A. Account binding and GCM verification run first.
export function readFixtureMemory(input: unknown, vaultId: string): MemoryState {
  if (!input || typeof input !== 'object' || !('ownerId' in input) || input.ownerId !== vaultId ||
      !('memory' in input) || !input.memory || typeof input.memory !== 'object' ||
      !('projects' in input.memory) || !Array.isArray(input.memory.projects) ||
      !('conversations' in input.memory) || !Array.isArray(input.memory.conversations)) throw Error('INVALID_TEST_STATE');
  return input.memory as MemoryState;
}
