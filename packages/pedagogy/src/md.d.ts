// Prompt files are imported as text: esbuild's "text" loader in the bundles,
// and the markdown plugin in vitest.config.ts for tests.
declare module "*.md" {
  const text: string;
  export default text;
}
