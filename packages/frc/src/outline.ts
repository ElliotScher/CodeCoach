import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Language, Parser } from "web-tree-sitter";
import type { Node, Tree } from "web-tree-sitter";

export type SourceLanguage = "java" | "cpp" | "python";

const GRAMMAR_FILES: Readonly<Record<SourceLanguage, string>> = {
  java: "tree-sitter-java/tree-sitter-java.wasm",
  cpp: "tree-sitter-cpp/tree-sitter-cpp.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
};

export function languageForFile(file: string): SourceLanguage | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".java") return "java";
  if ([".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".hxx", ".inc"].includes(ext)) return "cpp";
  if (ext === ".py") return "python";
  return null;
}

/**
 * Finds a WASM file. Bundles (the CLI, the extension) copy the files to a
 * `grammars/` folder next to the bundle; from source they come from the
 * grammar packages. CODECOACH_GRAMMAR_DIR overrides both.
 */
function locateWasm(pkgFile: string): string {
  const base = path.basename(pkgFile);
  const dirs = [process.env["CODECOACH_GRAMMAR_DIR"], fileURLToPath(new URL("./grammars/", import.meta.url))].filter(
    (d): d is string => Boolean(d),
  );
  for (const dir of dirs) {
    const candidate = path.join(dir, base);
    if (existsSync(candidate)) return candidate;
  }
  return createRequire(import.meta.url).resolve(pkgFile);
}

let initPromise: Promise<void> | null = null;
const languages = new Map<SourceLanguage, Promise<Language>>();

async function languageFor(lang: SourceLanguage): Promise<Language> {
  initPromise ??= Parser.init({ locateFile: () => locateWasm("web-tree-sitter/web-tree-sitter.wasm") });
  await initPromise;
  let l = languages.get(lang);
  if (!l) {
    l = Language.load(locateWasm(GRAMMAR_FILES[lang]));
    languages.set(lang, l);
  }
  return l;
}

export async function parseSource(lang: SourceLanguage, text: string): Promise<Tree> {
  const language = await languageFor(lang); // initializes the runtime before `new Parser()`
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(text);
  parser.delete();
  if (!tree) throw new Error(`could not parse ${lang} source`);
  return tree;
}

export type SymbolKind =
  "class" | "interface" | "enum" | "record" | "struct" | "namespace" | "method" | "constructor" | "function" | "field";

export interface OutlineSymbol {
  kind: SymbolKind;
  name: string;
  /** 1-based. */
  line: number;
  endLine: number;
  parent?: string;
  /** Superclass and implemented interfaces / base classes. */
  bases?: string[];
}

export async function outline(lang: SourceLanguage, text: string): Promise<OutlineSymbol[]> {
  const tree = await parseSource(lang, text);
  const out: OutlineSymbol[] = [];
  try {
    walk(lang, tree.rootNode, undefined, out);
  } finally {
    tree.delete();
  }
  return out;
}

const sym = (
  kind: SymbolKind,
  name: string,
  node: Node,
  parent: string | undefined,
  bases?: string[],
): OutlineSymbol => ({
  kind,
  name,
  line: node.startPosition.row + 1,
  endLine: node.endPosition.row + 1,
  ...(parent ? { parent } : {}),
  ...(bases?.length ? { bases } : {}),
});

function walk(lang: SourceLanguage, node: Node, parent: string | undefined, out: OutlineSymbol[]): void {
  const found =
    lang === "java" ? javaSymbol(node, parent) : lang === "cpp" ? cppSymbol(node, parent) : pythonSymbol(node, parent);
  for (const s of found) out.push(s);
  const container = found.find((s) => ["class", "interface", "enum", "record", "struct", "namespace"].includes(s.kind));
  for (const child of node.namedChildren) {
    if (child) walk(lang, child, container ? container.name : parent, out);
  }
}

function javaSymbol(node: Node, parent: string | undefined): OutlineSymbol[] {
  const name = node.childForFieldName("name")?.text;
  switch (node.type) {
    case "class_declaration":
    case "interface_declaration":
    case "enum_declaration":
    case "record_declaration": {
      if (!name) return [];
      const bases: string[] = [];
      const superclass = node.childForFieldName("superclass");
      if (superclass) bases.push(superclass.text.replace(/^extends\s+/, ""));
      const interfaces =
        node.childForFieldName("interfaces") ?? node.namedChildren.find((c) => c?.type === "extends_interfaces");
      if (interfaces) {
        for (const t of interfaces.descendantsOfType("type_identifier")) if (t) bases.push(t.text);
      }
      const kind = node.type.replace("_declaration", "") as SymbolKind;
      return [sym(kind, name, node, parent, bases)];
    }
    case "method_declaration":
      return name ? [sym("method", name, node, parent)] : [];
    case "constructor_declaration":
      return name ? [sym("constructor", name, node, parent)] : [];
    case "field_declaration":
      return node
        .descendantsOfType("variable_declarator")
        .map((d) => d?.childForFieldName("name")?.text)
        .filter((n): n is string => Boolean(n))
        .map((n) => sym("field", n, node, parent));
    default:
      return [];
  }
}

function cppDeclaratorName(node: Node | null): string | null {
  let d: Node | null = node;
  while (d) {
    if (["identifier", "field_identifier", "qualified_identifier", "destructor_name", "operator_name"].includes(d.type))
      return d.text;
    d = d.childForFieldName("declarator");
  }
  return null;
}

function cppSymbol(node: Node, parent: string | undefined): OutlineSymbol[] {
  switch (node.type) {
    case "class_specifier":
    case "struct_specifier": {
      const name = node.childForFieldName("name")?.text;
      if (!name || !node.childForFieldName("body")) return [];
      const baseClause = node.namedChildren.find((c) => c?.type === "base_class_clause");
      const bases = baseClause
        ? baseClause.namedChildren.filter((c) => c && c.type !== "access_specifier").map((c) => c!.text)
        : [];
      return [sym(node.type === "class_specifier" ? "class" : "struct", name, node, parent, bases)];
    }
    case "namespace_definition": {
      const name = node.childForFieldName("name")?.text;
      return name ? [sym("namespace", name, node, parent)] : [];
    }
    case "function_definition": {
      const name = cppDeclaratorName(node.childForFieldName("declarator"));
      if (!name) return [];
      const qualified = name.includes("::");
      return [sym(parent || qualified ? "method" : "function", name, node, parent)];
    }
    case "field_declaration": {
      const decl = node.childForFieldName("declarator");
      const name = cppDeclaratorName(decl);
      if (!name) return [];
      const isMethod = decl?.type === "function_declarator";
      return [sym(isMethod ? "method" : "field", name, node, parent)];
    }
    default:
      return [];
  }
}

function pythonSymbol(node: Node, parent: string | undefined): OutlineSymbol[] {
  const name = node.childForFieldName("name")?.text;
  if (!name) return [];
  if (node.type === "class_definition") {
    const supers = node.childForFieldName("superclasses");
    const bases = supers ? supers.namedChildren.filter(Boolean).map((c) => c!.text) : [];
    return [sym("class", name, node, parent, bases)];
  }
  if (node.type === "function_definition") return [sym(parent ? "method" : "function", name, node, parent)];
  return [];
}

/** A compact, stable text rendering for the model. */
export function renderOutline(symbols: readonly OutlineSymbol[]): string {
  return symbols
    .map((s) => {
      const indent = s.parent ? "  " : "";
      const bases = s.bases?.length ? ` : ${s.bases.join(", ")}` : "";
      return `${indent}${s.kind} ${s.name}${bases}  (lines ${s.line}-${s.endLine})`;
    })
    .join("\n");
}
