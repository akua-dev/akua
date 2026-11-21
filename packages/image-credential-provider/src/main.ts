import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunStdio from '@effect/platform-bun/BunStdio';
import { Effect } from 'effect';
import { credentialProviderProgram } from './Program';

BunRuntime.runMain(credentialProviderProgram.pipe(Effect.provide(BunStdio.layer)), {
	disableErrorReporting: true
});
