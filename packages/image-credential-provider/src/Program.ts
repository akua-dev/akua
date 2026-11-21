import { Cause, Config, Effect, Result, Schema, Stream } from 'effect';
import { Stdio } from 'effect/Stdio';
import {
	CredentialProviderDiagnostic,
	CredentialProviderFailure,
	provideCredential
} from './CredentialProvider';
import { imageCredentialRegistryVariable, RegistryHost } from './KubeletInstall';

/** One kubelet exec: the request on stdin, the response on stdout, the registry from the config's env. */
export const credentialProviderProgram = Effect.gen(function* () {
	const io = yield* Stdio;
	yield* Effect.gen(function* () {
		const registry = yield* Config.schema(RegistryHost, imageCredentialRegistryVariable).pipe(
			Effect.mapError(
				(cause) =>
					new CredentialProviderFailure({
						message: 'Invalid image credential registry configuration',
						cause
					})
			)
		);
		const input = yield* io.stdin.pipe(
			Stream.runFoldEffect(
				() => new Uint8Array(),
				(previous, chunk) => {
					if (previous.length + chunk.length > 65536)
						return Effect.fail(
							new CredentialProviderFailure({ message: 'Credential request is too large' })
						);
					const next = new Uint8Array(previous.length + chunk.length);
					next.set(previous);
					next.set(chunk, previous.length);
					return Effect.succeed(next);
				}
			),
			Effect.mapError((cause) =>
				cause instanceof CredentialProviderFailure
					? cause
					: new CredentialProviderFailure({ message: 'Unable to read credential request', cause })
			)
		);
		const response = yield* provideCredential(new TextDecoder().decode(input), registry);
		yield* Stream.make(`${response}\n`).pipe(
			Stream.run(io.stdout()),
			Effect.mapError(
				(cause) =>
					new CredentialProviderFailure({
						message: 'Unable to write credential response',
						cause
					})
			)
		);
	}).pipe(
		// Neither schema/transport errors nor unexpected defects may print the request or token.
		Effect.catchCause((cause) => {
			if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
			const failure = Cause.findError(cause);
			return Effect.fail(
				new CredentialProviderFailure({
					message:
						!Cause.hasDies(cause) && Result.isSuccess(failure)
							? failure.success.message
							: 'Unexpected image credential provider failure',
					cause
				})
			);
		}),
		Effect.tapError((error) =>
			Schema.encodeEffect(CredentialProviderDiagnostic)({ error: error.message }).pipe(
				Effect.flatMap((diagnostic) =>
					Stream.make(`${diagnostic}\n`).pipe(Stream.run(io.stderr()))
				),
				Effect.catchCause((cause) => Effect.failCause(Cause.combine(Cause.fail(error), cause)))
			)
		)
	);
});
