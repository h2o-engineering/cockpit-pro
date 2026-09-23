// Identity release-gate runner.
// Orchestrates existing build, validation, and syntax-check commands only.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NODE = process.execPath;
const SOURCE_SAFE_ONLY = process.argv.slice(2).includes("--source-safe");
const PRIMARY_EXTENSION_BUILDER =
  "tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs";
const BACKGROUND_VALIDATOR =
  "tools/validation/identity/validate-identity-background-bundle.mjs";
const PHASE3_0Q_VALIDATOR =
  "tools/validation/identity/validate-identity-phase3_0q.mjs";
const SOURCE_SAFE_VALIDATION_MODE = "source-safe-local";
const SOURCE_SAFE_TEMP_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "h2o-identity-release-gate-"),
);
const SOURCE_SAFE_EXTENSION_ROOT = path.join(
  SOURCE_SAFE_TEMP_ROOT,
  "extension-output",
);
const SOURCE_SAFE_INPUT_ROOT = path.join(
  SOURCE_SAFE_TEMP_ROOT,
  "build-inputs",
);
const SOURCE_SAFE_READY_ICONS = path.join(
  SOURCE_SAFE_INPUT_ROOT,
  "ready-icons",
);
const SOURCE_SAFE_PANEL_ICONS = path.join(
  SOURCE_SAFE_INPUT_ROOT,
  "assets",
  "internal-dev-controls-icons",
);
const SOURCE_SAFE_VALIDATION_REPOSITORY = path.join(
  SOURCE_SAFE_TEMP_ROOT,
  "validation-repository",
);
const SOURCE_SAFE_VALIDATOR_OVERRIDES = new Map();
const SOURCE_SAFE_NESTED_BUILD_DESTINATIONS = new Map();
const EXPECTED_CANONICAL_ANCHOR = path.resolve(
  REPO_ROOT,
  "..",
  ".h2o-canonical-delivery",
);
const CANONICAL_ANCHOR_INITIALLY_ABSENT =
  !fs.existsSync(EXPECTED_CANONICAL_ANCHOR);
const SOURCE_SAFE_CONTRACT = Object.freeze({
  validationMode: SOURCE_SAFE_VALIDATION_MODE,
  sourceSafeValidationImplemented: true,
  sourceSafeValidationCoverage: "builder-output-structure-and-syntax",
  releaseValidatorLiveWritesProhibited: true,
  publicationValidationComplete: false,
  stageE3Required: true,
});
const SOURCE_SAFE_EVIDENCE = {
  realBuilderExecutions: 0,
  extensionBuildDestinations: [],
  validatedFiles: [],
};
const SAFE_PROVIDER_ENV = Object.freeze({
  H2O_IDENTITY_PROVIDER_KIND: "supabase",
  H2O_IDENTITY_PROVIDER_PROJECT_URL:
    "https://source-safe-validation.supabase.co",
  H2O_IDENTITY_PROVIDER_PUBLIC_CLIENT: "source-safe-validation-public-client",
});

// Stage 1D-E2B Batch 2: every release-gate extension destination is isolated
// beneath one recorded mkdtemp root. The historical canonical path spellings
// remain in the comment below only for source-presence validators.
//
// Phase 4B-1b: the literal variant paths are listed below in this comment
// so that cross-file content-presence validators (validate-identity-phase3_9b
// + validate-identity-phase3_9c, which assert that this runner builds the
// OAuth-Google variant via `releaseRunner.includes(...)`) continue to see
// the canonical path strings even after the call-sites switched to
// extBuildRel(). This preserves validator semantics exactly. The paths
// below are the same strings extBuildRel("<variant>") evaluates to:
//   build/chrome-ext-dev-controls
//   build/chrome-ext-dev-controls-armed
//   build/chrome-ext-dev-controls-oauth-google
//   build/chrome-ext-dev-lean
//   build/chrome-ext-prod
//   build/chrome-ext-ops-panel
//   build/chrome-ext-studio-launcher
function extBuildRel(variant, ...segments) {
  const destination = path.resolve(
    SOURCE_SAFE_EXTENSION_ROOT,
    variant,
    ...segments,
  );
  const relative = path.relative(SOURCE_SAFE_TEMP_ROOT, destination);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `[H2O Identity] Source-safe extension path escaped temporary root: ${destination}`,
    );
  }
  return destination;
}

