#!/usr/bin/env node
// Run after `npm ci --omit=dev`, in the Docker build stage only -- not part
// of the served app, just shrinks the image.
//
// gtfs-realtime-bindings declares protobufjs-cli (its own build-time
// .proto-to-JS code generator, the `pbjs`/`pbts` CLI tools) as a regular
// dependency rather than a devDependency, even though nothing in
// gtfs-realtime-bindings -- or anywhere else in this app -- ever invokes it
// at runtime (only the actual decode/encode library, `protobufjs` itself,
// is used, via GtfsRealtimeBindings.transit_realtime.FeedMessage.decode()
// in server.js). `npm ci --omit=dev` has no way to know that and installs
// it anyway, dragging in its own sizeable dependency tree -- jsdoc,
// markdown-it, @babel/*, escodegen, espree, underscore, bluebird, marked,
// glob, and everything *those* pull in too -- none of it ever imported by
// this app. That's roughly 60 packages / ~30MB of pure dead weight in the
// image (confirmed: deleting it and re-running the app's test suite and a
// real GTFS-RT decode against the live feed both still pass).
//
// Computed dynamically (via `npm ls --all --json`, the installed tree)
// rather than a hardcoded package list, so this self-adjusts if
// gtfs-realtime-bindings/protobufjs-cli's own dependency versions change --
// nothing here needs updating when dependabot bumps them.
import { execSync } from 'child_process';
import { rmSync } from 'fs';

const EXCLUDE_SUBTREE_OF = 'protobufjs-cli';

// --omit=dev matches the `npm ci --omit=dev` this runs after -- without it,
// `npm ls` reports devDependencies as "missing" (they were never installed)
// and exits non-zero even though nothing is actually wrong.
const tree = JSON.parse(execSync('npm ls --all --omit=dev --json', { maxBuffer: 1024 * 1024 * 50 }));

function collect(node, into, skip) {
  for (const [name, sub] of Object.entries(node.dependencies || {})) {
    if (name === skip) continue;
    into.add(name);
    collect(sub, into, skip);
  }
}

const allPackages = new Set();
collect(tree, allPackages, null);

const packagesStillNeeded = new Set();
collect(tree, packagesStillNeeded, EXCLUDE_SUBTREE_OF);

const removable = [...allPackages].filter((p) => !packagesStillNeeded.has(p));

for (const pkg of removable) {
  rmSync(`node_modules/${pkg}`, { recursive: true, force: true });
}

console.log(
  `Pruned ${removable.length} package(s) only reachable through ${EXCLUDE_SUBTREE_OF} (a build-time-only tool, never used at runtime).`,
);
