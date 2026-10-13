import { Effect, FileSystem, Layer, Path } from 'effect';

import { ScriptFiles, ScriptHostFailure, ScriptHttp } from './services';

export const ScriptHttpLive = Layer.succeed(ScriptHttp, {
	getJson: (url) =>
		Effect.tryPromise({
			try: () => fetch(url),
			catch: (cause) => new ScriptHostFailure({ cause })
		}).pipe(
			Effect.flatMap((response) =>
				response.ok
					? Effect.tryPromise({
							try: () => response.json(),
							catch: (cause) => new ScriptHostFailure({ cause })
						})
					: Effect.fail(
							new ScriptHostFailure({
								cause: new Error(
									`OpenAPI fetch failed with ${response.status} ${response.statusText}`
								)
							})
						)
			)
		)
});

export const ScriptFilesLive = Layer.effect(
	ScriptFiles,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		return {
			readText: (filePath) =>
				fs
					.readFileString(filePath)
					.pipe(Effect.mapError((cause) => new ScriptHostFailure({ cause }))),
			writeText: (filePath, contents) =>
				fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
					Effect.flatMap(() => fs.writeFileString(filePath, contents)),
					Effect.mapError((cause) => new ScriptHostFailure({ cause }))
				)
		};
	})
);

export const ScriptLive = Layer.merge(ScriptHttpLive, ScriptFilesLive);