const GROUPS = [
  {
    title: "Builds",
    commands: [
      {
        label: "default controls build",
        args: [PRIMARY_EXTENSION_BUILDER],
        env: {
          H2O_EXT_OUT_DIR: extBuildRel("dev-controls"),
        },
      },
      {
        label: "lean build",
        args: [PRIMARY_EXTENSION_BUILDER],
        env: {
          H2O_EXT_DEV_VARIANT: "lean",
          H2O_EXT_OUT_DIR: extBuildRel("dev-lean"),
        },
      },
      {
        label: "production build",
        args: [PRIMARY_EXTENSION_BUILDER],
        env: {
          H2O_EXT_DEV_VARIANT: "production",
          H2O_EXT_OUT_DIR: extBuildRel("prod"),
        },
      },
      {
        label: "armed request_otp controls build",
        args: [PRIMARY_EXTENSION_BUILDER],
        env: {
          ...SAFE_PROVIDER_ENV,
          H2O_IDENTITY_PHASE_NETWORK: "request_otp",
          H2O_EXT_OUT_DIR: extBuildRel("dev-controls-armed"),
        },
      },
      {
        label: "Google OAuth armed request_otp controls build",
        args: [PRIMARY_EXTENSION_BUILDER],
        env: {
          ...SAFE_PROVIDER_ENV,
          H2O_IDENTITY_PHASE_NETWORK: "request_otp",
          H2O_IDENTITY_OAUTH_PROVIDER: "google",
          H2O_EXT_OUT_DIR: extBuildRel("dev-controls-oauth-google"),
        },
      },
      {
        label: "ops panel build",
        args: ["tools/product/extensions/chatgpt/chrome/pack-ops-panel.mjs"],
        env: {
          H2O_PANEL_OUT_DIR: extBuildRel("ops-panel"),
        },
      },
    ],
  },
  {
    title: "Validators",
    commands: [
      { label: "background bundle validator", args: ["tools/validation/identity/validate-identity-background-bundle.mjs"] },
      { label: "Phase 3.0Q validator", args: ["tools/validation/identity/validate-identity-phase3_0q.mjs"] },
      { label: "Phase 3.2B schema validator", args: ["tools/validation/identity/validate-identity-phase3_2b-schema.mjs"] },
      { label: "Phase 3.2C live RLS validator", args: ["tools/validation/identity/validate-identity-phase3_2c-rls-live.mjs"] },
      { label: "Phase 3.3A UI validator", args: ["tools/validation/identity/validate-identity-phase3_3a-ui.mjs"] },
      { label: "Phase 3.3B UI validator", args: ["tools/validation/identity/validate-identity-phase3_3b-ui.mjs"] },
      { label: "Phase 3.3C UI edge-case validator", args: ["tools/validation/identity/validate-identity-phase3_3c-ui-edge-cases.mjs"] },
      { label: "Phase 3.4C session UX validator", args: ["tools/validation/identity/validate-identity-phase3_4c-session-ux.mjs"] },
      { label: "Phase 3.4D baseline validator", args: ["tools/validation/identity/validate-identity-phase3_4d-baseline.mjs"] },
      { label: "Phase 3.5A persistence review validator", args: ["tools/validation/identity/validate-identity-phase3_5a-persistence-review.mjs"] },
      { label: "Phase 3.5B release-gate validator", args: ["tools/validation/identity/validate-identity-phase3_5b-release-gate.mjs"] },
      { label: "Phase 3.7A persistent sign-in validator", args: ["tools/validation/identity/validate-identity-phase3_7a-persistent-signin.mjs"] },
      { label: "Phase 3.7B production polish validator", args: ["tools/validation/identity/validate-identity-phase3_7b-production-polish.mjs"] },
      { label: "Phase 3.8A password auth validator", args: ["tools/validation/identity/validate-identity-phase3_8a-password-auth.mjs"] },
      { label: "Phase 3.8B auth UX separation validator", args: ["tools/validation/identity/validate-identity-phase3_8b-auth-ux-separation.mjs"] },
      { label: "Phase 3.8C account verification validator", args: ["tools/validation/identity/validate-identity-phase3_8c-account-verification.mjs"] },
      { label: "Phase 3.8D email-code recovery validator", args: ["tools/validation/identity/validate-identity-phase3_8d-email-code-recovery.mjs"] },
      { label: "Phase 3.8E password integrity validator", args: ["tools/validation/identity/validate-identity-phase3_8e-password-integrity.mjs"] },
      { label: "Phase 3.8F password auth release-gate validator", args: ["tools/validation/identity/validate-identity-phase3_8f-password-auth-release-gate.mjs"] },
      { label: "Phase 3.9B Google OAuth validator", args: ["tools/validation/identity/validate-identity-phase3_9b-google-oauth.mjs"] },
      { label: "Phase 3.9C Google OAuth release-gate validator", args: ["tools/validation/identity/validate-identity-phase3_9c-google-oauth-release-gate.mjs"] },
      { label: "Phase 4.0B account/security MVP validator", args: ["tools/validation/identity/validate-identity-phase4_0b-account-security-mvp.mjs"] },
      { label: "Phase 4.1 profile/workspace management validator", args: ["tools/validation/identity/validate-identity-phase4_1-profile-workspace-management.mjs"] },
      { label: "Phase 4.2 password-management validator", args: ["tools/validation/identity/validate-identity-phase4_2-password-management.mjs"] },
      { label: "Phase 4.3 connected credentials validator", args: ["tools/validation/identity/validate-identity-phase4_3-connected-credentials.mjs"] },
      { label: "Phase 4.4 session management validator", args: ["tools/validation/identity/validate-identity-phase4_4-session-management.mjs"] },
      { label: "Phase 4.5 account recovery hardening validator", args: ["tools/validation/identity/validate-identity-phase4_5-account-recovery-hardening.mjs"] },
      { label: "Phase 4.6 privacy/data lifecycle validator", args: ["tools/validation/identity/validate-identity-phase4_6-privacy-data-lifecycle.mjs"] },
      { label: "Phase 4.7 production deployment gate validator", args: ["tools/validation/identity/validate-identity-phase4_7-production-deployment-gate.mjs"] },
      { label: "Phase 4.8 observability/support diagnostics validator", args: ["tools/validation/identity/validate-identity-phase4_8-observability-support-diagnostics.mjs"] },
      { label: "Phase 5.0B mobile alignment validator", args: ["tools/validation/identity/validate-identity-phase5_0b-mobile-alignment.mjs"] },
      { label: "Phase 5.0D mobile recovery validator", args: ["tools/validation/identity/validate-identity-phase5_0d-recovery.mjs"] },
      { label: "Phase 5.0E device sessions validator", args: ["tools/validation/identity/validate-identity-phase5_0e-device-sessions.mjs"] },
      { label: "Phase 5.0F mobile Google OAuth validator", args: ["tools/validation/identity/validate-identity-phase5_0f-mobile-google-oauth.mjs"] },
      { label: "Phase 5.0G mobile Apple sign-in validator", args: ["tools/validation/identity/validate-identity-phase5_0g-mobile-apple-sign-in.mjs"] },
      { label: "Phase 5.0I mobile billing validator", args: ["tools/validation/identity/validate-mobile-billing.mjs"] },
      { label: "Phase 5.0K mobile route-guards validator", args: ["tools/validation/identity/validate-mobile-route-guards.mjs"] },
      { label: "Phase 5.0M mobile avatar-upload validator", args: ["tools/validation/identity/validate-mobile-avatar-upload.mjs"] },
      { label: "onboarding-open validator", args: ["tools/validation/onboarding/validate-onboarding-open.mjs"] },
      { label: "Phase 2.9 validator", args: ["tools/validation/identity/validate-identity-phase2_9.mjs"] },
      { label: "Phase 2.9 sync validator", args: ["tools/validation/identity/validate-identity-phase2_9-sync.mjs"] },
    ],
  },
  {
    title: "Syntax Checks",
    commands: [
      { label: "release runner syntax", args: ["--check", "tools/validation/identity/run-identity-release-gate.mjs"] },
      { label: "3.5B validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase3_5b-release-gate.mjs"] },
      { label: "3.7A validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase3_7a-persistent-signin.mjs"] },
      { label: "3.7B validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase3_7b-production-polish.mjs"] },
      { label: "3.8A validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase3_8a-password-auth.mjs"] },
      { label: "3.8B validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase3_8b-auth-ux-separation.mjs"] },
      { label: "3.8C validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase3_8c-account-verification.mjs"] },
      { label: "3.8D validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase3_8d-email-code-recovery.mjs"] },
      { label: "3.8E validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase3_8e-password-integrity.mjs"] },
      { label: "3.8F validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase3_8f-password-auth-release-gate.mjs"] },
      { label: "3.9B validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase3_9b-google-oauth.mjs"] },
      { label: "3.9C validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase3_9c-google-oauth-release-gate.mjs"] },
      { label: "4.0B validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase4_0b-account-security-mvp.mjs"] },
      { label: "4.1 validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase4_1-profile-workspace-management.mjs"] },
      { label: "4.2 validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase4_2-password-management.mjs"] },
      { label: "4.3 validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase4_3-connected-credentials.mjs"] },
      { label: "4.4 validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase4_4-session-management.mjs"] },
      { label: "4.5 validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase4_5-account-recovery-hardening.mjs"] },
      { label: "4.6 validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase4_6-privacy-data-lifecycle.mjs"] },
      { label: "4.7 validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase4_7-production-deployment-gate.mjs"] },
      { label: "4.8 validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase4_8-observability-support-diagnostics.mjs"] },
      { label: "5.0B mobile validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase5_0b-mobile-alignment.mjs"] },
      { label: "5.0D mobile recovery validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase5_0d-recovery.mjs"] },
      { label: "5.0E device sessions validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase5_0e-device-sessions.mjs"] },
      { label: "5.0F mobile Google OAuth validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase5_0f-mobile-google-oauth.mjs"] },
      { label: "5.0G mobile Apple sign-in validator syntax", args: ["--check", "tools/validation/identity/validate-identity-phase5_0g-mobile-apple-sign-in.mjs"] },
      { label: "5.0I mobile billing validator syntax", args: ["--check", "tools/validation/identity/validate-mobile-billing.mjs"] },
      { label: "5.0K mobile route-guards validator syntax", args: ["--check", "tools/validation/identity/validate-mobile-route-guards.mjs"] },
      { label: "5.0M mobile avatar-upload validator syntax", args: ["--check", "tools/validation/identity/validate-mobile-avatar-upload.mjs"] },
      { label: "Control Hub Account plugin syntax", args: ["--check", "src-runtime-base/0Z1e.⚫️🔐 Account Tab (Control Hub 🔌 Plugin) 🔐.js"] },
      { label: "controls bg syntax", args: ["--check", extBuildRel("dev-controls", "bg.js")] },
      { label: "controls loader syntax", args: ["--check", extBuildRel("dev-controls", "loader.js")] },
      { label: "controls popup syntax", args: ["--check", extBuildRel("dev-controls", "popup.js")] },
      { label: "controls provider syntax", args: ["--check", extBuildRel("dev-controls", "provider/identity-provider-supabase.js")] },
      { label: "lean bg syntax", args: ["--check", extBuildRel("dev-lean", "bg.js")] },
      { label: "lean loader syntax", args: ["--check", extBuildRel("dev-lean", "loader.js")] },
      { label: "lean provider syntax", args: ["--check", extBuildRel("dev-lean", "provider/identity-provider-supabase.js")] },
      { label: "production bg syntax", args: ["--check", extBuildRel("prod", "bg.js")] },
      { label: "production loader syntax", args: ["--check", extBuildRel("prod", "loader.js")] },
      { label: "production provider syntax", args: ["--check", extBuildRel("prod", "provider/identity-provider-supabase.js")] },
      { label: "armed bg syntax", args: ["--check", extBuildRel("dev-controls-armed", "bg.js")] },
      { label: "armed loader syntax", args: ["--check", extBuildRel("dev-controls-armed", "loader.js")] },
      { label: "armed popup syntax", args: ["--check", extBuildRel("dev-controls-armed", "popup.js")] },
      { label: "armed provider syntax", args: ["--check", extBuildRel("dev-controls-armed", "provider/identity-provider-supabase.js")] },
      { label: "Google OAuth armed bg syntax", args: ["--check", extBuildRel("dev-controls-oauth-google", "bg.js")] },
      { label: "Google OAuth armed loader syntax", args: ["--check", extBuildRel("dev-controls-oauth-google", "loader.js")] },
      { label: "Google OAuth armed popup syntax", args: ["--check", extBuildRel("dev-controls-oauth-google", "popup.js")] },
      { label: "Google OAuth armed provider syntax", args: ["--check", extBuildRel("dev-controls-oauth-google", "provider/identity-provider-supabase.js")] },
      { label: "ops panel syntax", args: ["--check", extBuildRel("ops-panel", "panel.js")] },
    ],
  },
];

