const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const wrap = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = wrap(2);
export const bold = wrap(1);
export const italic = wrap(3);
export const cyan = wrap(36);
export const yellow = wrap(33);
export const red = wrap(31);
export const green = wrap(32);
