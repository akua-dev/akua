/**
 * Filesystem helpers for suites that are not yet fully on it.effect.
 * Backed by Effect FileSystem + BunServices so tests stay off node:builtins.
 */
import { Effect, FileSystem, Path } from 'effect';
import { BunPath, BunServices } from '@effect/platform-bun';

const withFs = <A, E>(
	body: (fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E>
): Promise<A> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			return yield* body(fs, path);
		}).pipe(Effect.provide(BunServices.layer))
	);

const testPath = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));

export const joinPath = (...parts: string[]): string => testPath.join(...parts);
export const parsePath = (filePath: string) => testPath.parse(filePath);

export const sourceFiles = Effect.fn('test.sourceFiles')(function* (
	directory: string
): Effect.fn.Return<string[], unknown, FileSystem.FileSystem | Path.Path> {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const files: string[] = [];
	for (const entry of yield* fs.readDirectory(directory)) {
		const entryPath = path.join(directory, entry);
		const stat = yield* fs.stat(entryPath);
		if (stat.type === 'Directory') files.push(...(yield* sourceFiles(entryPath)));
		else if (stat.type === 'File' && entryPath.endsWith('.ts')) files.push(entryPath);
	}
	return files.sort();
});

export const readFileString = (filePath: string): Promise<string> =>
	withFs((fs) => fs.readFileString(filePath));

export const writeFileString = (
	filePath: string,
	contents: string,
	options?: { readonly mode?: number }
): Promise<void> =>
	withFs((fs) =>
		fs.writeFileString(filePath, contents, {
			mode: options?.mode
		})
	);

export const mkdirp = (dirPath: string, options?: { readonly mode?: number }): Promise<void> =>
	withFs((fs) =>
		fs.makeDirectory(dirPath, {
			recursive: true,
			mode: options?.mode
		})
	);

export const chmodPath = (filePath: string, mode: number): Promise<void> =>
	withFs((fs) => fs.chmod(filePath, mode));

export const removePath = (
	filePath: string,
	options?: { readonly recursive?: boolean; readonly force?: boolean }
): Promise<void> =>
	withFs((fs) =>
		fs.remove(filePath, {
			recursive: options?.recursive,
			force: options?.force
		})
	);

export const statMode = (filePath: string): Promise<number> =>
	withFs((fs) =>
		fs.stat(filePath).pipe(
			Effect.map((info) => {
				const mode = info.mode;
				return typeof mode === 'number' ? mode : Number(mode);
			})
		)
	);

export const mkdtempPath = (prefix: string, directory: string = process.cwd()): Promise<string> =>
	withFs((fs) =>
		fs.makeTempDirectory({
			directory,
			prefix
		})
	);

export const copyFilePath = (fromPath: string, toPath: string): Promise<void> =>
	withFs((fs) => fs.copyFile(fromPath, toPath));

export const symlinkPath = (target: string, linkPath: string): Promise<void> =>
	withFs((fs) => fs.symlink(target, linkPath));