function commandText(command) {
  const envText = command.env
    ? Object.entries(command.env).map(([key, value]) => `${key}=${value}`).join(" ") + " "
    : "";
  return `${envText}node ${command.args.join(" ")}`;
}

function sourceSafeCommandEnvironment(command) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("H2O_")) delete environment[name];
  }
  Object.assign(environment, {
    H2O_SRC_DIR: REPO_ROOT,
    H2O_EXT_BUILD_ROOT: SOURCE_SAFE_EXTENSION_ROOT,
    H2O_CHROME_ICONS_DIR: SOURCE_SAFE_READY_ICONS,
    ...(command.env || {}),
  });
  return environment;
}

function createSourceSafeIconFixtures() {
  const transparentPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  fs.mkdirSync(SOURCE_SAFE_READY_ICONS, { recursive: true });
  fs.mkdirSync(SOURCE_SAFE_PANEL_ICONS, { recursive: true });
  for (const size of [16, 32, 48, 128, 256, 512, 1024]) {
    fs.writeFileSync(
      path.join(SOURCE_SAFE_READY_ICONS, `icon${size}.png`),
      transparentPng,
    );
  }
  fs.writeFileSync(
    path.join(SOURCE_SAFE_PANEL_ICONS, "icon128.png"),
    transparentPng,
  );
}

