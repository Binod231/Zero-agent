/**
 * The test doubles, in one import.
 *
 * Every property test is built from these four: the Entry_Store fake, one of the two clocks, the
 * capturing logger, and the Bedrock stub. No property test calls AWS (design: *Property test
 * conventions*), and nothing here imports an AWS SDK client.
 *
 * Each double implements an interface that lives in `src/core`, so the component under test is
 * constructed the same way in a test as in a Lambda:
 *
 * | Double            | Interface                                      | Real implementation        |
 * | ----------------- | ---------------------------------------------- | -------------------------- |
 * | `EntryStoreFake`  | `EntryRepository` (`entry-repository-port.ts`) | task 9.2                   |
 * | `FrozenClock`     | `Clock` (`clock.ts`)                            | task 14.2 onwards          |
 * | `VirtualClock`    | `Clock` (`clock.ts`)                            | task 14.2 onwards          |
 * | `CapturingLogger` | `DevlogLogger` (`logging.ts`)                   | task 10.2                  |
 * | `BedrockStub`     | `ModelClient` (`model-client.ts`)                | task 15                    |
 */

export { BedrockStub } from './bedrock-stub';
export type { BedrockStubOptions } from './bedrock-stub';
export { CapturingLogger } from './capturing-logger';
export type { CapturingLoggerOptions } from './capturing-logger';
export { FrozenClock, VirtualClock } from './clock';
export type { InstantInput } from './clock';
export { EntryStoreFake } from './entry-store-fake';
export type {
  EntryStoreFakeOptions,
  FailureInjection,
  InjectedFailureKind,
  StoreSnapshot,
} from './entry-store-fake';
