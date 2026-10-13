import { Context } from "effect"

/**
 * How the running CLI spells itself in the hints of errors raised below the
 * verbs (dependency fetchers, resolution): `akuapkg`, or `akua pkg` when the
 * akua CLI embeds this host. The verbs get the same name from their context.
 */
export const CliName = Context.Reference<string>("akuapkg/CliName", { defaultValue: () => "akuapkg" })