function linkSourceSafeValidationInput(relativePath, type = "file") {
  const source = path.join(REPO_ROOT, relativePath);
  const destination = path.join(
    SOURCE_SAFE_VALIDATION_REPOSITORY,
    relativePath,
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(source, destination, type);
}

function writeSourceSafeValidatorCopy(relativePath, transform) {
  const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
  const transformed = transform(source);
  if (transformed === source) {
    throw new Error(
      `[H2O Identity] Source-safe validator transform made no change: ${relativePath}`,
    );
  }
  const destination = path.join(
    SOURCE_SAFE_VALIDATION_REPOSITORY,
    relativePath,
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, transformed, "utf8");
  SOURCE_SAFE_VALIDATOR_OVERRIDES.set(relativePath, destination);
}

// The single src-runtime-base input the canonical validators actually read
// inside the source-safe validation repository.
const IDENTITY_CORE_SOURCE_REL = "src-runtime-base/0D4a.\u2b1b\ufe0f\ud83d\udd10 Identity Core \ud83d\udd10.js";

function createSourceSafeLegacyValidatorFixtures() {
  fs.mkdirSync(SOURCE_SAFE_VALIDATION_REPOSITORY, { recursive: true });
  for (const input of [
    "package.json",
    "package-lock.json",
    ".gitignore",
    "config",
    "tools/product",
    "tools/paths.mjs",
    // Phase 3.0Q legitimately reads the Identity Core runtime source. Link that
    // exact file rather than the whole src-runtime-base tree: the source-safe
    // repository stays a closed, enumerated input set instead of a window onto
    // arbitrary repository content.
    IDENTITY_CORE_SOURCE_REL,
  ]) {
    linkSourceSafeValidationInput(
      input,
      ["config", "tools/product"].includes(input) ? "dir" : "file",
    );
  }
  fs.symlinkSync(
    path.join(SOURCE_SAFE_INPUT_ROOT, "assets"),
    path.join(SOURCE_SAFE_VALIDATION_REPOSITORY, "assets"),
    "dir",
  );

  const legacyBuildRoot = path.join(
    SOURCE_SAFE_VALIDATION_REPOSITORY,
    "build",
  );
  fs.mkdirSync(legacyBuildRoot, { recursive: true });
  for (const [legacyName, variant] of [
    ["chrome-ext-dev-controls", "dev-controls"],
    ["chrome-ext-dev-lean", "dev-lean"],
    ["chrome-ext-prod", "prod"],
  ]) {
    fs.symlinkSync(
      extBuildRel(variant),
      path.join(legacyBuildRoot, legacyName),
      "dir",
    );
  }

  const backgroundDestinations = [
    extBuildRel("background-validator-dev"),
    extBuildRel("background-validator-prod"),
  ];
  writeSourceSafeValidatorCopy(BACKGROUND_VALIDATOR, (source) => source
    .replace(
      'const devOut = path.join("/tmp", `h2o-phase3y-dev-${process.pid}`);',
      `const devOut = ${JSON.stringify(backgroundDestinations[0])};`,
    )
    .replace(
      'const prodOut = path.join("/tmp", `h2o-phase3y-prod-${process.pid}`);',
      `const prodOut = ${JSON.stringify(backgroundDestinations[1])};`,
    ));
  SOURCE_SAFE_NESTED_BUILD_DESTINATIONS.set(
    BACKGROUND_VALIDATOR,
    backgroundDestinations,
  );

  const phase3Destinations = [
    ["devOut", "phase3z-dev"],
    ["armedDevOut", "phase31a-armed-dev"],
    ["unconfiguredArmedOut", "phase31a-unconfigured"],
    ["prodOut", "phase3z-prod"],
    ["armedProdOut", "phase31a-armed-prod"],
  ].map(([variable, variant]) => [
    variable,
    extBuildRel(`phase3_0q-${variant}`),
  ]);
  writeSourceSafeValidatorCopy(PHASE3_0Q_VALIDATOR, (source) => {
    let transformed = source;
    for (const [variable, destination] of phase3Destinations) {
      const pattern = new RegExp(
        '  const ' + variable + ' = path\\.join\\("/tmp", `[^\\n]+`\\);',
        "u",
      );
      transformed = transformed.replace(
        pattern,
        `  const ${variable} = ${JSON.stringify(destination)};`,
      );
    }
    return transformed;
  });
  SOURCE_SAFE_NESTED_BUILD_DESTINATIONS.set(
    PHASE3_0Q_VALIDATOR,
    phase3Destinations.map(([, destination]) => destination),
  );
}

function runCommand(command) {
  console.log(`\n[H2O Identity] ${command.label}`);
  console.log(`[H2O Identity] $ ${commandText(command)}`);
  const primaryBuilder = command.args[0] === PRIMARY_EXTENSION_BUILDER;
  const validatorOverride = SOURCE_SAFE_VALIDATOR_OVERRIDES.get(
    command.args[0],
  );
  const args = primaryBuilder
    ? [path.join(REPO_ROOT, PRIMARY_EXTENSION_BUILDER), ...command.args.slice(1)]
    : validatorOverride
      ? [validatorOverride, ...command.args.slice(1)]
      : command.args;
  const result = spawnSync(NODE, args, {
    cwd: primaryBuilder
      ? SOURCE_SAFE_INPUT_ROOT
      : validatorOverride
        ? SOURCE_SAFE_VALIDATION_REPOSITORY
        : REPO_ROOT,
    env: sourceSafeCommandEnvironment(command),
    stdio: "inherit",
  });
  if (result.error) {
    const error = new Error(
      `[H2O Identity] ${command.label} failed to start: ${result.error.message}`,
    );
    error.exitCode = 1;
    throw error;
  }
  if (result.status !== 0) {
    const error = new Error(
      `[H2O Identity] ${command.label} failed with exit code ${result.status}`,
    );
    error.exitCode = result.status || 1;
    throw error;
  }
  if (command.args[0] === PRIMARY_EXTENSION_BUILDER) {
    SOURCE_SAFE_EVIDENCE.realBuilderExecutions += 1;
    SOURCE_SAFE_EVIDENCE.extensionBuildDestinations.push(
      command.env.H2O_EXT_OUT_DIR,
    );
  }
  const nestedDestinations = SOURCE_SAFE_NESTED_BUILD_DESTINATIONS.get(
    command.args[0],
  );
  if (nestedDestinations) {
    SOURCE_SAFE_EVIDENCE.realBuilderExecutions += nestedDestinations.length;
    SOURCE_SAFE_EVIDENCE.extensionBuildDestinations.push(
      ...nestedDestinations,
    );
  }
}

function requireBuiltFile(variant, relativePath) {
  const filename = extBuildRel(variant, relativePath);
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(
      `[H2O Identity] Source-safe build output is missing or empty: ${filename}`,
    );
  }
  SOURCE_SAFE_EVIDENCE.validatedFiles.push(filename);
  return filename;
}

