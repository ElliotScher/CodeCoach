/**
 * Minimal glob → RegExp for workspace-relative POSIX paths.
 * Supports `**` (any number of path segments), `*`, `?` and `{a,b}`.
 * A pattern without a slash matches the file name anywhere (`*.java`).
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.includes("/") ? glob.replace(/^\.\//, "") : `**/${glob}`;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` matches the rest.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const alts = pattern
          .slice(i + 1, end)
          .split(",")
          .map(escapeRegExp);
        re += `(?:${alts.join("|")})`;
        i = end;
      }
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
