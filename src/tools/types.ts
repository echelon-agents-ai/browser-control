import type { CallContext } from "../protocol";
export type Args = Record<string, unknown>;
export type Tool = (ctx: CallContext, args: Args) => Promise<unknown>;
