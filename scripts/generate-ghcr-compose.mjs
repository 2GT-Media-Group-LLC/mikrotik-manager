#!/usr/bin/env node
/**
 * Generate docker-compose.ghcr.yml from docker-compose.yml.
 *
 * The two files describe the same system and differ only in where the images
 * come from. Maintaining both by hand meant every change had to be remembered
 * twice, and the one that got forgotten was the Quick Deploy path — the file the
 * README tells every new user to download, and the one no maintainer runs.
 *
 * That drift was not hypothetical. By the time it was reported (#121) the
 * published file had been missing the NetFlow port for weeks, along with all
 * five poller tunables and the Redis memory ceiling, each of which had been
 * added while closing a different issue.
 *
 * Substitution is textual rather than parse-and-reserialise so that comments
 * survive — the reasoning about Redis eviction is worth more than the two lines
 * of config it explains.
 *
 * Run `npm run compose:generate`. CI regenerates and fails if the result differs
 * from what is committed, so the two cannot diverge again.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'docker-compose.yml');
const TARGET = join(root, 'docker-compose.ghcr.yml');

const REGISTRY = 'ghcr.io/2gt-media-group-llc';

/** The only intentional differences between the two files. */
const IMAGE_SWAPS = [
  {
    service: 'nginx',
    build: '    build:\n      context: .\n      dockerfile: nginx/Dockerfile\n',
    image: `    image: ${REGISTRY}/mikrotik-manager-nginx:latest\n`,
  },
  {
    service: 'backend',
    build: '    build:\n      context: ./backend\n      dockerfile: Dockerfile\n',
    image: `    image: ${REGISTRY}/mikrotik-manager-backend:latest\n`,
  },
];

const BANNER = `
# ─────────────────────────────────────────────────────────────────────────────
# GENERATED FILE — DO NOT EDIT.
#
# Produced from docker-compose.yml by scripts/generate-ghcr-compose.mjs.
# Edit that file and run \`npm run compose:generate\`; CI fails if this one is
# out of date.
#
# Pre-built image deployment — no source code or build toolchain required.
# For development or building from source, use docker-compose.yml instead.
# ─────────────────────────────────────────────────────────────────────────────
`;

function generate(source) {
  let out = source;

  for (const swap of IMAGE_SWAPS) {
    if (!out.includes(swap.build)) {
      throw new Error(
        `Could not find the build block for "${swap.service}" in docker-compose.yml. ` +
        `The generator needs updating to match how that service is now defined.`
      );
    }
    out = out.replace(swap.build, swap.image);
  }

  // Banner goes after the version line so the file still parses from line one.
  const versionLine = out.match(/^version:.*\n/);
  if (!versionLine) throw new Error('docker-compose.yml has no version line to anchor the banner to');
  return out.replace(versionLine[0], versionLine[0] + BANNER);
}

const generated = generate(readFileSync(SOURCE, 'utf8'));
const check = process.argv.includes('--check');
const current = (() => { try { return readFileSync(TARGET, 'utf8'); } catch { return null; } })();

if (check) {
  if (current !== generated) {
    console.error(
      'docker-compose.ghcr.yml is out of date.\n' +
      'Run `npm run compose:generate` and commit the result.\n\n' +
      'This guard exists because the published deployment silently lost the NetFlow\n' +
      'port, the poller tunables and the Redis memory ceiling when they were added\n' +
      'to docker-compose.yml alone (#121).'
    );
    process.exit(1);
  }
  console.log('docker-compose.ghcr.yml is up to date');
} else {
  writeFileSync(TARGET, generated);
  console.log(current === generated ? 'docker-compose.ghcr.yml unchanged' : 'docker-compose.ghcr.yml regenerated');
}
