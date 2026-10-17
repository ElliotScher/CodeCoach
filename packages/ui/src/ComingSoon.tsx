import { PACKAGE_NAME as CORE } from "@codecoach/core";

/** Placeholder chat panel until stage 2 builds the real UI. */
export function ComingSoon() {
  return (
    <main className="codecoach-coming-soon" data-core={CORE}>
      <h1>CodeCoach is coming soon</h1>
      <p>A virtual FRC software mentor that coaches rather than does.</p>
    </main>
  );
}