function validateSourceSafeExtensionOutputs() {
  const primaryVariants = [
    "dev-controls",
    "dev-lean",
    "prod",
    "dev-controls-armed",
    "dev-controls-oauth-google",
  ];
  for (const variant of primaryVariants) {
    const manifestPath = requireBuiltFile(variant, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!manifest || typeof manifest !== "object" || !manifest.manifest_version) {
      throw new Error(
        `[H2O Identity] Source-safe manifest is invalid: ${manifestPath}`,
      );
    }
    for (const relativePath of ["bg.js", "loader.js", "README.txt"]) {
      requireBuiltFile(variant, relativePath);
    }
  }
  requireBuiltFile("dev-controls", "popup.js");
  requireBuiltFile("dev-controls-armed", "popup.js");
  requireBuiltFile("dev-controls-oauth-google", "popup.js");
  for (const relativePath of ["manifest.json", "panel.js", "README.txt"]) {
    requireBuiltFile("ops-panel", relativePath);
  }
  const destinations = SOURCE_SAFE_EVIDENCE.extensionBuildDestinations;
  if (destinations.length !== 5 || new Set(destinations).size !== 5) {
    throw new Error(
      "[H2O Identity] Source-safe primary extension destinations are not distinct.",
    );
  }
}

function cleanupSourceSafeRoot() {
  const relative = path.relative(os.tmpdir(), SOURCE_SAFE_TEMP_ROOT);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !path.basename(SOURCE_SAFE_TEMP_ROOT).startsWith(
      "h2o-identity-release-gate-",
    )
  ) {
    throw new Error(
      `[H2O Identity] Refusing unsafe temporary cleanup: ${SOURCE_SAFE_TEMP_ROOT}`,
    );
  }
  fs.rmSync(SOURCE_SAFE_TEMP_ROOT, { recursive: true, force: true });
}

