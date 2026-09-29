import { callNapi, loadNapi } from './napi';

export interface ExecuteOptions {
	/** Invocation rendered by command help, usage, and parser errors. */
	binName?: string;
}

/** Run an Akuapkg command synchronously through the native dispatcher. */
export function execute(args: readonly string[], options: ExecuteOptions = {}): number {
	const napi = loadNapi();
	return callNapi<number>(() => napi.execute([...args], options));
}
