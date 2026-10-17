// Placeholder until stage 1 fills this package in.

import { PACKAGE_NAME as CORE } from "@codecoach/core";
import { PACKAGE_NAME as FRC } from "@codecoach/frc";
import { PACKAGE_NAME as PEDAGOGY } from "@codecoach/pedagogy";
import { PACKAGE_NAME as PROVIDERS } from "@codecoach/providers";

export const PACKAGE_NAME = "@codecoach/evals";
export const DEPENDS_ON: readonly string[] = [CORE, PROVIDERS, PEDAGOGY, FRC];