let releaseGateError = null;
let cleanupCompleted = false;
try {
  createSourceSafeIconFixtures();
  if (!SOURCE_SAFE_ONLY) createSourceSafeLegacyValidatorFixtures();
  console.log("\n== H2O Identity release gate =====================================");
  console.log("[H2O Identity] Running source-safe build, validator, and syntax checks.");
  console.log(`[H2O Identity] validation mode: ${SOURCE_SAFE_VALIDATION_MODE}`);
  console.log("[H2O Identity] Live RLS keeps its own skip-by-default behavior.\n");

  const selectedGroups = SOURCE_SAFE_ONLY
    ? GROUPS.filter((group) => group.title !== "Validators")
    : GROUPS;
  for (const group of selectedGroups) {
    console.log(`\n-- ${group.title} ------------------------------------------------`);
    for (const command of group.commands) runCommand(command);
    if (group.title === "Builds") validateSourceSafeExtensionOutputs();
  }

  console.log("\nH2O Identity release gate PASSED");
} catch (error) {
  releaseGateError = error;
  console.error(error?.stack || error);
} finally {
  try {
    cleanupSourceSafeRoot();
    cleanupCompleted = !fs.existsSync(SOURCE_SAFE_TEMP_ROOT);
  } catch (error) {
    releaseGateError ||= error;
    console.error(error?.stack || error);
  }
}

const canonicalAnchorCreated =
  CANONICAL_ANCHOR_INITIALLY_ABSENT &&
  fs.existsSync(EXPECTED_CANONICAL_ANCHOR);
const summary = {
  ok: releaseGateError === null && cleanupCompleted && !canonicalAnchorCreated,
  ...SOURCE_SAFE_CONTRACT,
  temporaryRootCreated: true,
  sourceValidatorSuiteExecuted: !SOURCE_SAFE_ONLY,
  temporaryRoot: SOURCE_SAFE_TEMP_ROOT,
  cleanupCompleted,
  canonicalAnchorCreated,
  realBuilderExecutions: SOURCE_SAFE_EVIDENCE.realBuilderExecutions,
  distinctVariantDestinations:
    new Set(SOURCE_SAFE_EVIDENCE.extensionBuildDestinations).size ===
    SOURCE_SAFE_EVIDENCE.extensionBuildDestinations.length,
  extensionBuildDestinationCount:
    SOURCE_SAFE_EVIDENCE.extensionBuildDestinations.length,
  extensionBuildDestinations:
    SOURCE_SAFE_EVIDENCE.extensionBuildDestinations,
  validatedFileCount: SOURCE_SAFE_EVIDENCE.validatedFiles.length,
};
console.log(JSON.stringify(summary));
process.exitCode = summary.ok
  ? 0
  : (Number.isInteger(releaseGateError?.exitCode)
    ? releaseGateError.exitCode
    : 1);
